// Tools that decide what a team *is*: create it, shape its plan, approve it.
//
// These are the captain's tools. Every one of them changes the shape of the
// work rather than doing the work, which is why a member is denied all three —
// see `rules/tool-names.js`.
//
// The store is injected. These tools record what happened as events and let the
// store derive the state, so nothing here writes a snapshot directly.
import { FlowToolError, asToolError, defineFlowTool } from './define.js'
import { sanitizeKey, TERMINAL_TASK_STATUSES, resumeTeamState } from '../rules/index.js'
import { locateTeamByCaptain, requireFresh } from './identity.js'

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

      const built = await asToolError(() => deps.buildTeam({
        teamId,
        name: String(args.name ?? goal).trim(),
        description: goal,
        profileName: args.profile,
        captainSessionId: deps.captainSessionId(exec),
        now,
      }))

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
    async execute(args, exec) {
      // Who the caller is decides *which* team, exactly as it does for every
      // other tool that shapes one. `args.teamId` is not the authority — a
      // session that names a team it does not lead is refused rather than
      // obeyed, and the team is located from the caller instead.
      const located = await locateTeamByCaptain(exec, deps)
      return applyTeamEdits(deps, located.team.id, args, located.caller)
    },
  })
}

/**
 * Apply one edit to a staged plan.
 *
 * Shared with the canvas route rather than reimplemented there, and the sharing
 * that matters is the *gate*: `deps.planEdits` runs K8 over every task the edit
 * would create, and a second copy of that rule would be a second answer to
 * whether a task is allowed to exist.
 *
 * @param deps - the tool dependencies.
 * @param teamId - the team to edit.
 * @param args - `{ addMembers, removeMembers, addTasks, removeTasks }`.
 * @param caller - the identity the edit is made as. Optional: a caller that
 *   arrives from the canvas has no session to check, and saying so here is
 *   better than inventing one — see the route that passes nothing.
 * @returns `{ teamId, members, tasks }`.
 */
export async function applyTeamEdits(deps, teamId, args, caller) {
  return deps.withTeamLock(teamId, async () => {
    // With a caller, re-check authority under the lock: the read that located
    // the team is a *locator*, and by now the team may have been approved or the
    // caller removed from it.
    const team = caller === undefined
      ? await deps.readTeam(teamId)
      : await requireFresh(teamId, caller, 'captain', deps)
    if (team === undefined) throw new FlowToolError(`no team "${teamId}"`)
    // Only a staged team has a plan to edit. A running team's task list is the
    // record of what is happening, and rewriting it underneath live members
    // would invalidate attempts they are holding.
    if (team.phase !== 'staged') {
      throw new FlowToolError(`team "${teamId}" is ${team.phase ?? 'running'}; only a staged plan can be edited`)
    }
    const planned = deps.planEdits(team, args, deps.now())
    // The expander reports a refused edit as `{ error }` rather than by
    // throwing: it is pure rules code, and a rule that cannot be applied is an
    // answer, not an exception. Saying so is this layer's job.
    if (!Array.isArray(planned)) throw new FlowToolError(planned.error)
    if (planned.length === 0) throw new FlowToolError('nothing to change')
    await deps.appendEvents(teamId, planned)
    const next = await deps.materialize(teamId)
    return { teamId, members: next.members.length, tasks: next.tasks.length }
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
    async execute(args, exec) {
      // Approval is the moment a plan becomes work — members spawn and the first
      // tasks go out — so it is the tool that most needs the caller identified.
      // The team is located from the caller, not from `args.teamId`: a session
      // that names a team it does not lead is refused rather than obeyed.
      const located = await locateTeamByCaptain(exec, deps)
      return applyTeamApproval(deps, located.team.id, located.caller)
    },
  })
}

/**
 * Start a staged plan: record the phase change, then spawn and dispatch.
 *
 * Shared with the canvas route, and the sharing that matters is the *order*: the
 * phase change is durable before anything is started, so a spawn that fails
 * halfway leaves a running team with unspawned members — which is a state the
 * next resume repairs — rather than a staged team that secretly has children.
 *
 * @param deps - the tool dependencies.
 * @param teamId - the team to start.
 * @param caller - the identity the approval is made as. Optional: a caller that
 *   arrives from the canvas has no session to check.
 * @returns `{ teamId, phase, spawned }`.
 */
export async function applyTeamApproval(deps, teamId, caller) {
  await deps.withTeamLock(teamId, async () => {
    const team = caller === undefined
      ? await deps.readTeam(teamId)
      : await requireFresh(teamId, caller, 'captain', deps)
    if (team === undefined) throw new FlowToolError(`no team "${teamId}"`)
    if (team.phase !== 'staged') {
      throw new FlowToolError(`team "${teamId}" is already ${team.phase ?? 'running'}`)
    }
    const now = deps.now()
    await deps.appendEvents(teamId, [
      { type: 'team.phase_changed', at: now, seq: await deps.nextSeq(teamId), from: 'staged', to: 'running' },
    ])
    await deps.materialize(teamId)
  })

  const spawned = await deps.spawnMembers(teamId)
  await deps.kickTeam(teamId)
  return { teamId, phase: 'running', spawned }
}

/**
 * The resume tool.
 *
 * Resuming is deliberately not automatic on the next call that needs it except
 * where the reference allows it (`flow_create_task` with `resume=true`), so a
 * halt stays a halt until a human reason clears it. The reason is required and
 * is recorded rather than summarised: it is what the next captain turn reads.
 */
