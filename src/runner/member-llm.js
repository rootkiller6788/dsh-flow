// Resolving a member's model route against the live host.
//
// The decision is in `rules/model-route.js` and is pure; this is the two things
// around it that cannot be — reading the captain's current request route off its
// live session, and asking the adapter to validate the result. Keeping the split
// means the interesting part is exhaustively testable and only the plumbing
// needs a host.
import { resolveMemberRoute } from '../rules/index.js'

/**
 * The captain's live route and options, in the shape `resolveMemberRoute`
 * expects.
 *
 * A session's in-flight request config wins over the agent's creation options,
 * because it is the more recent statement of intent — the captain may have been
 * switched to another model since it was created.
 *
 * @param captain - the live captain agent.
 * @returns `{ provider, model, reasoningEffort }`, any of which may be absent.
 */
export function captainRoute(captain) {
  const config = captain?.session?.requestHeader?.()?.config
  return {
    provider: config?.provider ?? captain?.options?.provider,
    model: config?.model ?? captain?.options?.model,
    reasoningEffort: config?.reasoningEffort,
  }
}

/**
 * Resolve one member's complete model selection.
 *
 * @param ctx - the plugin context; `ctx.llm.resolveCallConfig` must exist.
 * @param captain - the live captain agent.
 * @param request - the member's declared preferences.
 * @param signal - cancellation for the resolution call.
 * @returns `{ provider, model, reasoningEffort?, fallback? }`.
 * @throws when the route cannot be decided, or when the adapter rejects the
 *   effort id — the latter is what validates a value this port can only pass
 *   through as a bare string.
 */
export async function resolveMemberLlmSelection(ctx, captain, request, signal) {
  const resolved = resolveMemberRoute(request, captainRoute(captain))
  if (resolved.error !== undefined) throw new Error(resolved.error)

  const call = await ctx.llm.resolveCallConfig({ ...resolved.route }, signal)
  return {
    provider: call.provider,
    model: call.model,
    ...call.reasoningEffort === undefined ? {} : { reasoningEffort: String(call.reasoningEffort) },
    ...request.fallback === undefined ? {} : { fallback: request.fallback },
  }
}
