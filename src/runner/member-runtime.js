// Per-child runtime: recognising a member, and re-routing it when its model
// fails in a way a different route would fix.
//
// Two hooks, both scoped to one child's own context so they disappear with it:
//
//   `agent/error`          a terminal turn failure. Only a *first* failure on a
//                          fallbackable code re-routes; once the member is on
//                          its fallback, the same failure is just a failure.
//   `agent/request-error`  a waterfall, so the listener must call `next()` to
//                          let the request proceed — returning without it
//                          short-circuits the chain for everyone downstream.
//
// The member's identity comes from the durable label its session carries. In a
// restarted process nothing else knows which team a child belongs to, which is
// exactly why the label is recorded at creation rather than kept in memory.
import { isFallbackFailureCode, selectFallbackRoute } from '../rules/index.js'
import { parseMemberLabel } from './member-ops.js'

/**
 * Install the per-child runtime on one continuable child.
 *
 * @param childCtx - the child's own context; effects registered here die with it.
 * @param options.label - the child's durable creation label.
 * @param options.teamId - the team the child belongs to.
 * @param options.memberName - the member's name within that team.
 * @param options.onFailureSettled - called after a terminal failure has been
 *   recorded, so the caller can kick the scheduler.
 * @param options.loadMember - `() => Promise<TeamMember | undefined>` — the
 *   current durable record, read fresh because a fallback switch mutates it.
 * @param options.switchRoute - `(route) => Promise<void>` — persist the switch.
 * @returns nothing; both hooks are effects on `childCtx`.
 */
export function installMemberRuntime(childCtx, options) {
  const { teamId, memberName, onFailureSettled, loadMember, switchRoute } = options

  const disposeFailure = childCtx.on('agent/error', async payload => {
    const code = payload?.error?.code ?? payload?.code
    if (typeof code !== 'string' || !isFallbackFailureCode(code)) {
      await onFailureSettled?.({ teamId, memberName, code: code ?? 'UNKNOWN' })
      return
    }

    const member = await loadMember()
    if (member === undefined) return
    const current = {
      provider: member.activeProvider ?? member.provider ?? '',
      model: member.activeModel ?? member.model ?? '',
    }
    const decision = selectFallbackRoute(current, member.fallback, code, member.fallbackActive === true)
    if (decision.retry) {
      // Switching is recorded on the member, not on its primary descriptor:
      // the configured route is what the user chose, and the active route is
      // what is happening. Overwriting the former would hide the intent.
      await switchRoute({ provider: decision.selection.provider, model: decision.selection.model })
    }
    await onFailureSettled?.({ teamId, memberName, code })
  })

  // A waterfall listener must delegate; returning without `next()` would stop
  // every later listener from seeing this request error.
  const disposeRequestError = childCtx.on('agent/request-error', async (payload, next) => {
    if (typeof next === 'function') return next()
    return undefined
  })

  childCtx.effect(() => () => {
    disposeFailure?.()
    disposeRequestError?.()
  }, 'dsh-flow: member selection runtime')
}

/**
 * Recognise one continuable child as a member, and install its runtime.
 *
 * @param setup - the contribution shape `registerContinuableSetup` takes:
 *   `(childCtx, child) => teardown`.
 * @param options.descriptorOf - `(child) => { mode?, label? } | undefined`.
 * @param options.install - called with `{ childCtx, child, teamId, memberName }`
 *   once a child is recognised.
 * @returns the setup contribution.
 */
export function memberSetupContribution(options) {
  return (childCtx, child) => {
    const descriptor = options.descriptorOf(child)
    if (descriptor?.mode !== 'continuable') return () => undefined
    const parsed = parseMemberLabel(descriptor.label)
    if (parsed === undefined) return () => undefined
    return options.install({ childCtx, child, ...parsed })
  }
}
