// Choosing a member's model route.
//
// Ported from agent-teams' `members.ts` (`resolveMemberLlmSelection`), split
// from the call that resolves it. The decision — which provider, which model,
// which reasoning effort — is pure and gets checked exhaustively; reading the
// captain's live route and validating the result against the adapter is the
// host's part and lives in the runner.
//
// The subtle rule is effort. A reasoning-effort id is owned by one exact
// provider/model pair: passing another route's id to a model that does not
// advertise it is at best ignored and at worst rejects the call. So effort is
// carried over only when the route is unchanged, an explicit value always wins,
// and the sentinel `default` means "ask the target model" even on the same
// route.

/** The value that asks a model to use its own default effort. */
export const DEFAULT_EFFORT_SENTINEL = 'default'

const trimmed = value => (typeof value === 'string' ? value.trim() : undefined)

/**
 * Where a member's model route comes from, in precedence order.
 *
 * @param request - the member's declared preferences.
 * @param current - the captain's live route, and the agent's own options.
 * @returns `{ provider, model, reasoningEffort }` or `{ error }`.
 */
export function resolveMemberRoute(request, current) {
  const explicitProvider = trimmed(request.provider)
  const explicitModel = trimmed(request.model)
  const defaultModel = trimmed(request.defaultModel)
  const explicitEffort = trimmed(request.reasoningEffort)

  // An explicit empty string is a mistake worth naming: it means the caller
  // tried to set the field and produced nothing, which reads as "unset" and
  // would silently fall through to the captain's route.
  if (request.provider !== undefined && explicitProvider === '') return { error: 'member LLM provider must not be empty' }
  if (request.model !== undefined && explicitModel === '') return { error: 'member model must not be empty' }
  if (request.defaultModel !== undefined && defaultModel === '') return { error: 'configured memberModel must not be empty' }
  if (request.reasoningEffort !== undefined && explicitEffort === '') return { error: 'member reasoning effort must not be empty' }
  if (explicitProvider !== undefined && explicitModel === undefined) {
    return { error: 'an explicit member LLM provider requires an explicit member model' }
  }

  const currentProvider = current.provider
  const currentModel = current.model
  const provider = explicitProvider ?? currentProvider
  const model = explicitModel ?? defaultModel ?? currentModel
  if (provider === undefined || model === undefined) {
    return { error: 'cannot resolve the member LLM route from the current captain session' }
  }

  const sameRoute = provider === currentProvider && model === currentModel
  let reasoningEffort
  if (explicitEffort === undefined) {
    reasoningEffort = sameRoute ? current.reasoningEffort : undefined
  } else if (explicitEffort === DEFAULT_EFFORT_SENTINEL) {
    reasoningEffort = undefined
  } else {
    // The host's `ReasoningEffortId` brands this string; pure JS cannot, so the
    // value is whatever the caller wrote and the adapter rejects an id it does
    // not know. That rejection is the boundary this port relies on.
    reasoningEffort = explicitEffort
  }

  return {
    route: {
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    },
    sameRoute,
  }
}
