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

/** Acceptance criteria a review task falls back to when it declared none. */
export const DEFAULT_REVIEW_ACCEPTANCE = Object.freeze([
  'The latest implementation meets the user goal',
  'No unresolved blocker or high findings',
])

/** Objective a review task falls back to when it declared none. */
export const DEFAULT_REVIEW_OBJECTIVE = 'Review whether the latest implementation satisfies the user goal'

/**
 * Text that reads as the *test* of a rejection path rather than as a real
 * objective or criterion. Models occasionally echo a gate's own wording into
 * the field the gate reads, which would make the gate "pass" against its own
 * example text — so such values are replaced with the default instead.
 */
export const GATE_TEST_CONTRACT = /needs[_ ]revision|拒绝路径|verdict\s*=\s*needs_revision|cannot complete|不能完成|触发拒绝/iu

/** Statuses in which a planned follow-up is already scheduled and will run. */
export const OPEN_FOLLOW_UP_STATUSES = Object.freeze(['pending', 'claimed', 'in_progress'])


// ---------------------------------------------------------------------------
// Named team-profile templates
// ---------------------------------------------------------------------------
/** Hard cap on named profiles so the usage prompt cannot grow without bound. */
export const MAX_TEAM_PROFILES = 16
/** Hard cap on seed tasks per profile. The software-delivery example has 13. */
export const MAX_PROFILE_TASKS = 32
/** Protocol excerpt length in the usage / prompt listing. */
export const PROFILE_PROTOCOL_PROMPT_LIMIT = 240

/** Keys a profile record may carry; anything else is rejected. */
export const PROFILE_KEYS = Object.freeze([
  'description', 'protocol', 'executionPrompt', 'fallback', 'members', 'tasks', 'taskPlanning', 'reviewPolicy',
])
/** Keys a profile's review policy may carry. */
export const REVIEW_POLICY_KEYS = Object.freeze([
  'requirementsMinRounds', 'requirementsMaxRounds', 'codeMaxRounds', 'maxRepairAttempts', 'requiredReviewers',
])
/** Keys a profile member row may carry. `reasoning_effort` is snake_case here. */
export const MEMBER_KEYS = Object.freeze([
  'name', 'role', 'provider', 'model', 'reasoning_effort', 'executionPrompt', 'fallback',
])
/** Keys a profile's model-fallback row may carry. */
export const FALLBACK_KEYS = Object.freeze(['provider', 'model'])
/** Keys a profile's seed task row may carry. */
export const TASK_KEYS = Object.freeze(['id', 'subject', 'description', 'assignee', 'dependencies'])

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
