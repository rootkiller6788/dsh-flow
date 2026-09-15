// Turning a profile into a plan, as events.
//
// A profile is a template: a named team shape with members, seed tasks and a
// review policy. Creating a team from one means expanding that template into
// the events that describe the team it produced — and expanding it here, as a
// pure function, is what lets the result be checked without a filesystem, a
// host, or a clock.
//
// The profile's own name is recorded on the team as a snapshot rather than a
// reference. A profile edited tomorrow must not change what a team created
// today was, which is the same reason the seed task's `subject` is copied
// rather than pointed at.
import { MAX_PROFILE_TASKS } from './constants.js'
import { sanitizeKey } from './identifiers.js'
import { isCaptainName, topoSortTasks } from './profiles.js'
import { validateCreateTask } from './gates.js'

/** How many members one profile may declare. */
export const MAX_PROFILE_MEMBERS = 16

/**
 * Read a profile's declared members.
 *
 * A profile that names a member the captain's own key would collide with is
 * refused rather than renamed: the collision is in the deployment's
 * configuration, and silently choosing a different name would make the team
 * that was created differ from the one that was described.
 *
 * @param profile - the profile record.
 * @returns `{ members }` or `{ error }`.
 */
function readProfileMembers(profile) {
  const declared = profile.members ?? []
  if (!Array.isArray(declared)) return { error: 'profile members must be a list' }
  if (declared.length === 0) return { members: [] }
  if (declared.length > MAX_PROFILE_MEMBERS) {
    return { error: `profile declares ${declared.length} members; the limit is ${MAX_PROFILE_MEMBERS}` }
  }
  const seen = new Set()
  for (const entry of declared) {
    if (typeof entry?.name !== 'string' || entry.name.trim() === '') {
      return { error: 'every profile member needs a name' }
    }
    const name = entry.name.trim()
    if (isCaptainName(name)) return { error: `member name "${name}" collides with the captain's reserved key` }
    const key = sanitizeKey(name)
    if (seen.has(key)) return { error: `two profile members fold to the same key "${key}"` }
    seen.add(key)
  }
  return { members: declared }
}

/**
 * Read a profile's seed tasks, in the order they must be created.
 *
 * `sourceIndex` is stamped here rather than trusted from the profile so the
 * topological tie-break is the profile's own declaration order — a profile
 * authored out of order still produces a reproducible team.
 *
 * @param profile - the profile record.
 * @param members - the already-validated members, for assignee checks.
 * @returns `{ tasks }` or `{ error }`.
 */
function readProfileTasks(profile, members) {
  const declared = profile.tasks ?? []
  if (!Array.isArray(declared)) return { error: 'profile tasks must be a list' }
  if (declared.length === 0) return { tasks: [] }
  if (declared.length > MAX_PROFILE_TASKS) {
    return { error: `profile declares ${declared.length} tasks; the limit is ${MAX_PROFILE_TASKS}` }
  }
  const names = new Set(members.map(member => member.name.trim()))
  const staged = []
  for (let index = 0; index < declared.length; index++) {
    const entry = declared[index]
    if (typeof entry?.subject !== 'string' || entry.subject.trim() === '') {
      return { error: `every profile task needs a subject (task ${index + 1})` }
    }
    const id = entry.id ?? `p${index + 1}`
    if (typeof id !== 'string' || id.trim() === '') {
      return { error: `profile task ${index + 1} has an unusable id` }
    }
    if (staged.some(task => task.id === id)) return { error: `two profile tasks share the id "${id}"` }
    if (entry.assignee !== undefined && !names.has(String(entry.assignee).trim())) {
      return { error: `profile task "${id}" assigns "${entry.assignee}", who is not a member of this profile` }
    }
    staged.push({
      id,
      sourceIndex: index,
      subject: entry.subject,
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.assignee === undefined ? {} : { assignee: String(entry.assignee).trim() },
      dependencies: entry.dependencies ?? [],
    })
  }
  try {
    return { tasks: topoSortTasks(staged) }
  } catch (error) {
    return { error: error.message }
  }
}

/**
 * Expand a profile into the events that create a team from it.
 *
 * @param request.teamId - the directory key the team is filed under.
 * @param request.name - the team's display name.
 * @param request.description - the goal the captain gave.
 * @param request.captainSessionId - the session that owns the team.
 * @param request.profile - the profile record, already resolved by name.
 * @param request.phase - `'staged'` or `'running'`; defaults to staged.
 * @param request.now - epoch milliseconds.
 * @returns `{ name, phase, members, tasks, phase, events }` or `{ error }`.
 *   `members` and `tasks` are counts, which is what the tool reports back.
 */
