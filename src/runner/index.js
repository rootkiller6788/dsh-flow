// The subagents runner: the seam's real implementation, assembled.
//
// It binds the pure decisions to the live host and owns the one thing a
// dispatcher cannot get wrong — reaching quiescence on the way out. The host
// awaits whatever a disposer returns, but it cannot force a disposer to wait
// for work the disposer forgot about. A runner that returns early leaves
// members running after its plugin is gone, with nothing left to talk to them.
//
// So disposal is three steps and the order is the point:
//   1. stop accepting new dispatches
//   2. let the work already in flight finish or fail
//   3. drain the continuable descendants this runner started
// and (2) is repeated after (3), because draining can itself produce callbacks.
import { requireExecutorContracts, UnsupportedHarnessError } from './harness-compat.js'
import { interruptMember } from './member-ops.js'
import { installTeamScheduler } from './scheduler.js'

/**
 * Build the subagents runner.
 *
 * @param ctx - the plugin context.
 * @param options.deps - the store and mailbox operations the scheduler needs.
 * @param options.stateDir - named in the assignment prompt as read-only.
 * @param options.executionPrompt - deployment-level guidance, if any.
 * @returns `{ name, run, dispose, scheduler, inFlightCount }`.
 * @throws `UnsupportedHarnessError` when the host cannot execute — a runner
 *   that silently did nothing would be worse than a mount that fails loudly.
 */
export function createSubagentsRunner(ctx, options) {
  const contracts = requireExecutorContracts(ctx)
  const inFlight = new Set()
  let disposed = false

  const track = promise => {
    const tracked = promise.finally(() => inFlight.delete(tracked))
    inFlight.add(tracked)
    return tracked
  }

  const scheduler = installTeamScheduler(ctx, {
    deps: options.deps,
    stateDir: options.stateDir,
    executionPrompt: options.executionPrompt,
  })

  /** Wait until nothing is in flight. */
  const settle = async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight])
  }

  return {
    name: 'subagents',
    scheduler,
    /** How many operations are still running; zero after a clean dispose. */
    inFlightCount: () => inFlight.size,

    /**
     * Execute one resolved spec.
     *
     * @param spec - a complete spec from `resolveRunnerRequest`; this never
     *   fills in a default of its own.
     * @returns `{ outcome, events, error? }`.
     */
    async run(spec) {
      if (disposed) {
        return { outcome: 'unsupported', error: 'the dsh-flow runner is disposed', events: [] }
      }
      const operation = (async () => {
        switch (spec.action) {
          case 'dispatch':
            await scheduler.kickMember(spec.teamId, spec.memberName)
            return { outcome: 'dispatched', events: [] }
          case 'deliver':
            await scheduler.kickMember(spec.teamId, spec.memberName)
            return { outcome: 'dispatched', events: [] }
          case 'interrupt':
            interruptMember(ctx, {
              targetSessionId: spec.memberSessionId,
              parentSessionId: spec.parentSessionId,
            })
            return { outcome: 'dispatched', events: [] }
          case 'probe':
            return { outcome: 'dispatched', events: [] }
          default:
            return { outcome: 'unsupported', error: `unknown runner action "${spec.action}"`, events: [] }
        }
      })()
      return track(operation)
    },

    /**
     * Reach quiescence.
     *
     * Resolves only once nothing this runner started is still running. The
     * host awaits this, so returning early is the difference between a clean
     * unload and orphaned members.
     */
    async dispose() {
      disposed = true

      // Let what is already running finish. Nothing new can start, because
      // `run` refuses from here on and the scheduler's callers are the same
      // code path.
      await settle()

      if (typeof contracts.drainDescendants === 'function') {
        // Scoped to the parents this runner owns: unrelated forests stay live,
        // which is what keeps one plugin's unload from stopping another's work.
        const parents = options.ownedParents?.() ?? []
        if (parents.length > 0) {
          await contracts.drainDescendants(parents)
          // Draining settles callbacks, and a settled callback is work. The
          // queue must be empty when this resolves, not merely at the instant
          // the drain returned.
          await settle()
        }
      }
    },
  }
}

export { UnsupportedHarnessError }