export function resumeTeamTool(deps) {
  return defineFlowTool({
    name: 'flow_resume',
    description: 'Explicitly resume a halted team. Requires a non-empty reason. Does not recreate cancelled tasks; only still-pending work is scheduled.',
    parameters: {
      teamId: { type: 'string', required: true },
      reason: { type: 'string', required: true, description: 'Why the team is being resumed.' },
    },
    properties: { status: { type: 'string' }, team_id: { type: 'string' }, reason: { type: 'string' } },
    required: ['status', 'team_id', 'reason'],
    async execute(args, exec) {
      const located = await locateTeamByCaptain(exec, deps)
      const result = await deps.withTeamLock(located.team.id, async () => {
        const team = await requireFresh(located.team.id, located.caller, 'captain', deps)
        const resumed = resumeTeamState(team, args.reason)
        if (resumed.status === 'rejected') throw new FlowToolError(resumed.error ?? 'resume rejected')
        // Already running is an answer, not an error, and it writes nothing: a
        // resume event on a team that was never halted would be a fact that
        // never happened.
        if (resumed.status === 'already_running') return { status: resumed.status, teamId: team.id }
        await deps.appendEvents(team.id, [{
          type: 'team.resumed',
          at: deps.now(),
          seq: await deps.nextSeq(team.id),
          reason: String(args.reason),
        }])
        await deps.materialize(team.id)
        return { status: resumed.status, teamId: team.id }
      })
      if (result.status === 'resumed') await deps.kickTeam(located.team.id)
      return { status: result.status, team_id: result.teamId, reason: String(args.reason) }
    },
    render: (args, value) => [{
      type: 'text',
      text: value.status === 'already_running'
        ? `Team ${value.team_id} is already running.`
        : `Team ${value.team_id} resumed (${value.reason}).`,
    }],
  })
}

/**
 * The ending tool.
 *
 * Archiving, not deleting: the work that was done stays readable, and the
 * members' ids go on a deny-list so a cold-resumed child cannot rejoin a team
 * that has ended. Both matter for the same reason — the team is over, and
 * nothing should be able to act as though it were not.
 */
export function deleteTeamTool(deps) {
  return defineFlowTool({
    name: 'flow_delete',
    description: 'End and archive your team: interrupts members and moves the current tasks and mailboxes out of active state for later inspection. Use when the work is done or explicitly abandoned. A same-name archive replaces its previous generation.',
    parameters: { teamId: { type: 'string', required: true } },
    properties: { deleted: { type: 'boolean' }, team_name: { type: 'string' } },
    required: ['deleted', 'team_name'],
    async execute(args, exec) {
      const located = await locateTeamByCaptain(exec, deps)
      const ended = await deps.withTeamLock(located.team.id, async () => {
        const team = await requireFresh(located.team.id, located.caller, 'captain', deps)
        const now = deps.now()
        const events = []
        // Every member, including ones removed earlier: a team that was created
        // before removal retired its members still has live sessions carrying
        // this team's label, and ending the team is what stops them.
        const roster = team.members.map(member => ({ ...member }))
        for (const member of team.members) {
          if (member.status === 'removed') continue
          member.status = 'removed'
          for (const task of team.tasks) {
            if (task.assignee !== member.name) continue
            if (TERMINAL_TASK_STATUSES.includes(task.status)) continue
            const revokedAttemptId = task.attemptId
            task.status = 'pending'
            task.assignee = undefined
            task.attemptId = undefined
            task.reassigning = false
            task.updatedAt = now
            events.push({
              type: 'task.rolled_back',
              at: now,
              seq: await deps.nextSeq(team.id),
              id: task.id,
              toStatus: 'pending',
              reason: `team "${team.name}" ended`,
              assignee: null,
              attempt: task.attempt ?? 0,
              ...revokedAttemptId === undefined ? {} : { attemptId: revokedAttemptId },
            })
          }
          events.push({
            type: 'member.removed',
            at: now,
            seq: await deps.nextSeq(team.id),
            id: member.name,
            reason: 'team ended',
          })
        }
        events.push({ type: 'team.archived', at: now, seq: await deps.nextSeq(team.id) })
        await deps.appendEvents(team.id, events)
        await deps.materialize(team.id)
        return { teamId: team.id, name: team.name, roster }
      })

      // All of them, not only the live ones: a member removed earlier is still
      // a session that could be resumed by hand, and the deny-list is the only
      // thing that would refuse it.
      await deps.retireMembers(ended.roster.map(member => member.id).filter(id => id !== ''))
      for (const member of ended.roster) {
        if (member.id === '') continue
        deps.interruptMember({ targetSessionId: member.id, parentSessionId: located.caller.id })
      }
      // A member that will not quiesce is logged rather than thrown: the team
      // is being archived either way, and refusing to archive it would leave
      // the plugin unable to end a team whose member is stuck.
      await Promise.allSettled(ended.roster
        .filter(member => member.id !== '')
        .map(member => deps.waitForIdle({ memberId: member.id, signal: exec?.signal })
          .catch(error => deps.onWarn?.(`member ${member.id} did not quiesce before archive: ${String(error)}`))))

      await deps.archiveTeam(ended.teamId)
      return { deleted: true, team_name: ended.name }
    },
    render: (args, value) => [{ type: 'text', text: `Team "${value.team_name}" ended and archived.` }],
  })
}
