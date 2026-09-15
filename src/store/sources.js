// Where teams come from: a registry of sources.
//
// Two shapes are possible for a seam like this, and which one is right is
// decided by whether two implementations may be live at once. Sources may:
// a deployment migrating off agent-teams runs with both installed and sees both
// sets of teams in one canvas, which is what makes the migration a config line
// rather than a big-bang import. So this is a **registry**, not a
// composition-time choice — the shape `ctx.web` uses for its search and fetch
// providers: register against a unique id, a duplicate is an error rather than
// a silent override, and the registration returns its own disposer.
//
// The executor seam is the opposite, deliberately. Two live schedulers would
// both claim the same task, so there is no runtime decision to make and the
// mount decides instead.
import { SOURCE_ID as NATIVE_ID } from './source-native.js'
import { SOURCE_ID as AGENT_TEAMS_ID, createAgentTeamsSource } from './source-agent-teams.js'

/** Source ids this build ships. */
export const SOURCE_IDS = Object.freeze([NATIVE_ID, AGENT_TEAMS_ID])

/**
 * Build the source registry.
 *
 * @param options.native - the store's service, which is the native source.
 * @param options.agentTeamsRoot - the `.agent-teams` directory to read, if this
 *   deployment has one. Absent means the source is not registered at all, which
 *   is different from registering one over a missing directory: the second
 *   reports an empty team list, the first is not asked.
 * @param options.onMalformedLine - forwarded to the readers.
 * @returns `{ register, list, get, describe, read, release }`.
 */
export function createSourceRegistry(options) {
  const sources = new Map()

  const registry = {
    /**
     * Add a source.
     *
     * A duplicate id is refused rather than resolved: two sources claiming one
     * id is a configuration error, and letting the later one win silently would
     * mean the teams a deployment sees depend on mount order.
     *
     * @param source - `{ id, writable, describe, enumerate, load, readTeam }`.
     * @returns a disposer that removes it.
     */
    register(source) {
      if (source === undefined || typeof source.id !== 'string' || source.id === '') {
        throw new Error('a team source needs a non-empty id')
      }
      if (sources.has(source.id)) throw new Error(`team source "${source.id}" is already registered`)
      sources.set(source.id, source)
      return () => { sources.delete(source.id) }
    },

    /** Every registered source, in registration order. */
    list() {
      return [...sources.values()]
    },

    get(id) {
      return sources.get(id)
    },

    /** What each source can do, for a diagnostic or a canvas legend. */
    describe() {
      return [...sources.values()].map(source => source.describe())
    },

    /**
     * Every team every source can see.
     *
     * Ids collide across sources in the ordinary case — the same team may exist
     * in both during a migration — so each entry names the source it came from
     * and the caller addresses it by both.
     */
    async enumerate() {
      const found = []
      for (const source of sources.values()) {
        for (const entry of await source.enumerate()) found.push({ ...entry, source: source.id })
      }
      return found
    },
  }

  registry.register(createNativeSource(options.native))
  if (options.agentTeamsRoot !== undefined) {
    registry.register(createAgentTeamsSource({
      root: options.agentTeamsRoot,
      ...options.onMalformedLine === undefined ? {} : { onMalformedLine: options.onMalformedLine },
    }))
  }
  return registry
}

/**
 * The native source: the store itself.
 *
 * A thin adapter rather than an interface the store implements, because the
 * store is used directly by far more code than the registry is — making every
 * caller go through a source object to reach its own log would be ceremony
 * without a second implementation to justify it.
 */
function createNativeSource(service) {
  return {
    id: NATIVE_ID,
    writable: true,
    describe() {
      return { id: NATIVE_ID, writable: true, note: 'the append-only team log' }
    },
    async enumerate() {
      return (await service.listTeamIds()).map(teamId => ({ teamId }))
    },
    load: teamId => service.readTeamEvents(teamId),
    readTeam: teamId => service.readTeam(teamId),
    readMailbox: (teamId, memberName, onMalformedLine) => (
      service.readMailbox(teamId, memberName, onMalformedLine)
    ),
    /** The one operation only a writable source has. */
    append: (teamId, events) => service.appendEvents(teamId, events),
  }
}
