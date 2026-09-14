// Shape validation at the durable-JSON boundary, plus the read-time coercion
// that keeps older or model-dirtied records loadable. Ported from
// `dsh-agent-teams/src/state.ts` and the three predicates it borrows from
// `src/quality-gates.ts` (`hasValidQualityTaskFields`, `isReviewPolicy`,
// `normalizeBlankOptionalTaskFields`).
//
// These run on untrusted input — a file written by another process, or by a
// model that materialized optional parameters as `""`. Everything that later
// code assumes about a TeamState is established here.
import {
  CAPTAIN_KEY, DEFAULT_REVIEW_POLICY, FINDING_SEVERITIES, REVIEW_VERDICTS, TASK_KINDS,
} from './constants.js'
import { sanitizeKey } from './identifiers.js'


// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
/** Whether a parsed JSON value is a plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is an optional string. */
function isOptionalString(value) {
  return value === undefined || typeof value === 'string'
}

/** Whether a value is a finite timestamp/counter number. */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}


// ---------------------------------------------------------------------------
// Review policy, findings and recorded results
// ---------------------------------------------------------------------------
/** Validate a review-loop policy. */
export function isReviewPolicy(value) {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  const numbers = ['requirementsMinRounds', 'requirementsMaxRounds', 'codeMaxRounds', 'maxRepairAttempts']
  for (const key of numbers) {
    const item = value[key]
    if (item === undefined) continue
    if (!Number.isSafeInteger(item) || item < 1) return false
  }
  const min = value['requirementsMinRounds'] ?? DEFAULT_REVIEW_POLICY.requirementsMinRounds
  const max = value['requirementsMaxRounds'] ?? DEFAULT_REVIEW_POLICY.requirementsMaxRounds
  if (min > max) return false
  if (value['requiredReviewers'] !== undefined) {
    if (!Array.isArray(value['requiredReviewers'])) return false
    if (!value['requiredReviewers'].every(item => typeof item === 'string' && item.trim() !== '')) return false
  }
  const allowed = new Set([...numbers, 'requiredReviewers'])
  return Object.keys(value).every(key => allowed.has(key))
}

/** Validate one structured review finding. */
export function isReviewFinding(value) {
  if (!isRecord(value)) return false
  return nonemptyString(value['id'])
    && FINDING_SEVERITIES.includes(value['severity'])
    && nonemptyString(value['problem'])
    && nonemptyString(value['requiredFix'])
    && (value['file'] === undefined || nonemptyString(value['file']))
    && (value['line'] === undefined || isNonNegativeInteger(value['line']))
    && (value['resolved'] === undefined || typeof value['resolved'] === 'boolean')
}

/** Validate one acceptance-criterion result recorded at completion. */
export function isAcceptanceResult(value) {
  if (!isRecord(value)) return false
  return nonemptyString(value['criterion'])
    && (value['status'] === 'passed' || value['status'] === 'failed')
    && (value['evidence'] === undefined || typeof value['evidence'] === 'string')
}

/** Validate one verification-command result recorded at completion. */
export function isCommandResult(value) {
  if (!isRecord(value)) return false
  return nonemptyString(value['command'])
    && (value['status'] === 'passed' || value['status'] === 'failed')
    && (value['exitCode'] === undefined || Number.isSafeInteger(value['exitCode']))
    && (value['evidence'] === undefined || typeof value['evidence'] === 'string')
}


// ---------------------------------------------------------------------------
// "Blank means absent"
// ---------------------------------------------------------------------------
// Optional fields whose persisted values must be non-empty when present. Some
// models materialize optional tool parameters as "" instead of omitting them
// (GPT-5.6 sending `reviewedTaskId: ""`), which would otherwise be written to
// team.json and brick the whole team on reload.
const BLANK_SENSITIVE_STRING_FIELDS = ['objective', 'reviewedTaskId', 'sourceTaskId']
const BLANK_SENSITIVE_STRING_LIST_FIELDS = [
  'inScope', 'outOfScope', 'acceptance', 'verify', 'deliverables',
  'nonGoals', 'changedPaths', 'sourceFindingIds', 'coverageOf',
]

/**
 * Normalize blank optional task fields to omitted. Blank string scalars are
 * deleted; string lists drop blank entries, and a list that only held blanks is
 * omitted entirely. Non-blank values and every other field pass through
 * untouched, so durable-state validation stays strict.
 */
export function normalizeBlankOptionalTaskFields(task) {
  const next = { ...task }
  for (const key of BLANK_SENSITIVE_STRING_FIELDS) {
    if (typeof next[key] === 'string' && next[key].trim() === '') delete next[key]
  }
  for (const key of BLANK_SENSITIVE_STRING_LIST_FIELDS) {
    const value = next[key]
    if (!Array.isArray(value)) continue
    const kept = value.filter(item => !(typeof item === 'string' && item.trim() === ''))
    if (kept.length === value.length) continue
    if (kept.length === 0) delete next[key]
    else next[key] = kept
  }
  return next
}

