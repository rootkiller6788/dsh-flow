// Task attempt generation changes.
//
// Ported from `dsh-agent-teams/src/state.ts` (`activateTaskAttempt`,
// `beginTaskAttempt`, `cancelUnfinishedTask`, `invalidateTaskAttempt`). The
// originals call `randomUUID()` and `Date.now()` directly; here both are passed
// in, which is what makes a generation change reproducible in a test and keeps
// this module free of ambient state.
//
// These mutate the task they are given and return the capability id, matching
// the originals — a caller holds the live record and a copy would silently
// diverge from what it is about to write.
import { TERMINAL_TASK_STATUSES } from './constants.js'

/**
 * Activate a fresh generation for one owner.
 *
 * `handoffId` is cleared because an activated generation has started: the
 * handoff existed to serialize the gap before it.
 *
 * @param task - the live task record.
 * @param assignee - the member taking it.
 * @param options.attemptId - the capability id.
 * @param options.now - epoch milliseconds.
 * @returns the capability id.
 */
export function activateTaskAttempt(task, assignee, options) {
  const attemptId = options.attemptId
  task.status = 'claimed'
  task.assignee = assignee
  task.attemptId = attemptId
  task.handoffId = undefined
  task.reassigning = false
  task.output = undefined
  task.updatedAt = options.now
  return attemptId
}

/**
 * Start a new generation for one owner, incrementing the attempt counter.
 *
 * The counter is the only thing about an attempt that survives in the record;
 * what each attempt did lives in the event log.
 */
export function beginTaskAttempt(task, assignee, options) {
  task.attempt = (task.attempt ?? 0) + 1
  return activateTaskAttempt(task, assignee, options)
}

/** Cancel an unfinished task without returning it to the ready pool. */
export function cancelUnfinishedTask(task, output, now) {
  if (TERMINAL_TASK_STATUSES.includes(task.status)) return
  task.status = 'cancelled'
  task.attemptId = undefined
  task.handoffId = undefined
  task.reassigning = false
  if (output !== undefined) task.output = output
  task.updatedAt = now
}

/**
 * Revoke the current worker.
 *
 * Clearing the capability makes any in-flight update from the old owner stale.
 * A fresh `handoffId` is minted rather than cleared: quiescence is still
 * happening, and the id is what distinguishes that gap from a task nobody has
 * touched.
 *
 * The status moves straight to `pending`, which is a **bypass** — `pending` has
 * no incoming edge in `TASK_TRANSITIONS`. The table is not the only source of
 * truth for this field, and a caller validating transitions must know that.
 */
export function invalidateTaskAttempt(task, nextAssignee, reassigning, options) {
  task.attemptId = undefined
  task.handoffId = options.handoffId
  task.status = 'pending'
  task.assignee = nextAssignee
  task.reassigning = reassigning
  task.output = undefined
  task.updatedAt = options.now
}
