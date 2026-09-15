// The append-only team event log: the schema our own store is built on.
//
// This layer has no counterpart to port. agent-teams keeps a mutable snapshot
// and overwrites it, so a rollback, a failed attempt, or a status that briefly
// moved and moved back all leave no trace. Here every state change is a fact
// that stays, and `project.js` derives the current state from the facts.
//
// The vocabulary is deliberately close to agent-teams' own mutation sites, so
// the two models describe the same work — the difference is that one keeps the
// history and the other does not.
import { TASK_STATUS } from './constants.js'

/**
 * Every event type, grouped by the entity it concerns.
 *
 * `task.attempt_failed` and `task.rolled_back` are the two the snapshot model
 * cannot express: the first records that an attempt was made and failed, the
 * second that work was taken back from a worker. In agent-teams both collapse
 * into "the task is pending and `attempt` is a slightly larger number".
 */
export const TEAM_EVENT_TYPES = Object.freeze([
  'team.created',
  'team.phase_changed',
  'team.halted',
  'team.resumed',
  'team.archived',
  'member.added',
  'member.updated',
  'member.removed',
  'task.created',
  'task.transitioned',
  'task.attempt_started',
  'task.attempt_failed',
  'task.rolled_back',
  'task.completed',
  'message.sent',
  'message.delivered',
  'message.acked',
])

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = value => typeof value === 'number' && Number.isFinite(value)
const isText = value => typeof value === 'string' && value !== ''
const isAnyString = value => typeof value === 'string'

/**
 * Required and optional payload fields per event type.
 *
 * `required` is what must be present for the event to mean anything;
 * `optional` documents the rest so a reader knows what it may rely on. A field
 * list per type beats a shape heuristic: an event is only useful if the fields
 * its own reducer reads are the ones it carries.
 */
const PAYLOAD_SCHEMA = Object.freeze({
  'team.created': { required: { name: isText, captainSessionId: isText }, optional: ['description', 'profile', 'cwd', 'phase'] },
  'team.phase_changed': { required: { from: isText, to: isText }, optional: [] },
  'team.halted': { required: {}, optional: ['reason'] },
  'team.resumed': { required: { reason: isText }, optional: [] },
  'team.archived': { required: {}, optional: [] },
  'member.added': { required: { member: isRecord }, optional: [] },
  'member.updated': { required: { id: isText, patch: isRecord }, optional: [] },
  'member.removed': { required: { id: isText }, optional: ['reason'] },
  'task.created': { required: { task: isRecord }, optional: [] },
  'task.transitioned': { required: { id: isText, from: isText, to: isText }, optional: ['at'] },
  'task.attempt_started': { required: { id: isText, attemptId: isText }, optional: ['attempt', 'assignee'] },
  'task.attempt_failed': { required: { id: isText, attemptId: isText, reason: isText }, optional: ['code'] },
  // `attempt`, `assignee` and `restoredAttemptId` are here because a rollback
  // *restores* them: an attempt that failed on a recovered generation puts the
  // previous generation back, and a log that did not carry the restored values
  // would leave the projection disagreeing with the record the runtime holds —
  // or, worse, would make the restored capability look like a new generation to
  // a reader diffing the two. `assignee` is the one nullable field in the
  // schema: `null` means the task returned to the unassigned pool, which an
  // absent key cannot say, since absent means "this event is not speaking to
  // the assignee at all".
  'task.rolled_back': {
    required: { id: isText, toStatus: isText, reason: isText },
    optional: ['attemptId', 'restoredAttemptId', 'code', 'attempt', 'assignee'],
  },
  'task.completed': { required: { id: isText }, optional: ['verdict', 'acceptanceResults', 'changedPaths', 'output'] },
  'message.sent': { required: { from: isText, to: isText, content: isAnyString }, optional: ['id', 'ts'] },
  'message.delivered': { required: { id: isText }, optional: ['deliveredAt'] },
  'message.acked': { required: { id: isText }, optional: ['readAt'] },
})

/** Payload fields a given event type must carry. */
export function requiredEventFields(type) {
  const schema = PAYLOAD_SCHEMA[type]
  return schema === undefined ? [] : Object.keys(schema.required)
}

/** Payload fields a given event type may carry beyond the required ones. */
export function optionalEventFields(type) {
  return PAYLOAD_SCHEMA[type]?.optional ?? []
}

/**
 * Validate one event record.
 *
 * Checks the envelope (`type`, `at`, `seq`) and then every field the type
 * declares as required, so a truncated or hand-edited line is rejected at the
 * boundary rather than surfacing as a wrong projection much later.
 *
 * @param value - the parsed record.
 * @returns whether the record is a usable event.
 */
export function isTeamEvent(value) {
  if (!isRecord(value)) return false
  if (!TEAM_EVENT_TYPES.includes(value['type'])) return false
  if (!isNumber(value['at'])) return false
  if (!Number.isSafeInteger(value['seq']) || value['seq'] < 0) return false
  const schema = PAYLOAD_SCHEMA[value['type']]
  for (const [field, check] of Object.entries(schema.required)) {
    if (!check(value[field])) return false
  }
  if (value['type'] === 'task.rolled_back' && !TASK_STATUS.includes(value['toStatus'])) return false
  return true
}

/**
 * Build one event with the envelope filled in.
 *
 * `at` and `seq` are supplied rather than read from a clock or counter, which
 * keeps event construction a pure function and makes a log reproducible in a
 * test. The caller owns ordering.
 *
 * @param type - one of `TEAM_EVENT_TYPES`.
 * @param payload - the type's payload fields.
 * @param at - epoch milliseconds.
 * @param seq - position in the log, from zero.
 * @returns the event record.
 */
export function teamEvent(type, payload, at, seq) {
  if (!TEAM_EVENT_TYPES.includes(type)) throw new Error(`unknown team event type "${String(type)}"`)
  const event = { type, at, seq, ...payload }
  if (!isTeamEvent(event)) throw new Error(`incomplete payload for team event "${type}"`)
  return event
}

/**
 * Parse a JSONL event log, reporting each unusable line instead of failing.
 *
 * Mirrors the mailbox reader: a torn line must not make the whole team
 * unreadable, and it must not vanish silently either. `seq` is not trusted from
 * the file — position in the log is the log's own business — so a rewritten or
 * reordered file cannot forge an ordering.
 *
 * @param raw - the log's whole text.
 * @param onMalformedLine - called with the 1-based line number and the reason.
 * @returns the events, in file order.
 */
export function parseEventLog(raw, onMalformedLine) {
  const events = []
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].charCodeAt(0) === 0xFEFF ? lines[index].slice(1) : lines[index]
    if (line.trim() === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      onMalformedLine?.(index + 1, new Error('invalid JSON'))
      continue
    }
    if (!isTeamEvent(value)) {
      onMalformedLine?.(index + 1, new Error('invalid event shape'))
      continue
    }
    if (value.seq !== events.length) {
      onMalformedLine?.(index + 1, new Error(`expected seq ${events.length}, found ${value.seq}`))
      continue
    }
    events.push(value)
  }
  return events
}

/** Serialize events as a JSONL log body, each line terminated. */
export function serializeEventLog(events) {
  return events.map(event => `${JSON.stringify(event)}\n`).join('')
}
