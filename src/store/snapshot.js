// The canvas' view of a team.
//
// The canvas was built against a live feed that reported a team as a flat
// record with a display state per task. Our store keeps the log and derives
// everything from it, so this is where the two meet: the record is projected
// into the shape the views already render.
//
// Two of the fields here are *derived* rather than read, and that distinction
// is the reason this module exists rather than the canvas reading raw records:
//
//   `task.state` is not `task.status`. A task that is still pending but whose
//   dependency failed is blocked, and the canvas has to show that as blocked —
//   the status alone would say "waiting" forever.
//
//   `member.status` is not the runtime's. It is the runtime's *input*: a member
//   that was mid-task when the plugin unloaded keeps whatever status it had in
//   the record, so a canvas trusting it would show a member working forever.
//   What can be derived from durable facts — the tasks it owns — cannot go
//   stale that way.
import {
  isTeamState, ownedOpenTask, projectTeam, taskDepthsById, taskVisualState, unsatisfiedDependencies,
} from '../rules/index.js'

/** Member statuses the record can hold, mapped to what a reader should see. */
function memberView(member, team, options) {
  const owned = ownedOpenTask(team.tasks, member.name)
  const done = team.tasks.filter(task => task.assignee === member.name && task.status === 'completed').length
  const total = team.tasks.filter(task => task.assignee === member.name).length
  return {
    name: member.name,
    id: member.id,
    role: member.role ?? '',
    provider: member.provider ?? '',
    model: member.model ?? '',
    reasoning_effort: member.reasoningEffort ?? '',
    // The recorded status is kept as-is; `activity` is what the runtime knows
    // right now. Keeping both means a canvas with no runtime still renders, and
    // one with a runtime renders live — and `activity` is the only field here
    // that a running executor could contradict, which is why it is the one
    // named differently.
    status: member.status,
    activity: options.activity?.(member.id) ?? (member.status === 'working' ? 'working' : 'idle'),
    done,
    total,
    currentTask: owned === undefined ? '' : owned.id,
    unread: 0,
  }
}

/**
 * Project one team into the canvas' shape.
 *
 * @param team - the team record from the store.
 * @param options.unread - `(memberName) => number`, how many messages the member
 *   has not read. Injected: counting them means reading inboxes, which is the
 *   storage layer's business rather than the projection's.
 * @param options.captainInbox - the captain's unread messages, already read.
 * @param options.archived - whether the team has ended.
 * @returns the snapshot.
 */
export function teamSnapshot(team, options = {}) {
  const depths = taskDepthsById(team.tasks)
  const unread = options.unread ?? (() => 0)
  return {
    teamId: team.id,
    name: team.name,
    description: team.description ?? '',
    phase: team.phase ?? 'running',
    halted: team.halted === true,
    archived: options.archived === true,
    captainName: 'captain',
    captainSessionId: team.captainSessionId,
    profileName: team.profile?.name ?? '',
    members: team.members
      .filter(member => member.status !== 'removed')
      .map(member => ({ ...memberView(member, team, options), unread: unread(member.name) })),
    tasks: team.tasks.map(task => ({
      id: task.id,
      subject: task.subject,
      description: task.description ?? '',
      state: taskVisualState(task.status, task.dependencies, team.tasks),
      status: task.status,
      assignee: task.assignee ?? '',
      dependencies: task.dependencies,
      depth: depths.get(task.id) ?? 0,
      kind: task.kind ?? 'work',
      attempt: task.attempt ?? 0,
      attemptId: task.attemptId ?? '',
      reassigning: task.reassigning === true,
      ...task.verdict === undefined ? {} : { verdict: task.verdict },
      ...task.profileSeedId === undefined ? {} : { seedId: task.profileSeedId },
      ...task.output === undefined ? {} : { output: task.output },
    })),
    // Work the team could hand out right now, so the canvas shows the queue
    // rather than only what is in flight.
    ready: team.tasks
      .filter(task => task.status === 'pending'
        && task.reassigning !== true
        && unsatisfiedDependencies(team.tasks, task.dependencies).length === 0)
      .map(task => task.id),
    captainInbox: options.captainInbox ?? [],
  }
}

/**
 * Every team every source can see, as the canvas reads them.
 *
 * The inboxes are read here rather than left to the caller because the counts
 * are part of what the canvas shows, and a projection that reported zero unread
 * mail for everybody would be wrong in a way nobody would notice — a member
 * with a message waiting would look like a member with nothing to say.
 *
 * A team from a read-only source is projected from its own record rather than
 * from a log it has not got: its events are synthesized so the same projection
 * applies, which is what lets one canvas draw both without a branch per view.
 *
 * @param registry - the source registry.
 * @param options.onMalformedLine - forwarded to the mailbox readers, so a
 *   damaged line shows up as a diagnostic rather than as silence.
 * @returns `{ teams }`, each naming the source it came from.
 */
export async function canvasSnapshot(registry, options = {}) {
  const teams = []
  for (const { teamId, source } of await registry.enumerate()) {
    const entry = registry.get(source)
    if (entry === undefined) continue
    const team = entry.writable === true
      ? await entry.readTeam(teamId)
      : projectTeam(await entry.load(teamId))?.state
    if (team === undefined || !isTeamState({ ...team, id: teamId }, teamId)) continue

    const counts = new Map()
    for (const member of team.members) {
      if (member.status === 'removed') continue
      const unread = await entry.readMailbox(teamId, member.name, options.onMalformedLine)
      counts.set(member.name, unread.filter(message => message.readAt === undefined).length)
    }
    const captainInbox = (await entry.readMailbox(teamId, 'captain', options.onMalformedLine))
      .filter(message => message.readAt === undefined)
      .slice(0, 8)
      .map(message => ({ from: message.from, content: message.content, ts: message.ts }))

    teams.push({
      ...teamSnapshot({ ...team, id: teamId }, { unread: name => counts.get(name) ?? 0, captainInbox }),
      source,
      writable: entry.writable === true,
    })
  }
  return { teams }
}
