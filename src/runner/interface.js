// The execution seam's service definition.
//
// This module owns the vocabulary and the validation; it never talks to a
// harness service. Two implementations exist and only one is ever mounted —
// `manual` (the canvas observes teams but drives nothing) and `subagents` (the
// real kernel). That is the `session-persistence` shape: a composition-time
// choice, so "which runner" is a line in the patch file rather than a runtime
// branch, and two schedulers cannot both be live by accident.
//
// Defaulting is explicit. `resolveRunnerRequest` is the one place a missing
// field is filled in, and it returns the whole spec; `run` receives a complete
// spec and is not allowed to invent anything. That is the host's rule for
// package boundaries (`AGENTS.md`: "defaulting is an explicit `resolve(request):
// Spec` step in the owning implementation, never a hidden `?? default` inside
// `run()`"), and it is what makes a dispatch reproducible from its spec alone.

/** Runner names this seam defines. */
export const RUNNER_NAMES = Object.freeze(['manual', 'subagents'])

/** What a dispatch is being asked to do. */
export const RUNNER_ACTIONS = Object.freeze(['dispatch', 'deliver', 'interrupt', 'probe'])

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate a resolved spec.
 *
 * @param spec - the resolved spec.
 * @returns an error message, or undefined when the spec is runnable.
 */
export function runnerSpecError(spec) {
  if (!isRecord(spec)) return 'runner spec must be an object'
  if (!RUNNER_NAMES.includes(spec.runner)) return `unknown runner "${String(spec.runner)}"`
  if (!RUNNER_ACTIONS.includes(spec.action)) return `unknown runner action "${String(spec.action)}"`
  if (typeof spec.teamId !== 'string' || spec.teamId === '') return 'runner spec requires a teamId'
  if (typeof spec.parentSessionId !== 'string' || spec.parentSessionId === '') {
    return 'runner spec requires a parentSessionId'
  }
  if (spec.action === 'dispatch') {
    if (typeof spec.taskId !== 'string' || spec.taskId === '') return 'a dispatch requires a taskId'
    if (typeof spec.memberName !== 'string' || spec.memberName === '') return 'a dispatch requires a memberName'
    if (typeof spec.prompt !== 'string' || spec.prompt === '') return 'a dispatch requires a non-empty prompt'
  }
  if (spec.action === 'deliver') {
    if (typeof spec.memberName !== 'string' || spec.memberName === '') return 'a delivery requires a memberName'
    if (typeof spec.content !== 'string') return 'a delivery requires content (which may be empty)'
  }
  if (spec.action === 'interrupt' && typeof spec.memberName !== 'string') {
    return 'an interrupt requires a memberName'
  }
  return undefined
}

/**
 * Fill in a request's defaults and validate the result.
 *
 * The caller supplies intent; this decides what that means concretely. An empty
 * or absent `signal` gets one that never aborts, so `run` never has to test for
 * its presence — the ambiguity is removed once, here, rather than at every use.
 *
 * @param request - the caller's request.
 * @returns `{ spec }` or `{ error }`.
 */
export function resolveRunnerRequest(request) {
  if (!isRecord(request)) return { error: 'runner request must be an object' }
  const spec = {
    runner: request.runner ?? 'subagents',
    action: request.action ?? 'dispatch',
    teamId: request.teamId,
    parentSessionId: request.parentSessionId,
    taskId: request.taskId,
    memberName: request.memberName,
    memberSessionId: request.memberSessionId ?? '',
    prompt: request.prompt,
    content: request.content,
    reason: request.reason ?? 'interrupt',
    signal: request.signal ?? new AbortController().signal,
  }
  const error = runnerSpecError(spec)
  return error === undefined ? { spec } : { error }
}

/** How a dispatch ended. */
export const RUNNER_OUTCOMES = Object.freeze([
  /** The work was handed to a member; events describe what changed. */
  'dispatched',
  /** The runner cannot position this task right now; try again after another event. */
  'deferred',
  /** The runner is not an executor at all. */
  'unsupported',
])

/**
 * Validate an outcome.
 *
 * `events` is always an array, including on failure. A runner that learned
 * something worth recording on the way to failing must be able to say so — a
 * failed dispatch that recorded nothing is indistinguishable from one that was
 * never attempted, which is the exact loss this store exists to avoid.
 *
 * @param outcome - the outcome to check.
 * @returns an error message, or undefined when valid.
 */
export function runnerOutcomeError(outcome) {
  if (!isRecord(outcome)) return 'runner outcome must be an object'
  if (!RUNNER_OUTCOMES.includes(outcome.outcome)) return `unknown runner outcome "${String(outcome.outcome)}"`
  if (!Array.isArray(outcome.events)) return 'runner outcome must carry an events array (empty is fine)'
  if (outcome.outcome === 'unsupported' && typeof outcome.error !== 'string') {
    return 'an unsupported outcome must explain itself'
  }
  return undefined
}

/**
 * The shape every runner implements.
 *
 * @typedef {object} FlowRunner
 * @property {string} name - one of `RUNNER_NAMES`.
 * @property {(request: object) => Promise<object>} run - execute a resolved spec.
 * @property {() => Promise<void>} dispose - reach quiescence; see below.
 *
 * `dispose` must not resolve until work this runner started has stopped. The
 * runtime awaits whatever a disposer returns but cannot force it to wait for
 * anything the disposer forgot to await, so a runner that returns early leaves
 * members running after its plugin is gone. There is no second chance at this.
 */
