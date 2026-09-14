// Delivery gate. Ported from `dsh-agent-teams/src/quality-gates.ts`
// (`canDeclareDelivery`, `resumeTeamState`).
//
// The team-level counterpart to `evaluateQualityCompletion`: that one asks
// whether a single task may complete, this one asks whether the whole team may
// be called done. The original computes the answer and never persists it, so
// this is a rule to re-run rather than a field to read.
import { OPEN_STATUSES } from './constants.js'
import { isQualityKind, taskKindOf } from './gates.js'
import { classifyChangedPath } from './paths.js'

/**
 * Whether the team's work can be declared delivered, and if not, why not.
 *
 * @param team - the team record.
 * @returns `{ ok, blockers }`, where each blocker names a specific task and
 *   condition rather than a generic "not finished".
 */
export function canDeclareDelivery(team) {
  const blockers = []
  const quality = team.tasks.filter(item => isQualityKind(taskKindOf(item)))
  const implementations = quality.filter(item => taskKindOf(item) === 'implementation' || taskKindOf(item) === 'repair')
  const reviews = quality.filter(item => taskKindOf(item) === 'review')

  for (const item of quality) {
    const kind = taskKindOf(item)
    if (item.status === 'completed') {
      if ((kind === 'review' || kind === 'requirements') && item.verdict !== 'pass') {
        blockers.push(`${item.id} completed without verdict=pass`)
      }
      continue
    }
    if (item.status === 'failed') {
      // A failure is only acceptable when something is already scheduled to
      // address it — and what counts as "addressing it" differs per kind.
      const repaired = kind === 'review'
        ? quality.some(candidate => (
          taskKindOf(candidate) === 'repair'
          && candidate.sourceTaskId === (item.reviewedTaskId ?? item.sourceTaskId)
          && (candidate.status === 'pending' || candidate.status === 'claimed'
            || candidate.status === 'in_progress' || candidate.status === 'completed')
        ))
        : kind === 'requirements'
          ? quality.some(candidate => (
            taskKindOf(candidate) === 'requirements'
            && (candidate.round ?? 1) > (item.round ?? 1)
          ))
          : quality.some(candidate => (
            taskKindOf(candidate) === 'repair' && candidate.sourceTaskId === item.id
          ))
      if (!repaired) blockers.push(`${item.id} failed without a follow-up repair`)
      continue
    }
    if (item.status === 'cancelled') continue
    blockers.push(`${item.id} (${kind}) is not completed`)
  }

  if (implementations.some(item => item.status === 'completed')
    && !reviews.some(item => item.status === 'completed' && item.verdict === 'pass')) {
    // Only report this once: if a review blocker is already listed, adding a
    // second line for the same missing review says nothing new.
    if (!blockers.some(item => item.includes('review'))) {
      blockers.push('completed implementation has no passing review')
    }
  }

  for (const item of implementations) {
    for (const path of item.changedPaths ?? []) {
      if (classifyChangedPath(path, item.inScope ?? [], item.outOfScope ?? []) !== 'in_scope') {
        blockers.push(`${item.id} has unaudited path ${path}`)
      }
    }
  }

  return { ok: blockers.length === 0, blockers }
}

/**
 * Clear a human halt, given a reason.
 *
 * @param team - the team record.
 * @param reason - why the team is being resumed; must be non-empty, because the
 *   reason is what the next captain turn reads.
 * @returns `{ ok: false, status: 'rejected', error }`, or
 *   `{ ok: true, status: 'already_running' | 'resumed', team }`.
 */
export function resumeTeamState(team, reason) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { ok: false, status: 'rejected', error: 'resume requires a non-empty reason' }
  }
  if (team.halted !== true) {
    return { ok: true, status: 'already_running', team }
  }
  return {
    ok: true,
    status: 'resumed',
    team: { ...team, halted: false, haltedAt: undefined },
  }
}


/**
 * One sentence on where the team stands, plus the state that produced it.
 *
 * Precedence matters and is the point of this function: a halt outranks a
 * finished delivery (a halted team must be resumed before anything else), and
 * an escalation outranks "blocked" because an escalated team is *still
 * running* — reporting it as blocked would invite the reader to wait for work
 * that will never come.
 *
 * @param team - the team record.
 * @returns `{ state, halted, escalated, deliverable, summary }`.
 */
export function describeQualityLoop(team) {
  const delivery = canDeclareDelivery(team)
  if (team.halted === true) {
    return {
      state: 'halted',
      halted: true,
      escalated: team.escalated === true,
      deliverable: false,
      summary: 'Team is halted. Call agent_teams_resume with a reason before creating more work.',
    }
  }
  if (delivery.ok) {
    return {
      state: 'deliverable',
      halted: false,
      escalated: team.escalated === true,
      deliverable: true,
      summary: 'All required quality gates passed. The captain may report delivery.',
    }
  }
  if (team.escalated === true) {
    return {
      state: 'escalated',
      halted: false,
      escalated: true,
      deliverable: false,
      summary: 'Automatic review/repair loop hit its ceiling. The team is still running; do not treat this as halt. Escalate to the user instead of inventing another needs_revision cycle.',
    }
  }
  const open = team.tasks.some(item => OPEN_STATUSES.includes(item.status))
  return {
    state: open ? 'running' : 'blocked',
    halted: false,
    escalated: false,
    deliverable: false,
    summary: open
      ? 'Work remains on the shared task list; wait for the scheduler or complete owned tasks.'
      : `Delivery is blocked: ${delivery.blockers.join('; ') || 'unresolved quality gates'}.`,
  }
}
