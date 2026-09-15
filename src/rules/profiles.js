// Profile seed-task ordering. Ported from `dsh-agent-teams/src/profiles.ts`
// (`topoSortTasks`, `formatCycleError`, `isCaptainName`).
//
// A profile lists its seed tasks in whatever order reads best, so the runtime
// needs a stable topological order before it can create them. The order is
// derived from `sourceIndex` rather than from map iteration, which keeps it
// reproducible: the same profile always yields the same task list.
import { CAPTAIN_KEY } from './constants.js'
import { sanitizeKey } from './identifiers.js'

/** Whether a member name would collide with the captain's reserved key. */
export function isCaptainName(name) {
  return name.trim().toLowerCase() === CAPTAIN_KEY || sanitizeKey(name) === CAPTAIN_KEY
}

/** Message for a dependency cycle, naming the tasks involved. */
export function formatCycleError(cyclic) {
  const first = cyclic[0] ?? 'unknown'
  const second = cyclic[1]
  if (cyclic.length === 1 || second === undefined) {
    return `profile task "${first}" forms a dependency cycle`
  }
  if (cyclic.length === 2) {
    return `profile task "${first}" and "${second}" form a dependency cycle`
  }
  const head = cyclic.slice(0, -1).map(id => `"${id}"`).join(', ')
  const tail = cyclic[cyclic.length - 1] ?? first
  return `profile tasks ${head}, and "${tail}" form a dependency cycle`
}

/**
 * Order seed tasks so every task follows the tasks it depends on.
 *
 * Kahn's algorithm with a source-order tie-break, so tasks that could go either
 * way keep their declared order. Throws rather than returning a partial list:
 * a profile with a cycle cannot be created at all, and a half-built team would
 * be worse than a clear error.
 *
 * @param tasks - the profile's tasks, each carrying its declared position.
 * @returns the same tasks in dependency order.
 */
export function topoSortTasks(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`profile task "${task.id}" depends on unknown task "${dependency}"`)
      }
    }
  }

  const indegree = new Map()
  const outgoing = new Map()
  for (const task of tasks) {
    indegree.set(task.id, 0)
    outgoing.set(task.id, [])
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1)
      outgoing.get(dependency)?.push(task.id)
    }
  }

  const ready = tasks
    .filter(task => (indegree.get(task.id) ?? 0) === 0)
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
  const ordered = []
  while (ready.length > 0) {
    const next = ready.shift()
    if (next === undefined) break
    ordered.push(next)
    for (const childId of outgoing.get(next.id) ?? []) {
      const remaining = (indegree.get(childId) ?? 0) - 1
      indegree.set(childId, remaining)
      if (remaining === 0) {
        const child = byId.get(childId)
        if (child === undefined) continue
        ready.push(child)
        ready.sort((left, right) => left.sourceIndex - right.sourceIndex)
      }
    }
  }

  if (ordered.length !== tasks.length) {
    // Whatever the sort could not place is exactly the part that is cyclic.
    const cyclic = tasks
      .filter(task => !ordered.some(done => done.id === task.id))
      .map(task => task.id)
    throw new Error(formatCycleError(cyclic))
  }
  return ordered
}

/** Strip a single matching pair of quotes; unmatched quotes are left alone. */
export function stripOneQuotePair(value) {
  if (value.length < 2) return value
  const first = value.at(0)
  const last = value.at(-1)
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function readProfileToken(raw) {
  const name = stripOneQuotePair(raw).trim()
  if (name === '') throw new Error('--profile flag is missing a profile name')
  return name
}

function parseLeadingProfileFlag(token, nextToken) {
  if (token === '--profile') {
    if (nextToken === undefined) throw new Error('--profile flag is missing a profile name')
    return { name: readProfileToken(nextToken), consumed: 2 }
  }
  if (token.startsWith('--profile=')) {
    return { name: readProfileToken(token.slice('--profile='.length)), consumed: 1 }
  }
  if (token.startsWith('profile=')) {
    return { name: readProfileToken(token.slice('profile='.length)), consumed: 1 }
  }
  return undefined
}

/**
 * Split an invocation into its goal and an optional leading `--profile` flag.
 *
 * Only leading flags are recognized, so a goal may contain the literal text
 * `--profile` without being misread. `--profile "name"` strips one matching
 * pair of quotes; a repeated flag, or `--profile` with no name, throws.
 *
 * @param rawInput - the raw command or gesture text.
 * @returns `{ goal }` or `{ goal, profile }`.
 */
export function parseProfileInvocation(rawInput) {
  const trimmed = rawInput.trim()
  const tokens = trimmed === '' ? [] : trimmed.split(/\s+/u)
  let index = 0
  let profile
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    const parsed = parseLeadingProfileFlag(token, tokens[index + 1])
    if (parsed === undefined) break
    if (profile !== undefined) throw new Error('duplicate dsh-flow profile flag')
    profile = parsed.name
    index += parsed.consumed
  }
  const goal = tokens.slice(index).join(' ')
  return profile === undefined ? { goal } : { goal, profile }
}

/** Task planning mode: an explicit `captain` request, else `seed`. */
export function resolveProfileTaskPlanning(config) {
  return config?.taskPlanning === 'captain' ? 'captain' : 'seed'
}

/**
 * The slash-command name a profile is reachable under.
 *
 * A profile key is free text a deployment chose; a command name is a closed
 * namespace. Only lowercase ASCII letters, digits and single interior dashes are
 * representable, and anything else yields `undefined` rather than a
 * normalisation — because a normalisation would have to decide what `foo bar`
 * and `foo_bar` become, and the answer that maps both onto one command silently
 * makes one profile unreachable.
 *
 * The prefix is the caller's: this decides the *suffix*, and the namespace it
 * lands in belongs to whoever is registering commands.
 *
 * @param profileName - the configured profile key.
 * @param prefix - what the command namespace prepends, if anything.
 * @returns the command name, or `undefined` when the profile is not representable.
 */
export function profileCommandName(profileName, prefix = '') {
  const normalized = String(profileName).trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) return undefined
  return `${prefix}${normalized}`
}
