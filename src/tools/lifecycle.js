// Tools that decide what a team *is*: create it, shape its plan, approve it.
//
// These are the captain's tools. Every one of them changes the shape of the
// work rather than doing the work, which is why a member is denied all three —
// see `rules/tool-names.js`.
//
// The store is injected. These tools record what happened as events and let the
// store derive the state, so nothing here writes a snapshot directly.
import { FlowToolError, defineFlowTool } from './define.js'
import { sanitizeKey } from '../rules/index.js'

/** A team id that is not taken yet, derived from the goal. */
const teamIdFor = (goal, taken) => {
  const base = sanitizeKey(goal).slice(0, 40) || 'team'
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new FlowToolError('too many teams share that goal; give this one a distinct name')
}

/**
 * The team-creation tool.
 *
 * @param deps - see `installFlowTools`.
 */
export function createTeamTool(deps) {
  return defineFlowTool({
    name: 'flow_create',
    description: 'Create a team from a named profile. Members are not spawned until the plan is approved, unless approval is skipped.',
    parameters: {
      goal: { type: 'string', required: true, description: 'What the team is for.' },
      profile: { type: 'string', description: 'Configured profile name.' },
      name: { type: 'string', description: 'Team name; defaults to the goal.' },
    },
    properties: { teamId: { type: 'string' }, name: { type: 'string' }, phase: { type: 'string' }, members: { type: 'number' }, tasks: { type: 'number' } },
    required: ['teamId', 'name', 'phase', 'members', 'tasks'],
    async execute(args, exec) {
      const goal = String(args.goal ?? '').trim()
      if (goal === '') throw new FlowToolError('flow_create needs a goal')
      const teamId = teamIdFor(args.name ?? goal, await deps.listTeamIds())
      const now = deps.now()

      const built = await deps.buildTeam({
        teamId,
        name: String(args.name ?? goal).trim(),
        description: goal,
        profileName: args.profile,
        captainSessionId: deps.captainSessionId(exec),
        now,
      })

      await deps.appendEvents(teamId, built.events)
      await deps.materialize(teamId)
      return { teamId, name: built.name, phase: built.phase, members: built.members, tasks: built.tasks }
    },
  })
}

/**
 * The staged-plan editing tool.
 *
 * Only a staged team has a plan to edit. A running team's task list is the
 * record of what is happening, and rewriting it underneath live members would
 * invalidate attempts they are holding.
 */
export function editPlanTool(deps) {
  return defineFlowTool({
    name: 'flow_edit_plan',
    description: 'Edit a staged team plan: add, update or remove members and tasks before approving it.',
    parameters: {
      teamId: { type: 'string', required: true },
      addMembers: { type: 'array', description: 'Members to add, each { name, role }.' },
      removeMembers: { type: 'array', description: 'Member names to remove.' },
      addTasks: { type: 'array', description: 'Tasks to add, each { subject, kind, dependencies }.' },
      removeTasks: { type: 'array', description: 'Task ids to remove.' },
    },
    properties: { teamId: { type: 'string' }, members: { type: 'number' }, tasks: { type: 'number' } },
    required: ['teamId', 'members', 'tasks'],
    async execute(args) {
      return deps.withTeamLock(args.teamId, async () => {
        const team = await deps.readTeam(args.teamId)
        if (team === undefined) throw new FlowToolError(`no team "${args.teamId}"`)
        if (team.phase !== 'staged') {
          throw new FlowToolError(`team "${args.teamId}" is ${team.phase ?? 'running'}; only a staged plan can be edited`)
        }
        const events = deps.planEdits(team, args, deps.now())
        if (events.length === 0) throw new FlowToolError('nothing to change')
        await deps.appendEvents(args.teamId, events)
        const next = await deps.materialize(args.teamId)
        return { teamId: args.teamId, members: next.members.length, tasks: next.tasks.length }
      })
    },
  })
}

/**
 * The approval tool.
 *
 * Approving is the moment a plan becomes work: the phase moves, the timestamp
 * is recorded, and members are spawned. It refuses an already-running team
 * rather than re-spawning, because a second spawn would give the same member
 * two durable child sessions.
 */
export function approveTeamTool(deps) {
  return defineFlowTool({
    name: 'flow_approve',
    description: 'Approve a staged plan and start it: members are spawned and the first tasks are dispatched.',
    parameters: { teamId: { type: 'string', required: true } },
    properties: { teamId: { type: 'string' }, phase: { type: 'string' }, spawned: { type: 'number' } },
    required: ['teamId', 'phase'],
    async execute(args) {
      const started = await deps.withTeamLock(args.teamId, async () => {
        const team = await deps.readTeam(args.teamId)
        if (team === undefined) throw new FlowToolError(`no team "${args.teamId}"`)
        if (team.phase !== 'staged') {
          throw new FlowToolError(`team "${args.teamId}" is already ${team.phase ?? 'running'}`)
        }
        const now = deps.now()
        await deps.appendEvents(args.teamId, [
          { type: 'team.phase_changed', at: now, seq: await deps.nextSeq(args.teamId), from: 'staged', to: 'running' },
        ])
        await deps.materialize(args.teamId)
        return true
      })
      if (!started) return { teamId: args.teamId, phase: 'running', spawned: 0 }

      const spawned = await deps.spawnMembers(args.teamId)
      await deps.kickTeam(args.teamId)
      return { teamId: args.teamId, phase: 'running', spawned }
    },
  })
}
