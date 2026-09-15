// dsh-flow canvas — see src/canvas/canvas.js for the module map.
//
// The team inspector's quality sections: where the loop stands (K9), why the
// work is not deliverable (K10), and which requirements no task answers (K11).
//
// **Pure on purpose, and that is a design constraint rather than tidiness.**
// These are the parts of a panel that can actually be checked, and only if they
// load without a document: importing `core.js` would touch `window` at module
// scope and make the whole file unloadable under `node --test`. So this module
// imports `./html.js` and nothing else — the same reason `markdown.js` does —
// and `view.js`, which cannot be tested, only calls it.
import { escapeHtml } from './html.js'

/** Task display states → labels. Drives the chips on cards and in the panel. */
const TASK_STATE_LABEL = {
  open: '待办', running: '进行中', completed: '完成', failed: '失败', blocked: '阻塞', cancelled: '取消',
}

/** A task's display state as a reader-facing label. */
export function taskStateLabel(value) {
  return TASK_STATE_LABEL[value] ?? String(value ?? '')
}

/**
 * Where the team's quality loop stands.
 *
 * The sentence comes from the rules, not from here: `describeQualityLoop` owns
 * the precedence (a halt outranks a finished delivery; an escalation outranks
 * "blocked" because an escalated team is still running), and restating it in a
 * view would be a second answer to a question that has one.
 */
const LOOP_LABEL = {
  running: '进行中', deliverable: '可交付', blocked: '受阻', halted: '已停止', escalated: '已升级',
}

export function loopHtml(loop) {
  if (typeof loop?.summary !== 'string') return ''
  const state = LOOP_LABEL[loop.state] ?? String(loop.state ?? '')
  // A halt is not a variety of "busy": it is the state a reader has to act on
  // before anything else can happen, so it gets the halted chip rather than the
  // running one.
  const cls = loop.halted === true ? 'chip--halted' : loop.deliverable === true ? 'chip--idle' : 'chip--running'
  return `<section class="process"><div class="quality-line"><span class="quality-title">质量循环</span><span class="chip ${cls}">${escapeHtml(state)}</span></div><div class="quality-summary">${escapeHtml(loop.summary)}</div></section>`
}

/**
 * Why the work cannot be declared delivered yet.
 *
 * Every blocker is shown, one per line, because each names a specific task and
 * condition — that is what `canDeclareDelivery` exists to produce, and a count
 * would throw away the only part a reader can act on.
 */
export function deliveryHtml(delivery) {
  if (delivery === undefined) return ''
  const head = '<div class="quality-line"><span class="quality-title">交付闸门</span>'
  if (delivery.ok === true) return `<section class="process">${head}<span class="chip chip--idle">通过</span></div></section>`
  const blockers = Array.isArray(delivery.blockers) ? delivery.blockers : []
  const rows = blockers.map(text => `<div class="quality-blocker">${escapeHtml(text)}</div>`).join('')
  return `<section class="process">${head}<span class="chip chip--state-failed">${blockers.length} 项未过</span></div>${rows}</section>`
}

/**
 * One row per goal item: whether anything claims it, and what.
 *
 * A row with no tasks is the whole point of the matrix — an unclaimed
 * requirement that produced no row would be invisible, which is the failure
 * coverage exists to surface.
 *
 * The coverage vocabulary is not the task vocabulary (`missing` is not
 * `open`), so the statuses are translated onto the established chip colours
 * rather than shown raw: green means answered, red means it will not be,
 * amber means still moving, grey means nobody has it.
 */
const COVERAGE_STATUS = {
  passed: ['chip--state-completed', '已覆盖'],
  blocked: ['chip--state-failed', '受阻'],
  in_progress: ['chip--state-running', '进行中'],
  missing: ['chip--state-open', '无任务'],
}

export function coverageHtml(coverage) {
  if (!Array.isArray(coverage) || coverage.length === 0) return ''
  const rows = coverage.map(row => {
    const [cls, label] = COVERAGE_STATUS[row.status] ?? ['chip--state-open', String(row.status ?? '')]
    const ids = Array.isArray(row.task_ids) ? row.task_ids : []
    const tasks = ids.length === 0 ? '' : `<span class="coverage-tasks">${escapeHtml(ids.join(' '))}</span>`
    return `<div class="coverage-row"><span class="coverage-item">${escapeHtml(row.goal_item ?? '')}</span>${tasks}<span class="chip ${cls}">${escapeHtml(label)}</span></div>`
  }).join('')
  return `<section class="process"><div class="quality-line"><span class="quality-title">需求覆盖</span><span class="quality-count">${coverage.length} 项</span></div>${rows}</section>`
}

/** The three together, as one insertion point for the inspector. */
export function qualityPanelHtml(team) {
  return loopHtml(team?.loop) + deliveryHtml(team?.delivery) + coverageHtml(team?.coverage)
}
