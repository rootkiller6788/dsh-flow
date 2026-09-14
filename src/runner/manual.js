// The canvas-only runner.
//
// Mounting this instead of `subagents` is what makes "dsh-flow watches teams
// but drives nothing" a configuration rather than a code path. That matters
// beyond tidiness: a runner that spawns members competes with any other plugin
// that also spawns members — both would consider themselves the captain and
// both would dispatch the same work. Choosing the runner at composition time
// makes that collision unrepresentable instead of merely discouraged.
import { resolveRunnerRequest, runnerOutcomeError } from './interface.js'

/**
 * A runner that never executes anything, and says so.
 *
 * Every action reports `unsupported` rather than resolving quietly: a silent
 * success would leave callers waiting for a member that was never started, and
 * the failure would surface much later as "the team is stuck" with no hint why.
 */
export function createManualRunner() {
  return {
    name: 'manual',

    /**
     * @param request - a runner request.
     * @returns an `unsupported` outcome carrying the reason.
     */
    async run(request) {
      const resolved = resolveRunnerRequest({ ...request, runner: 'manual' })
      if (resolved.error !== undefined) {
        const failure = { outcome: 'unsupported', error: resolved.error, events: [] }
        return failure
      }
      const outcome = {
        outcome: 'unsupported',
        error: 'no execution kernel is mounted; this deployment only displays teams',
        events: [],
      }
      // Guard the contract against our own drift, not against the caller.
      const error = runnerOutcomeError(outcome)
      if (error !== undefined) throw new Error(`manual runner produced an invalid outcome: ${error}`)
      return outcome
    },

    /** Nothing was ever started, so quiescence is already reached. */
    async dispose() {},
  }
}
