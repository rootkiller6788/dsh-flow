// The two store hooks that depend on deployment configuration.
//
// This layer is what a deployment configures, and the adapters that turn that
// configuration into something the team layer can use. It is not part of the
// team layer: nothing here stores a team, and the team layer does not know it
// exists. What it knows is that `createFlowStore` wants four hooks.
//
// `createFlowStore` demands those four and supplies none of them. Two need only
// the profile registry, so they are built here; the other two — spawning and
// kicking — need the live host, so the plugin entry builds them from the
// runner. Keeping that split means this module can be tested with a config
// object and no context at all.
//
// Both hooks return *events*, never state. That is what makes them safe to call
// under a lock: nothing here writes, and the store decides what the events mean.
import { buildTeamEvents, planTeamEdits } from '../rules/index.js'

/**
 * Build `buildTeam` and `planEdits` over a profile registry.
 *
 * @param registry - from `createProfileRegistry`.
 * @returns the two hooks `createFlowStore` expects.
 */
export function createPlanHooks(registry) {
  return {
    /**
     * Expand a create request into the events that make the team exist.
     *
     * A profile is named rather than referenced: the expansion copies what the
     * profile said, so editing the profile tomorrow cannot change what a team
     * created today was. That is why the name is resolved here, once, and never
     * stored as a pointer.
     *
     * @param request - `{ teamId, name, description, profileName, captainSessionId, now, phase }`.
     * @returns `{ name, phase, members, tasks, events }`.
     * @throws when the profile is unknown or unusable — a captain that named the
     *   wrong profile needs to see the right ones.
     */
    async buildTeam(request) {
      const profile = registry.resolve(request.profileName)
      const built = buildTeamEvents({
        teamId: request.teamId,
        name: request.name,
        ...request.description === undefined ? {} : { description: request.description },
        captainSessionId: request.captainSessionId,
        profile,
        now: request.now,
        ...request.phase === undefined ? {} : { phase: request.phase },
      })
      if (built.error !== undefined) throw new Error(`profile "${profile.name}": ${built.error}`)
      return built
    },

    /**
     * Turn a plan edit into the events it means.
     *
     * @param team - the staged team record the caller already read.
     * @param args - the tool arguments.
     * @param now - epoch milliseconds.
     * @returns the events, or `{ error }` for the tool to translate.
     */
    planEdits(team, args, now) {
      return planTeamEdits(team, args, now)
    },
  }
}
