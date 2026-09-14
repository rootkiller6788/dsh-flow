// Refusing to resume a retired member.
//
// A removed member's child session still exists in the host. Anything that
// resumes it — a cold resume triggered by a stale reference, a queued prompt —
// re-enters a team that has already let it go, and the member comes back with
// no task and no owner. The guard closes that door at the one place every
// resumable delivery passes through.
//
// Restoring is the delicate part. Cordis wraps method reads in fresh Proxies,
// so assigning the original value back is not the same as removing your
// contribution: the property you are looking at may not be the one you set.
// The original compares the *own* descriptor before touching anything, and this
// does the same.
import { isRetiredMember } from '../rules/index.js'

/**
 * Wrap the delivery entry point so a retired target is refused before delivery.
 *
 * @param ctx - the plugin context.
 * @param options.isRetired - `(sender, targetSessionId) => Promise<boolean>`.
 *   Async because deciding usually means reading the durable list, and the
 *   original treats a throw from it as "not retired" rather than as a refusal.
 * @param options.errorType - the error class to throw, so callers upstream can
 *   tell a refusal apart from a transport failure.
 * @returns nothing; the guard is installed as an effect on `ctx`.
 */
export function installRetiredMemberGuard(ctx, options) {
  const runtime = ctx.subagents
  const original = runtime?.followup
  if (typeof original !== 'function') {
    // Nothing to guard. The executor probe refuses earlier for a deployment
    // that means to dispatch, so reaching here is a manual-only install.
    return
  }

  const descriptor = Object.getOwnPropertyDescriptor(runtime, 'followup')
  const guarded = async function guardedFollowup(parent, childId, content, followupOptions) {
    let retired = false
    try {
      retired = await options.isRetired(parent, childId)
    } catch {
      // Failing to read the deny-list must not block delivery: a member that is
      // actually retired will be refused by the durable state check the service
      // performs anyway. Blocking on an unreadable file would strand every
      // delivery behind an unrelated problem.
      retired = false
    }
    if (retired) {
      throw new options.errorType(
        `dsh-flow member "${childId}" was retired and cannot be resumed`,
        'NOT_RESUMABLE',
      )
    }
    return original.call(runtime, parent, childId, content, followupOptions)
  }

  runtime.followup = guarded
  ctx.effect(() => () => {
    // Only undo our own contribution. If something else replaced the property
    // after us, it owns it now and restoring would clobber their install.
    if (Object.getOwnPropertyDescriptor(runtime, 'followup')?.value !== guarded) return
    if (descriptor === undefined) Reflect.deleteProperty(runtime, 'followup')
    else Object.defineProperty(runtime, 'followup', descriptor)
  }, 'dsh-flow: retired member guard')
}
