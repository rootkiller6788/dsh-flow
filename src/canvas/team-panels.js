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

/**
 * A wall-clock stamp for a timeline row.
 *
 * Local time, seconds resolution, formatted by hand rather than through
 * `toLocaleTimeString`: a timeline is read next to other timestamps, and a
 * locale that reorders or pads them differently would make two rows of the same
 * list look like they came from different systems.
 */
export function clockOf(at) {
  if (!Number.isFinite(at)) return ''
  const date = new Date(at)
  const pad = value => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const ATTEMPT_OUTCOME = {
  started: ['chip--state-running', '未收尾'],
  failed: ['chip--state-failed', '失败'],
}

/**
 * The staged-plan editor — the only place the canvas writes to a team.
 *
 * A staged team is the one moment a plan is an *artifact* rather than a record
 * of what is happening: nothing has been dispatched, so editing it cannot
 * contradict anything already true. Once the team is running the same controls
 * would be rewriting the task list underneath members holding attempts, which is
 * why this renders only while the team is staged and only for a source that can
 * be appended to — an imported `.agent-teams/` team is somebody else's record.
 *
 * The buttons carry their own `name`/`value`, so the browser reports *which one
 * was pressed* as part of the form data. That removes the need for the panel to
 * track a pending intent in `state`, which matters because `render()` replaces
 * the whole document every frame and any panel-local state would be lost.
 */
export function stagedPlanHtml(team) {
  if (team?.phase !== 'staged' || team?.writable !== true) return ''
  const teamId = escapeHtml(team.teamId ?? '')
  const drop = (name, value, label) => `<button type="submit" class="plan-drop" name="${name}" value="${escapeHtml(value)}" title="${label}">移除</button>`

  const members = (team.members ?? []).map(member => `<div class="plan-row"><span class="plan-name">${escapeHtml(member.name)}</span>${member.role ? `<span class="plan-role">${escapeHtml(member.role)}</span>` : ''}${drop('removeMember', member.name, '从计划中移除')}</div>`).join('')
  const tasks = (team.tasks ?? []).map(task => {
    const deps = Array.isArray(task.dependencies) && task.dependencies.length > 0
      ? `<span class="plan-deps">依赖 ${escapeHtml(task.dependencies.join(' '))}</span>`
      : ''
    return `<div class="plan-row"><span class="plan-id">${escapeHtml(task.id ?? '')}</span><span class="plan-subject">${escapeHtml(task.subject ?? task.id ?? '')}</span>${deps}${drop('removeTask', task.id ?? '', '从计划中移除')}</div>`
  }).join('')

  // A team with no members or no tasks says so rather than showing an empty
  // group: an approved plan with an empty roster starts nothing and looks fine.
  const memberGroup = (team.members ?? []).length === 0
    ? '<div class="plan-empty">还没有成员。批准之前至少要有一个。</div>'
    : `<div class="plan-group">成员</div>${members}`
  const taskGroup = (team.tasks ?? []).length === 0
    ? '<div class="plan-empty">还没有任务。</div>'
    : `<div class="plan-group">任务</div>${tasks}`

  return `<form class="process plan-editor" data-form="plan-edit" data-team="${teamId}"><div class="quality-line"><span class="quality-title">待审计划</span><span class="quality-count">可编辑</span></div>${memberGroup}<div class="plan-add"><input name="memberName" placeholder="新成员名字" aria-label="新成员名字"><input name="memberRole" placeholder="角色（可选）" aria-label="新成员角色"><button type="submit" name="intent" value="addMember">添加成员</button></div>${taskGroup}<div class="plan-add"><input name="taskSubject" placeholder="新任务标题" aria-label="新任务标题"><button type="submit" name="intent" value="addTask">添加任务</button></div><div class="plan-foot"><button type="submit" class="primary" name="intent" value="approve">批准并启动</button></div></form>`
}

const WARNING_KIND = {
  log: '事件日志',
  mailbox: '收件箱',
  team: '团队记录',
}

/**
 * The import report: which lines could not be read, and why.
 *
 * Shown rather than logged alone. A damaged line means part of the record is
 * missing — a message nobody will ever read, or an event the team did that its
 * history does not contain — and the reader looking at the team is the only one
 * who can act on it. A host console nobody is watching is not a report.
 *
 * Every line is listed, not counted: the line number is what makes a damaged
 * file fixable, and a count throws away the only part a reader can use.
 */
export function warningsHtml(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return ''
  const rows = warnings.map(entry => {
    const kind = WARNING_KIND[entry.kind] ?? String(entry.kind ?? '')
    const where = entry.member === undefined || entry.member === '' ? '' : ` · ${escapeHtml(entry.member)}`
    // A finding against a whole record has no line, and inventing one would send
    // the reader looking for a line that is not the problem.
    const line = Number.isInteger(entry.line) ? `<span class="warning-line">第 ${escapeHtml(entry.line)} 行</span>` : ''
    return `<div class="warning-row"><span class="warning-where">${escapeHtml(kind)}${where}</span>${line}<span class="warning-why">${escapeHtml(entry.reason ?? '')}</span></div>`
  }).join('')
  return `<section class="process"><div class="quality-line"><span class="quality-title">数据损坏</span><span class="chip chip--state-failed">${warnings.length} 处</span></div><div class="quality-summary">这些行读不出来，已被跳过。上面看到的内容里，缺的就是它们。</div>${rows}</section>`
}

/**
 * One task's attempt timeline.
 *
 * The reason this can exist at all: the log records both that an attempt failed
 * *and* that the work was taken back, so a reader sees a task was tried three
 * times and what became of each try. agent-teams keeps only a monotonic counter,
 * so there a rolled-back task is indistinguishable from one nobody attempted —
 * which is what makes this a capability rather than a decoration.
 */
export function attemptTimelineHtml(history) {
  if (history === undefined) return ''
  const attempts = Array.isArray(history.attempts) ? history.attempts : []
  const rollbacks = Array.isArray(history.rollbacks) ? history.rollbacks : []
  const title = `尝试记录 · ${escapeHtml(history.subject ?? history.taskId ?? '')}`
  const head = `<div class="quality-line"><span class="quality-title">${title}</span><span class="quality-count">${attempts.length} 次</span></div>`
  if (attempts.length === 0 && rollbacks.length === 0) {
    // Said rather than left blank: a task with no attempts is a fact about the
    // team's progress, and an empty box reads like a rendering failure.
    return `<section class="process">${head}<div class="quality-summary">还没有任何尝试。</div></section>`
  }

  const rows = [
    ...attempts.map((entry, index) => ({
      at: entry.at,
      html: (() => {
        const [cls, label] = ATTEMPT_OUTCOME[entry.outcome] ?? ['chip--state-open', String(entry.outcome ?? '')]
        const who = entry.assignee === undefined || entry.assignee === '' ? '' : `<span class="attempt-who">${escapeHtml(entry.assignee)}</span>`
        const code = entry.code === undefined ? '' : `<span class="attempt-code">${escapeHtml(entry.code)}</span>`
        const why = entry.reason === undefined ? '' : `<div class="attempt-why">${escapeHtml(entry.reason)}</div>`
        return `<div class="attempt-row"><span class="attempt-seq">#${index + 1}</span><span class="attempt-at">${escapeHtml(clockOf(entry.at))}</span>${who}${code}<span class="chip ${cls}">${escapeHtml(label)}</span></div>${why}`
      })(),
    })),
    ...rollbacks.map(entry => ({
      at: entry.at,
      html: `<div class="attempt-row attempt-row--rollback"><span class="attempt-at">${escapeHtml(clockOf(entry.at))}</span><span class="attempt-why">回滚 → ${escapeHtml(entry.toStatus ?? '')}${entry.reason === undefined ? '' : ` · ${escapeHtml(entry.reason)}`}</span></div>`,
    })),
    // Merged in time order rather than attempts-then-rollbacks: the reader is
    // reconstructing what happened, and two lists would make them do the merge
    // in their head.
  ].sort((left, right) => (Number.isFinite(left.at) ? left.at : 0) - (Number.isFinite(right.at) ? right.at : 0))

  return `<section class="process">${head}${rows.map(row => row.html).join('')}</section>`
}
