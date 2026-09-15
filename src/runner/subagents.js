// The subagents runner: the seam's real implementation, assembled.
//
// One of the two implementations the composition root chooses between at mount
// — `manual.js` is the other, and `interface.js` is what they both satisfy. The
// pair is decided there rather than here because two live dispatchers would
// claim the same task, which is a mistake no runtime check should have to catch.
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
import { installMemberRuntime, memberSetupContribution } from './member-runtime.js'
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

  // A member is recognised by the durable label its session was created with,
  // and its runtime is installed through the host's own admission hook rather
  // than by watching for a session to appear. That ordering is the whole reason
  // the hook exists: installed at admission, a member has its failure handling
  // before its first request; installed on a later signal, the first request can
  // already have failed unobserved.
  //
  // Optional-called, and its absence is not an error. A host without the hook
  // still runs teams; what it loses is the per-member runtime, which is exactly
  // and only the set of behaviours the hook installs.
  const stopMemberSetup = typeof contracts.registerContinuableSetup === 'function'
    ? contracts.registerContinuableSetup(memberSetupContribution({
      // The host calls this for continuable children, so the mode is settled by
      // the hook. What is left to decide is whether the child is *ours*, and the
      // label decides that: we are the only thing that ever writes one.
      descriptorOf: child => ({ mode: 'continuable', label: child?.session?.header?.label }),
      install: ({ childCtx, teamId, memberName }) => installMemberRuntime(childCtx, {
        teamId,
        memberName,
        loadMember: async () => {
          const team = await options.deps.readTeam(teamId)
          return team?.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
        },
        switchRoute: route => persistMemberRoute(options.deps, teamId, memberName, route),
        // Recording the loss is not enough on its own: the scheduler's other
        // recovery path waits for an idle edge, and a member whose turn errored
        // out may never produce one.
        onFailureSettled: ({ code }) => scheduler.failMemberTurn(teamId, memberName, code),
      }),
    }))
    : undefined

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

      // Stop admitting members before anything else: a child recognised during
      // the drain below would be handed a runtime this disposer then has to
      // reach into a second time.
      stopMemberSetup?.()

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

/**
 * Record that a member is now on its fallback route.
 *
 * Written alongside the configured route rather than over it. The configured
 * route is what the deployment chose and the active route is what is happening;
 * overwriting the former would destroy the intent that the fallback exists to
 * preserve, and the member could never be put back.
 *
 * **What acts on this, and what does not.** This is the route the member's next
 * start resolves to, and it is what a reader sees when asking why a member is
 * not on the model its profile named. It is *not* an override of the session
 * already running: re-routing a live turn means rewriting the request the host
 * is about to assemble, and this build installs only the host surfaces it can
 * probe (see `harness-compat.js`). A member mid-session therefore stays on the
 * route it started with, and the switch governs from its next start onward.
 */
async function persistMemberRoute(deps, teamId, memberName, route) {
  await deps.withTeamLock(teamId, async () => {
    const team = await deps.readTeam(teamId)
    const member = team?.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
    if (team === undefined || member === undefined) return
    member.activeProvider = route.provider
    member.activeModel = route.model
    member.fallbackActive = true
    await deps.writeTeam(team)
  })
}

export { UnsupportedHarnessError }