/** Validate the quality-gate fields of a task record. */
export function hasValidQualityTaskFields(value) {
  if (value['kind'] !== undefined && !TASK_KINDS.includes(value['kind'])) return false
  if (value['verdict'] !== undefined && !REVIEW_VERDICTS.includes(value['verdict'])) return false
  if (value['round'] !== undefined && !(Number.isSafeInteger(value['round']) && value['round'] >= 1)) return false
  if (value['objective'] !== undefined && !nonemptyString(value['objective'])) return false
  if (value['reviewedTaskId'] !== undefined && !nonemptyString(value['reviewedTaskId'])) return false
  if (value['sourceTaskId'] !== undefined && !nonemptyString(value['sourceTaskId'])) return false
  if (value['reviewedAttempt'] !== undefined && !isNonNegativeInteger(value['reviewedAttempt'])) return false
  // The original repeats this list inline; one shared constant keeps the two
  // uses from drifting apart.
  for (const key of BLANK_SENSITIVE_STRING_LIST_FIELDS) {
    if (value[key] === undefined) continue
    if (!Array.isArray(value[key]) || !value[key].every(nonemptyString)) return false
  }
  if (value['findings'] !== undefined) {
    if (!Array.isArray(value['findings']) || !value['findings'].every(isReviewFinding)) return false
    const ids = value['findings'].map(finding => finding.id)
    if (new Set(ids).size !== ids.length) return false
  }
  if (value['acceptanceResults'] !== undefined) {
    if (!Array.isArray(value['acceptanceResults']) || !value['acceptanceResults'].every(isAcceptanceResult)) return false
  }
  if (value['commandsRun'] !== undefined) {
    if (!Array.isArray(value['commandsRun']) || !value['commandsRun'].every(isCommandResult)) return false
  }
  return true
}


// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
/** Validate one member record at the durable JSON boundary. */
export function isTeamMember(value) {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['role'])
    && isOptionalString(value['provider'])
    && isOptionalString(value['model'])
    && isOptionalString(value['reasoningEffort'])
    && isOptionalString(value['activeProvider'])
    && isOptionalString(value['activeModel'])
    && isOptionalString(value['executionPrompt'])
    && (value['fallback'] === undefined
      || (isRecord(value['fallback'])
        && typeof value['fallback']['provider'] === 'string'
        && typeof value['fallback']['model'] === 'string'))
    && (value['fallbackActive'] === undefined || typeof value['fallbackActive'] === 'boolean')
    && isFiniteNumber(value['joinedAt'])
    && (value['status'] === 'idle' || value['status'] === 'working' || value['status'] === 'removed')
}

/** Validate a profile snapshot record. */
export function isTeamProfileSnapshot(value) {
  return isRecord(value)
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['description'])
    && isOptionalString(value['protocol'])
    && isOptionalString(value['executionPrompt'])
    && (value['fallback'] === undefined
      || (isRecord(value['fallback'])
        && typeof value['fallback']['provider'] === 'string'
        && typeof value['fallback']['model'] === 'string'))
    && (value['taskPlanning'] === undefined || value['taskPlanning'] === 'captain' || value['taskPlanning'] === 'seed')
    && (value['reviewPolicy'] === undefined || isReviewPolicy(value['reviewPolicy']))
}

/**
 * Upgrade a legacy profile value to a snapshot, keeping only the four fields a
 * snapshot carries. `executionPrompt`, `fallback` and `reviewPolicy` are
 * dropped — the original does the same, so a profile read through this path
 * loses them.
 */
export function coerceProfileSnapshot(value) {
  if (typeof value === 'string') {
    const name = value.trim()
    return name === '' ? undefined : { name }
  }
  if (!isRecord(value)) return undefined
  if (!isTeamProfileSnapshot(value)) return undefined
  return {
    name: value.name.trim(),
    ...value.description === undefined ? {} : { description: value.description },
    ...value.protocol === undefined ? {} : { protocol: value.protocol },
    ...value.taskPlanning === undefined ? {} : { taskPlanning: value.taskPlanning },
  }
}

/** Validate one task record at the durable JSON boundary. */
export function isTeamTask(value) {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && isOptionalString(value['profileSeedId'])
    && (value['profileSeedId'] === undefined || value['profileSeedId'].trim() !== '')
    && typeof value['subject'] === 'string'
    && isOptionalString(value['description'])
    && (value['status'] === 'pending'
      || value['status'] === 'claimed'
      || value['status'] === 'in_progress'
      || value['status'] === 'completed'
      || value['status'] === 'failed'
      || value['status'] === 'cancelled')
    && isOptionalString(value['assignee'])
    && Array.isArray(value['dependencies'])
    && value['dependencies'].every(dependency => typeof dependency === 'string')
    && isOptionalString(value['output'])
    && (value['attempt'] === undefined || isNonNegativeInteger(value['attempt']))
    && isOptionalString(value['attemptId'])
    && isOptionalString(value['handoffId'])
    && (value['reassigning'] === undefined || typeof value['reassigning'] === 'boolean')
    && isFiniteNumber(value['createdAt'])
    && isFiniteNumber(value['updatedAt'])
    && hasValidQualityTaskFields(value)
}