export function buildTeamEvents(request) {
  const { teamId, name, captainSessionId, now } = request
  const profile = request.profile
  const phase = request.phase ?? 'staged'

  const readMembers = readProfileMembers(profile)
  if (readMembers.error !== undefined) return { error: readMembers.error }
  const readTasks = readProfileTasks(profile, readMembers.members)
  if (readTasks.error !== undefined) return { error: readTasks.error }

  const events = []
  let seq = 0
  const push = (type, payload) => { events.push({ type, at: now, seq: seq++, ...payload }) }

  push('team.created', {
    name,
    captainSessionId,
    ...request.description === undefined ? {} : { description: request.description },
    profile: {
      name: profile.name,
      ...profile.description === undefined ? {} : { description: profile.description },
      ...profile.protocol === undefined ? {} : { protocol: profile.protocol },
      ...profile.taskPlanning === undefined ? {} : { taskPlanning: profile.taskPlanning },
    },
    phase,
  })
  for (const member of readMembers.members) {
    push('member.added', {
      member: {
        name: member.name.trim(),
        ...member.role === undefined ? {} : { role: member.role },
        ...member.provider === undefined ? {} : { provider: member.provider },
        ...member.model === undefined ? {} : { model: member.model },
        ...member.reasoning_effort === undefined ? {} : { reasoningEffort: member.reasoning_effort },
        ...member.executionPrompt === undefined ? {} : { executionPrompt: member.executionPrompt },
        ...member.fallback === undefined ? {} : { fallback: member.fallback },
      },
    })
  }

  // Seed tasks are validated against the team as it is being built, so a
  // profile whose task list would be rejected by `flow_create_task` is rejected
  // here instead of producing a team nobody could have created by hand.
  const drafting = {
    id: teamId,
    name,
    captainSessionId,
    createdAt: now,
    members: [],
    tasks: [],
    taskSeq: 0,
    phase,
    ...profile.reviewPolicy === undefined ? {} : { reviewPolicy: profile.reviewPolicy },
  }
  const ids = new Map(readTasks.tasks.map((task, index) => [task.id, `t${index + 1}`]))
  for (const seed of readTasks.tasks) {
    const checked = validateCreateTask(drafting, {
      ...seed,
      dependencies: seed.dependencies.map(dependency => ids.get(dependency) ?? dependency),
    })
    if (!checked.ok) return { error: `profile task "${seed.id}": ${checked.error}` }
    const id = ids.get(seed.id)
    push('task.created', { task: { ...checked.task, id, profileSeedId: seed.id } })
    drafting.tasks.push({ ...checked.task, id })
  }

  return {
    name,
    phase,
    members: readMembers.members.length,
    tasks: readTasks.tasks.length,
    events,
  }
}

/**
 * Turn a plan edit into events.
 *
 * Only a staged plan is editable, which the caller enforces; what this decides
 * is what each requested change *means* as a record.
 *
 * Removing a task is refused while another task depends on it: the dependency
 * would be left naming something that no longer exists, and a plan that cannot
 * be read is worse than one that cannot be edited.
 *
 * @param team - the staged team record.
 * @param args - `{ addMembers, removeMembers, addTasks, removeTasks }`.
 * @param now - epoch milliseconds.
 * @returns the events, or `{ error }`.
 */
export function planTeamEdits(team, args, now) {
  const events = []
  let seq = 0
  const push = (type, payload) => { events.push({ type, at: now, seq: seq++, ...payload }) }

  const addMembers = args.addMembers ?? []
  for (const entry of addMembers) {
    const name = String(entry?.name ?? '').trim()
    if (name === '') return { error: 'every added member needs a name' }
    if (isCaptainName(name)) return { error: `member name "${name}" collides with the captain's reserved key` }
    if (team.members.some(member => sanitizeKey(member.name) === sanitizeKey(name))) {
      return { error: `member "${name}" is already on this team` }
    }
    push('member.added', {
      member: {
        name,
        ...entry.role === undefined ? {} : { role: entry.role },
        ...entry.provider === undefined ? {} : { provider: entry.provider },
        ...entry.model === undefined ? {} : { model: entry.model },
        ...entry.reasoning_effort === undefined ? {} : { reasoningEffort: entry.reasoning_effort },
        ...entry.executionPrompt === undefined ? {} : { executionPrompt: entry.executionPrompt },
        ...entry.fallback === undefined ? {} : { fallback: entry.fallback },
      },
    })
  }

  const removeMembers = args.removeMembers ?? []
  for (const raw of removeMembers) {
    const name = String(raw ?? '').trim()
    if (name === '') return { error: 'every removed member needs a name' }
    if (!team.members.some(member => member.name === name)) {
      return { error: `member "${name}" is not on this team` }
    }
    push('member.removed', { id: name, reason: 'removed by plan edit' })
  }

  const removedTasks = (args.removeTasks ?? []).map(raw => String(raw ?? '').trim())
  for (const id of removedTasks) {
    if (id === '') return { error: 'every removed task needs an id' }
    if (!team.tasks.some(task => task.id === id)) return { error: `task "${id}" is not on this plan` }
    const dependent = team.tasks.find(task => task.dependencies.includes(id))
    if (dependent !== undefined) {
      return { error: `task "${id}" cannot be removed while "${dependent.id}" depends on it` }
    }
    push('task.removed', { id, reason: 'removed by plan edit' })
  }

  // Tasks added in one call may depend on each other, so each one is validated
  // against the plan as it stands *after* the ones before it — and gets its id
  // assigned here rather than left to the projection, because the next task in
  // the same call has to be able to name it.
  const drafting = { ...team, tasks: [...team.tasks] }
  for (const entry of args.addTasks ?? []) {
    const checked = validateCreateTask(drafting, {
      ...entry,
      dependencies: (entry?.dependencies ?? []).map(id => (id === undefined ? '' : String(id))),
    })
    if (!checked.ok) return { error: checked.error }
    const id = `t${drafting.taskSeq + 1}`
    drafting.taskSeq += 1
    drafting.tasks.push({ ...checked.task, id })
    push('task.created', { task: { ...checked.task, id } })
  }

  return events
}
