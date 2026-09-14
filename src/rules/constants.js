// Vocabulary shared with dsh-agent-teams' durable format. These are an
// interoperability contract rather than a style choice: `sanitizeKey` decides
// inbox filenames, the transition table decides which state files we can read,
// and the review policy decides what "done" means. Ported from
// `dsh-agent-teams/src/types.ts` and `src/state.ts`.


// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------
/** Statuses in progression order. */
export const TASK_STATUS = Object.freeze([
  'pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled',
])

/** Statuses after which a task can no longer be claimed or worked on. */
export const TERMINAL_TASK_STATUSES = Object.freeze(['completed', 'failed', 'cancelled'])

/**
 * Allowed task status transitions, keyed by current status. Terminal statuses
 * have no outgoing transitions.
 *
 * `pending` is also reachable as a *bypass*: `invalidateTaskAttempt` pushes a
 * task straight back to `pending` to revoke a worker, and that edge is
 * deliberately absent here. The table is not the only source of truth — see
 * `invalidateTaskAttempt` in `attempts.js`.
 */
export const TASK_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['claimed', 'cancelled']),
  claimed: Object.freeze(['in_progress', 'failed', 'cancelled']),
  in_progress: Object.freeze(['completed', 'failed', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
})

/** Structured quality-gate kind. Absent or unknown values are treated as `work`. */
export const TASK_KINDS = Object.freeze([
  'requirements', 'implementation', 'verification', 'review', 'repair', 'integration', 'work',
])

/** Kinds that carry the structured quality contract (`work` does not). */
export const QUALITY_KINDS = Object.freeze([
  'requirements', 'implementation', 'verification', 'review', 'repair', 'integration',
])

/** Kinds that touch files, and therefore declare and are held to a scope. */
export const WRITE_KINDS = Object.freeze(['implementation', 'repair'])

/** Statuses in which a task still occupies its scope and can be worked on. */
export const OPEN_STATUSES = Object.freeze(['pending', 'claimed', 'in_progress'])

/** Conclusion of a review / requirements task. Only `pass` may complete those kinds. */
export const REVIEW_VERDICTS = Object.freeze(['pass', 'needs_revision', 'reject'])

/** Finding severity used by review / requirements output. */
export const FINDING_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'blocker'])

/** Member lifecycle status. */
export const MEMBER_STATUS = Object.freeze(['idle', 'working', 'removed'])

/** Mailbox key of the captain. */
export const CAPTAIN_KEY = 'captain'

/**
 * How long a delivery lease holds before the message becomes retryable. A
 * crashed live-delivery must not strand its message forever, and there is no
 * timer anywhere: expiry is evaluated lazily wherever unread mail is read.
 */
export const MAILBOX_DELIVERY_LEASE_MS = 60_000

/** Placeholder assignee meaning "the captain owns this task". */
export const CAPTAIN_ASSIGNEE = 'captain'

/**
 * Review-loop limits used when a team's profile states no policy. These are the
 * defaults a profile copies, not plugin configuration — a team's own
 * `reviewPolicy` field wins wherever it is present.
 */
export const DEFAULT_REVIEW_POLICY = Object.freeze({
  requirementsMinRounds: 1,
  requirementsMaxRounds: 4,
  codeMaxRounds: 3,
  maxRepairAttempts: 2,
})


// ---------------------------------------------------------------------------
// Transition rules
// ---------------------------------------------------------------------------
/**
 * Validate one task status transition.
 *
 * The TS original indexes the table directly and would throw on an unknown
 * status; TypeScript's union type is what made that safe. There is no type
 * system here, so the lookup is guarded and an unknown status reads as
 * "not allowed" — the one intentional divergence from the original, and it is
 * unreachable for callers that validated the record first (see `entities.js`).
 *
 * @param current - the task's current status.
 * @param next - the requested status.
 * @returns the error message, or undefined when the transition is allowed.
 */
export function transitionError(current, next) {
  if (current === next) return undefined
  const allowed = TASK_TRANSITIONS[current]
  if (allowed === undefined || !allowed.includes(next)) {
    return `task status cannot move from "${current}" to "${next}"`
  }
  return undefined
}
