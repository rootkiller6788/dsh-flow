// Deciding each agent's role once, and holding it for that agent's lifetime.
//
// A member must not reach the tools that shape the team, and must be told the
// member contract rather than the captain's. Both decisions are made before the
// agent's first request and then frozen: a team created or archived later must
// not rewrite the tools or prompt prefix of a conversation already under way,
// because that prefix is part of what the model saw.
//
// The role source is injected rather than imported. Deciding a role needs the
// team store, and the runner has no business reading it — the same separation
// that lets this module be tested without a store at all.
import { deniedToolsFor, promptForRole } from '../rules/index.js'

/** Default `order` for the prompt section; other plugins pick other numbers. */
export const CAPABILITY_PROMPT_ORDER = 117

/**
 * Install agent-scoped capability decisions.
 *
 * @param ctx - the plugin context.
 * @param options.stateDir - reserved for the caller's own diagnostics.
 * @param options.captainPrompt - the deployment's captain instructions.
 * @param options.roleOf - `(agent) => role`, resolving a live agent to
 *   `'captain' | 'member' | 'unrelated'`. May throw; a throw is contained.
 * @param options.order - prompt section order.
 * @returns nothing; the installation is an effect on `ctx`.
 */
export function installTeamCapabilities(ctx, options) {
  const { roleOf, captainPrompt, order = CAPABILITY_PROMPT_ORDER } = options
  const exposures = new WeakMap()
  const active = new Set()

  // Snapshot once. A profile, a team record or a tool result must never be able
  // to rewrite the instructions a captain starts from.
  const captainText = promptForRole('captain', captainPrompt)

  function attach(agent) {
    const prior = exposures.get(agent)
    if (prior !== undefined) return prior

    let role = 'unrelated'
    try {
      role = roleOf(agent)
    } catch (error) {
      // Damaged or unreadable team state must not disable ordinary conversation.
      // The business tools validate the durable record again before acting, so
      // the worst case here is a member briefly seeing the captain's prompt.
      ctx.logger.warn(`dsh-flow: capability hydration failed: ${String(error)}`)
    }

    const exposure = { role, dispose: () => undefined }
    let revoke
    let releaseLifetime
    let disposed = false
    exposure.dispose = () => {
      if (disposed) return
      disposed = true
      revoke?.()
      releaseLifetime?.()
      exposures.delete(agent)
      active.delete(exposure)
    }
    exposures.set(agent, exposure)
    active.add(exposure)

    try {
      const denied = deniedToolsFor(role)
      if (denied.length > 0) revoke = agent.ctx.tools.restrict({ deny: denied })
      releaseLifetime = agent.ctx.effect(() => exposure.dispose, 'dsh-flow: capability lifetime')
      return exposure
    } catch (error) {
      exposure.dispose()
      throw error
    }
  }

  ctx.systemPrompt.section({
    name: 'dsh-flow:usage',
    order,
    text: ({ agent }) => {
      const role = agent === undefined ? 'unrelated' : exposures.get(agent)?.role ?? 'unrelated'
      return role === 'member' ? promptForRole('member', captainPrompt) : captainText
    },
  })

  // The listener is removed by the host when this plugin unloads, which is what
  // stops new agents being attached; this effect only releases what was already
  // installed. There is deliberately no separate "am I still mounted" flag — a
  // second mechanism for the same fact would be a branch nobody could reach.
  ctx.on('agent/session-start', ({ agent }) => { attach(agent) })
  ctx.effect(() => () => {
    for (const exposure of [...active]) exposure.dispose()
  }, 'dsh-flow: capability scopes')

  // Agents already running when this plugin mounts still need their role.
  for (const agent of ctx.agents.list()) attach(agent)
}
