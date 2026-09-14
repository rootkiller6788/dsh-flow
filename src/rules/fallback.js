// Model-route fallback, and the events a lost attempt leaves behind.
//
// Ported from agent-teams' `members.ts` (`isFallbackFailureCode`,
// `selectFallbackRoute`), plus the event recording that its snapshot model has
// nowhere to put. agent-teams performs the same recovery and writes only the
// restored field values, so afterwards a rolled-back attempt is indistinguishable
// from one that never ran. Here the recovery is two events, and the state the
// caller writes is the projection of them.
import { TERMINAL_TASK_STATUSES } from './constants.js'

/**
 * Provider failures worth re-routing for.
 *
 * Deliberately short: these are the codes where a *different route* plausibly
 * helps. A malformed request or a context-length error fails the same way
 * wherever it is sent, so switching routes would burn a second attempt to
 * learn nothing.
 */
export const FALLBACK_FAILURE_CODES = Object.freeze([
  'QUOTA', 'RATE_LIMIT', 'AUTH', 'MISSING_CREDENTIAL', 'NO_ADAPTER',
])

/** Whether a provider failure code justifies trying the configured fallback. */
export function isFallbackFailureCode(code) {
  return FALLBACK_FAILURE_CODES.includes(code)
}

/**
 * Decide whether a failed route should retry on its fallback.
 *
 * Pure, and deliberately total: every outcome is one of "retry on the fallback"
 * or "do not", with the selection returned either way so a caller never has to
 * reconstruct what the decision implied.
 *
 * @param current - the route that just failed.
 * @param fallback - the configured second choice, if any.
 * @param failureCode - the provider's failure code.
 * @param alreadySwitched - whether this member is already on its fallback.
 * @returns `{ retry, switched, selection }`.
 */
export function selectFallbackRoute(current, fallback, failureCode, alreadySwitched) {
  if (alreadySwitched || fallback === undefined || !isFallbackFailureCode(failureCode)) {
    return { retry: false, switched: alreadySwitched, selection: current }
  }
  return { retry: true, switched: true, selection: fallback }
}

/**
 * The events a failed dispatch leaves behind.
 *
 * Two distinct facts, in order: an attempt started and did not succeed, and the
 * work was taken back. The second is what agent-teams cannot express — its
 * recovery is a field write, so the rollback is invisible afterwards.
 *
 * `toStatus` defaults to `pending` because a lost attempt returns its task to
 * the pool. A caller revoking work on purpose (a reassignment, a removal) passes
 * its own target.
 *
 * @param task - the task whose attempt failed.
 * @param failure - `{ reason, code }`.
 * @param at - epoch milliseconds.
 * @param seq - the sequence number of the first event; the second follows it.
 * @returns the events to append, in order.
 */
export function attemptFailureEvents(task, failure, at, seq) {
  const events = []
  const attemptId = task.attemptId
  const common = {
    id: task.id,
    ...attemptId === undefined ? {} : { attemptId },
  }
  if (attemptId !== undefined) {
    events.push({
      type: 'task.attempt_failed',
      at,
      seq,
      ...common,
      reason: failure.reason,
      ...failure.code === undefined ? {} : { code: failure.code },
    })
  }
  // A task that already reached a terminal status is not rolled back: there is
  // no work in flight to take back, and a rollback event would claim otherwise.
  if (!TERMINAL_TASK_STATUSES.includes(task.status)) {
    events.push({
      type: 'task.rolled_back',
      at,
      seq: seq + events.length,
      id: task.id,
      toStatus: failure.toStatus ?? 'pending',
      reason: failure.reason,
      ...attemptId === undefined ? {} : { attemptId },
      ...failure.code === undefined ? {} : { code: failure.code },
    })
  }
  return events
}
