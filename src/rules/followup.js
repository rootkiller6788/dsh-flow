// Review/repair loop planning. Ported from `dsh-agent-teams/src/quality-gates.ts`
// (`planQualityFollowUp` and its helpers).
//
// When a review comes back `needs_revision`, the loop either schedules the next
// round or declares itself escalated. Deciding that here — rather than inside a
// scheduler — is what lets a reader answer "how many rounds are left, and why"
// without running anything.
import {
  CAPTAIN_ASSIGNEE, DEFAULT_REVIEW_ACCEPTANCE, DEFAULT_REVIEW_OBJECTIVE,
  GATE_TEST_CONTRACT, OPEN_FOLLOW_UP_STATUSES,
} from './constants.js'
import { resolveReviewPolicy, taskKindOf } from './gates.js'

function nonemptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Whether a value is the *wording of a rejection test* rather than real content. */
export function looksLikeGateTestContract(value) {
  return typeof value === 'string' && GATE_TEST_CONTRACT.test(value)
}

/** Keep a review objective, replacing missing or gate-echoing text with the default. */
export function sanitizeReviewObjective(value, fallback = DEFAULT_REVIEW_OBJECTIVE) {
  if (!nonemptyString(value) || looksLikeGateTestContract(value)) return fallback
  return value.trim()
}

/** Keep acceptance criteria, replacing an empty or gate-echoing list with the default. */
export function sanitizeReviewAcceptance(values) {
  const cleaned = (values ?? [])
    .map(item => item.trim())
    .filter(item => item !== '' && !looksLikeGateTestContract(item))
  return cleaned.length > 0 ? cleaned : [...DEFAULT_REVIEW_ACCEPTANCE]
}

/** Findings still needing a fix. */
export function unresolvedFindings(task) {
  return (task.findings ?? []).filter(finding => finding.resolved !== true)
}

/**
 * Identity of a finding set, order-independent. Two repairs address the same
 * work only if they name the same findings, so this is what makes "have I
 * already planned this repair" answerable.
 */
export function findingKey(ids) {
  return [...ids].sort().join(',')
}

/**
 * Who should take a planned task: the preferred member when they exist and are
 * still present, otherwise any member that is not removed and not the captain.
 * Returns undefined when the team has nobody left to assign to.
 */
export function schedulableAssignee(preferred, team, forbidden) {
  if (preferred !== undefined && preferred !== CAPTAIN_ASSIGNEE && preferred !== forbidden) {
    const live = team.members.find(member => member.name === preferred && member.status !== 'removed')
    if (live !== undefined) return live.name
  }
  return team.members.find(member => (
    member.status !== 'removed'
    && member.name !== CAPTAIN_ASSIGNEE
    && member.name !== forbidden
  ))?.name
}

/** How many repairs have already been planned for this exact finding set. */
export function countRepairAttempts(team, sourceTaskId, findingIds) {
  const key = findingKey(findingIds)
  return team.tasks.filter(item => (
    taskKindOf(item) === 'repair'
    && item.sourceTaskId === sourceTaskId
    && findingKey(item.sourceFindingIds ?? []) === key
  )).length
}

/** Whether a repair for this exact finding set is already scheduled or running. */
export function hasOpenFollowUp(team, sourceTaskId, findingIds) {
  const key = findingKey(findingIds)
  return team.tasks.some(item => (
    taskKindOf(item) === 'repair'
    && item.sourceTaskId === sourceTaskId
    && findingKey(item.sourceFindingIds ?? []) === key
    && OPEN_FOLLOW_UP_STATUSES.includes(item.status)
  ))
}

/**
 * Plan what follows a closed review or requirements task.
 *
 * Three ways this stops rather than loops: a `reject` escalates immediately, the
 * round ceiling escalates, and reaching `maxRepairAttempts` for the same finding
 * set escalates. An escalation is a decision to hand back to the user, not a
 * failure — which is why it is a state and not an error.
 *
 * @param team - the team record.
 * @param closed - the review or requirements task that just closed.
 * @returns `{ created, tasks }`, plus `{ escalated: true, status: 'escalated' }`
 *   when the loop has hit its ceiling. Both task lists hold the same planned
 *   tasks; `tasks` is what the caller wires into the graph.
 */
export function planQualityFollowUp(team, closed) {
  const empty = { created: [], tasks: [] }
  const kind = taskKindOf(closed)
  if ((kind !== 'review' && kind !== 'requirements') || closed.status !== 'failed') return empty
  if (closed.verdict === 'reject') return { ...empty, escalated: true, status: 'escalated' }
  if (closed.verdict !== 'needs_revision') return empty

  const policy = resolveReviewPolicy(team.reviewPolicy)
  const currentRound = closed.round ?? 1
  const nextRound = currentRound + 1
  const maxRounds = kind === 'requirements' ? policy.requirementsMaxRounds : policy.codeMaxRounds
  if (nextRound > maxRounds) return { ...empty, escalated: true, status: 'escalated' }

  if (kind === 'requirements') {
    const next = {
      kind: 'requirements',
      subject: `requirements-round-${nextRound}`,
      assignee: closed.assignee,
      dependencies: [],
      round: nextRound,
      objective: sanitizeReviewObjective(closed.objective, 'Converge remaining open questions'),
      acceptance: sanitizeReviewAcceptance(unresolvedFindings(closed).map(finding => finding.requiredFix)),
    }
    return { created: [next], tasks: [next] }
  }

  const sourceId = closed.reviewedTaskId ?? closed.sourceTaskId
  if (sourceId === undefined) return empty
  const source = team.tasks.find(item => item.id === sourceId)
  const findings = unresolvedFindings(closed)
  const findingIds = findings.map(finding => finding.id)
  // Already planned: planning again would duplicate the work rather than
  // advance it, so the loop reports nothing and lets the existing task run.
  if (hasOpenFollowUp(team, sourceId, findingIds)) return empty
  if (countRepairAttempts(team, sourceId, findingIds) >= policy.maxRepairAttempts) {
    return { ...empty, escalated: true, status: 'escalated' }
  }
  const files = findings.map(finding => finding.file).filter(file => nonemptyString(file))
  const implementer = schedulableAssignee(source?.assignee, team)
  const repair = {
    id: `repair-round-${nextRound}`,
    kind: 'repair',
    subject: `repair-round-${nextRound}`,
    assignee: implementer,
    dependencies: [sourceId],
    round: nextRound,
    objective: source?.objective ?? closed.objective ?? `Fix findings from ${sourceId}`,
    inScope: files.length > 0 ? files : source?.inScope,
    outOfScope: source?.outOfScope,
    verify: source?.verify,
    acceptance: findings.map(finding => finding.requiredFix),
    sourceTaskId: sourceId,
    sourceFindingIds: findingIds,
  }
  const reviewer = schedulableAssignee(
    closed.assignee !== implementer ? closed.assignee : undefined,
    team,
    implementer,
  )
  const review = {
    id: `review-round-${nextRound}`,
    kind: 'review',
    subject: `review-round-${nextRound}`,
    assignee: reviewer,
    dependencies: [repair.id ?? `repair-round-${nextRound}`],
    round: nextRound,
    objective: sanitizeReviewObjective(closed.objective, DEFAULT_REVIEW_OBJECTIVE),
    acceptance: sanitizeReviewAcceptance(closed.acceptance),
    reviewedTaskId: repair.id,
  }
  return { created: [repair, review], tasks: [repair, review] }
}