/**
 * Validate the full team record before it can participate in authorization.
 *
 * Shape first, then the relationships the shape cannot express: member keys are
 * unique (by `sanitizeKey`, so two names that fold together collide), the
 * captain is not a member, and task ids are non-empty and unique.
 */
export function isTeamState(value, expectedId) {
  if (!isRecord(value)) return false
  const validShape = value['id'] === expectedId
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['description'])
    && (value['profile'] === undefined || isTeamProfileSnapshot(value['profile']))
    && typeof value['captainSessionId'] === 'string'
    && value['captainSessionId'] !== ''
    && isFiniteNumber(value['createdAt'])
    && Array.isArray(value['members'])
    && value['members'].every(isTeamMember)
    && Array.isArray(value['tasks'])
    && value['tasks'].every(isTeamTask)
    && isNonNegativeInteger(value['taskSeq'])
    && (value['phase'] === undefined || value['phase'] === 'staged' || value['phase'] === 'running')
    && (value['planReviewState'] === undefined
      || value['planReviewState'] === 'awaiting_review'
      || value['planReviewState'] === 'awaiting_feedback')
    && (value['approvedAt'] === undefined || isFiniteNumber(value['approvedAt']))
    && (value['halted'] === undefined || typeof value['halted'] === 'boolean')
    && (value['haltedAt'] === undefined || isFiniteNumber(value['haltedAt']))
    && (value['reviewPolicy'] === undefined || isReviewPolicy(value['reviewPolicy']))
    && (value['escalated'] === undefined || typeof value['escalated'] === 'boolean')
  if (!validShape) return false

  const memberIds = new Set()
  const memberKeys = new Set()
  // A staged team's members have not been spawned yet, so an empty id is legal
  // there and only there.
  const staged = value['phase'] === 'staged'
  for (const member of value['members']) {
    const key = sanitizeKey(member.name)
    if ((!staged && member.id === '') || key === CAPTAIN_KEY || memberKeys.has(key)) return false
    if (member.id !== '') {
      if (memberIds.has(member.id)) return false
      memberIds.add(member.id)
    }
    memberKeys.add(key)
  }
  const taskIds = new Set()
  for (const task of value['tasks']) {
    if (task.id === '' || taskIds.has(task.id)) return false
    taskIds.add(task.id)
  }
  return true
}

/** Validate a mailbox record so later rendering cannot crash on `{}` or `null`. */
export function isTeamMessage(value) {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['from'] === 'string'
    && typeof value['to'] === 'string'
    && typeof value['content'] === 'string'
    && isFiniteNumber(value['ts'])
    && (value['deliveryClaimedAt'] === undefined || isFiniteNumber(value['deliveryClaimedAt']))
    && (value['deliveredAt'] === undefined || isFiniteNumber(value['deliveredAt']))
    && (value['readAt'] === undefined || isFiniteNumber(value['readAt']))
}

/**
 * Upgrade a legacy on-disk record in place, then validate. Returns undefined
 * when the record cannot be made valid — callers treat that as "no team",
 * never as "empty team".
 */
export function coerceTeamState(value, expectedId) {
  if (!isRecord(value)) return undefined
  if (value['profile'] !== undefined && !isTeamProfileSnapshot(value['profile']) && typeof value['profile'] !== 'string') {
    const next = { ...value }
    delete next['profile']
    value = next
  } else if (typeof value['profile'] === 'string') {
    const upgraded = coerceProfileSnapshot(value['profile'])
    if (upgraded === undefined) {
      const next = { ...value }
      delete next['profile']
      value = next
    } else {
      value = { ...value, profile: upgraded }
    }
  }
  if (!isRecord(value) || !Array.isArray(value['tasks'])) {
    return isTeamState(value, expectedId) ? value : undefined
  }
  const tasks = value['tasks'].map(task => {
    if (!isRecord(task)) return task
    const cleaned = normalizeBlankOptionalTaskFields(task)
    if (cleaned['profileSeedId'] !== undefined
      && (typeof cleaned['profileSeedId'] !== 'string' || cleaned['profileSeedId'].trim() === '')) {
      const next = { ...cleaned }
      delete next['profileSeedId']
      return next
    }
    return cleaned
  })
  const coerced = { ...value, tasks }
  return isTeamState(coerced, expectedId) ? coerced : undefined
}
