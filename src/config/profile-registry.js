// The configured team profiles.
//
// A profile is deployment configuration, not protocol: which teams a deployment
// offers is its own business, so this lives behind `Config` rather than in the
// pure core (per `AGENTS.md`: deployment-varying choices are validated `Config`
// fields). What the core owns is the profile's *shape*, and the validation here
// leans on that rather than restating it.
//
// It sits in `src/config/` rather than beside the store because a profile is not
// a team: this layer is *what a deployment offers*, and the team layer is what
// it has. Reading a misconfigured profile as a storage concern would put the
// deployment's opinions inside the record that outlives them.
//
// The registry is checked once, at mount, and every later lookup is a map read.
// A misconfigured profile that only failed when a captain happened to pick it
// would be a configuration error reported to the model.
import { MAX_TEAM_PROFILES, PROFILE_KEYS, PROFILE_PROTOCOL_PROMPT_LIMIT, profileCommandName } from '../rules/index.js'

/** How many members one profile may declare by default. */
export const DEFAULT_MAX_MEMBERS = 8

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Build the registry from the plugin's config.
 *
 * @param profiles - the `profiles` config value: a name -> profile record map.
 * @param maxMembers - the per-profile member cap, if the deployment set one.
 * @returns `{ list, resolve, has }`.
 * @throws when the configuration itself is unusable — at mount, not at use.
 */
export function createProfileRegistry(profiles, maxMembers = DEFAULT_MAX_MEMBERS) {
  if (profiles === undefined || profiles === null) profiles = {}
  if (!isRecord(profiles)) throw new Error('dsh-flow profiles must be a map of name -> profile')
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 1) {
    throw new Error('dsh-flow maxMembers must be a positive integer')
  }

  const names = Object.keys(profiles)
  if (names.length > MAX_TEAM_PROFILES) {
    throw new Error(`too many dsh-flow profiles (${names.length}); the limit is ${MAX_TEAM_PROFILES}`)
  }

  const byName = new Map()
  for (const rawName of names) {
    const name = rawName.trim()
    if (name === '') throw new Error('configured dsh-flow profiles include an empty key')
    if (byName.has(name)) throw new Error(`configured dsh-flow profiles have duplicate key "${name}"`)

    const profile = profiles[rawName]
    if (!isRecord(profile)) throw new Error(`profile "${name}" must be a record`)
    for (const key of Object.keys(profile)) {
      if (!PROFILE_KEYS.includes(key)) throw new Error(`profile "${name}" has unknown key "${key}"`)
    }
    const members = profile.members ?? []
    if (!Array.isArray(members)) throw new Error(`profile "${name}" members must be a list`)
    if (members.length > maxMembers) {
      throw new Error(`profile "${name}" declares ${members.length} members; maxMembers is ${maxMembers}`)
    }
    byName.set(name, { ...profile, name })
  }

  return {
    /** Every configured profile, in declaration order, as `{ name, ...config }`. */
    list() {
      return [...byName.values()]
    },

    /** Whether a name is configured. */
    has(name) {
      return byName.has(String(name).trim())
    },

    /**
     * Look one up.
     *
     * @param name - the profile name a captain asked for.
     * @returns the profile record.
     * @throws naming the available profiles: a captain that asked for the wrong
     *   one needs to see the right ones, not just that it was wrong.
     */
    resolve(name) {
      const key = String(name ?? '').trim()
      if (key === '') throw new Error('a dsh-flow profile name must be a non-empty string')
      const profile = byName.get(key)
      if (profile === undefined) {
        const available = [...byName.keys()]
        throw new Error(
          `unknown dsh-flow profile "${key}" — configured profiles: `
          + (available.length === 0 ? '(none)' : available.join(', ')),
        )
      }
      return profile
    },
  }
}

/**
 * One line per profile, for the activation text.
 *
 * Written for a model choosing between them, so each line leads with what the
 * profile is *for*: a list of names alone would make the choice arbitrary.
 *
 * @param registry - the registry.
 * @returns the listing, or `''` when nothing is configured.
 */
export function describeProfiles(registry) {
  const listed = registry.list()
  if (listed.length === 0) return ''
  return [
    'Configured dsh-flow profiles (pass profile to flow_create):',
    ...listed.map(profile => {
      const planning = profile.taskPlanning === 'captain'
        ? 'captain planning'
        : `${profile.tasks?.length ?? 0} seed task${(profile.tasks?.length ?? 0) === 1 ? '' : 's'}`
      const counts = `(${profile.members?.length ?? 0} members, ${planning})`
      const summary = typeof profile.protocol === 'string' ? profile.protocol.trim().replace(/\s+/gu, ' ') : ''
      const shown = summary === '' ? '' : `: ${summary.slice(0, PROFILE_PROTOCOL_PROMPT_LIMIT)}`
      return `- ${profile.name} ${counts}${shown}`
    }),
  ].join('\n')
}

/**
 * The configured profiles as data, for a reader that offers a choice.
 *
 * Only the ones a slash command can address. A name like `bug fix` — or one in
 * another script — cannot be spelled as `/dsh-flow-…`, so offering it would give
 * the reader an option that fails only after they had typed a goal, as an
 * unknown command rather than as a profile they cannot pick.
 *
 * @param registry - from `createProfileRegistry`.
 * @returns `{ name, description?, members, tasks }` per offerable profile.
 */
export function listProfiles(registry) {
  const listed = []
  for (const profile of registry.list()) {
    if (profileCommandName(profile.name) === undefined) continue
    listed.push({
      name: profile.name,
      ...profile.description === undefined ? {} : { description: String(profile.description) },
      members: Array.isArray(profile.members) ? profile.members.length : 0,
      tasks: Array.isArray(profile.tasks) ? profile.tasks.length : 0,
    })
  }
  return listed
}
