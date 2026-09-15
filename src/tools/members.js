// Adding a member and taking one out.
//
// These are the two tools that change who is on the team, and they are
// deliberately asymmetric in what they cost. Adding is cheap and reversible —
// a member with no work is a row in a plan. Removing revokes work in flight and
// puts it back in the pool, so it is the one that has to interrupt a live turn
// and wait for the effect rather than assume it.
import { CAPTAIN_KEY, TERMINAL_TASK_STATUSES, invalidateTaskAttempt, sanitizeKey } from '../rules/index.js'
import { FlowToolError, asToolError, defineFlowTool } from './define.js'
import { locateTeamByCaptain, requireFresh, requireMember, trimmed } from './identity.js'

/**
 * The team-adding tool.
 *
 * A member added to a staged team is a plan row and nothing else; the same call
 * on a running team creates the durable child immediately. That difference is
 * the whole reason the tool exists rather than being folded into plan editing:
 * the captain adds someone mid-flight because the work turned out to need them.
 */
export function addMemberTool(deps) {
  return defineFlowTool({
    name: 'flow_add_member',
    description: 'Add a member to the team roster. In a staged team this only adds an editable plan row and does not spawn a child; approval spawns the final configuration. In a running team it creates the durable continuable member immediately.',
    parameters: {
      teamId: { type: 'string', required: true },
      name: { type: 'string', required: true, description: 'Unique member name inside the team.' },
      role: { type: 'string', description: 'Role of the member (e.g. researcher, engineer, reviewer).' },
      provider: { type: 'string', description: 'Optional LLM provider route. Use only when the user explicitly requests a different provider; requires model.' },
      model: { type: 'string', description: 'Optional model override. Omit for the captain\'s current model (or the configured memberModel default).' },
      reasoning_effort: { type: 'string', description: 'Optional reasoning effort override, or "default" to force the model\'s default.' },
      executionPrompt: { type: 'string', description: 'Optional member-specific execution prompt. It remains editable while staged.' },
    },
    properties: {
      member_name: { type: 'string' }, member_id: { type: 'string' },
      provider: { type: 'string' }, model: { type: 'string' },
      reasoning_effort: { type: 'string' }, status: { type: 'string' }, phase: { type: 'string' },
    },
    required: ['member_name', 'member_id', 'provider', 'model', 'status', 'phase'],
    async execute(args, exec) {
      const located = await locateTeamByCaptain(exec, deps)
      const memberName = String(args.name ?? '').trim()
      if (memberName === '') throw new FlowToolError('member name must not be empty')
      const memberKey = sanitizeKey(memberName)
      if (memberKey === CAPTAIN_KEY) {
        throw new FlowToolError(`member name "${String(args.name)}" is reserved for the captain`)
      }

      const created = await deps.withTeamLock(located.team.id, async () => {
        const team = await requireFresh(located.team.id, located.caller, 'captain', deps)
        // Checked against every member ever added, including removed ones: the
        // name is an identity that history still refers to by, so reusing it
        // would make two different people's records read as one.
        if (team.members.some(candidate => sanitizeKey(candidate.name) === memberKey)) {
          throw new FlowToolError(`member name "${String(args.name)}" has already been used in team "${team.name}"`)
        }
        if (team.members.filter(candidate => candidate.status !== 'removed').length >= deps.maxMembers) {
          throw new FlowToolError(`team "${team.name}" is at its member cap (${deps.maxMembers})`)
        }

        const route = await asToolError(() => deps.resolveMemberRoute({
          exec,
          team,
          request: {
            provider: args.provider,
            model: args.model,
            reasoningEffort: args.reasoning_effort,
            executionPrompt: trimmed(args.executionPrompt),
          },
        }))

        // A running team gets its member now; a staged one gets a plan row the
        // captain can still rewrite. Spawning happens *before* the event is
        // recorded so the record carries the child's id rather than a blank
        // that would have to be patched in a second write.
        const spawn = team.phase === 'staged' || !deps.isExecuting()
          ? { id: '' }
          : await asToolError(() => deps.spawnMember({
            teamId: team.id,
            memberName,
            route,
            exec,
          }))

        const now = deps.now()
        await deps.appendEvents(team.id, [{
          type: 'member.added',
          at: now,
          seq: await deps.nextSeq(team.id),
          member: {
            ...spawn.id === '' ? {} : { id: spawn.id },
            name: memberName,
            ...trimmed(args.role) === undefined ? {} : { role: trimmed(args.role) },
            provider: route.provider,
            model: route.model,
            ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
            ...route.fallback === undefined ? {} : { fallback: route.fallback },
            ...trimmed(args.executionPrompt) === undefined ? {} : { executionPrompt: trimmed(args.executionPrompt) },
          },
        }])
        await deps.materialize(team.id)
        return { teamId: team.id, memberName, memberId: spawn.id, route, phase: team.phase ?? 'running' }
      })

      await deps.kickMember(created.teamId, created.memberName)
      return {
        member_name: created.memberName,
        member_id: created.memberId,
        provider: created.route.provider,
        model: created.route.model,
        ...created.route.reasoningEffort === undefined ? {} : { reasoning_effort: created.route.reasoningEffort },
        status: 'idle',
        phase: created.phase,
      }
    },
    render: (args, value) => [{
      type: 'text',
      text: value.phase === 'staged'
        ? `Member "${value.member_name}" added to the staged roster (${value.provider}/${value.model}); no child was spawned.`
        : `Member "${value.member_name}" added (subagent id ${value.member_id}, ${value.provider}/${value.model}${value.reasoning_effort === undefined ? '' : `, reasoning ${value.reasoning_effort}`}, status ${value.status}).`,
    }],
  })
}

/**
 * The member-removal tool.
 *
 * Removing revokes the member's work before it interrupts the member, and both
 * before it marks them removed. The order is the point: an interrupt is a
 * request the member may not have observed yet, and a member still holding a
 * valid capability could write one more update after the handoff. Revoking
 * first is what makes that write stale instead of authoritative.
 */
export function removeMemberTool(deps) {
  return defineFlowTool({
    name: 'flow_remove_member',
    description: 'Remove a member safely: revoke its current attempts, return all unfinished owned tasks to the shared pending pool, interrupt its live turn, and mark it removed.',
    parameters: {
      teamId: { type: 'string', required: true },
      name: { type: 'string', required: true, description: 'Name of the member to remove.' },
    },
    properties: {
      member_name: { type: 'string' },
      status: { type: 'string' },
      requeued_tasks: { type: 'array', items: { type: 'string' } },
    },
    required: ['member_name', 'status', 'requeued_tasks'],
    async execute(args, exec) {
      const located = await locateTeamByCaptain(exec, deps)
      const revoked = await deps.withTeamLock(located.team.id, async () => {
        const team = await requireFresh(located.team.id, located.caller, 'captain', deps)
        const member = requireMember(team, String(args.name ?? ''))
        const now = deps.now()
        const events = []
        const requeued = []
        for (const task of team.tasks) {
          if (task.assignee !== member.name) continue
          // A completed task is the record of work that happened; everything
          // else the member held returns to the pool, including a failed or
          // cancelled one — the member is gone, and leaving its work parked
          // would strand it.
          if (TERMINAL_TASK_STATUSES.includes(task.status)) continue
          const revokedAttemptId = task.attemptId
          invalidateTaskAttempt(task, undefined, false, { handoffId: deps.randomId(), now })
          task.reassigning = false
          requeued.push(task.id)
          events.push({
            type: 'task.rolled_back',
            at: now,
            seq: await deps.nextSeq(team.id),
            id: task.id,
            toStatus: 'pending',
            reason: `member "${member.name}" was removed`,
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
          reason: 'removed by the captain',
        })
        await deps.appendEvents(team.id, events)
        await deps.materialize(team.id)
        return { teamId: team.id, member: { ...member, status: 'removed' }, requeued }
      })

      if (revoked.member.id !== '') {
        // The deny-list is what stops a cold-resumed child from being treated
        // as a member again: the session still carries its creation label, and
        // the label alone cannot say that the relationship was ended.
        await deps.retireMembers([revoked.member.id])
        deps.interruptMember({ targetSessionId: revoked.member.id, parentSessionId: located.caller.id })
        await deps.waitForIdle({ memberId: revoked.member.id, signal: exec?.signal })
      }
      await deps.kickTeam(revoked.teamId)

      return {
        member_name: revoked.member.name,
        status: revoked.member.status,
        requeued_tasks: revoked.requeued,
      }
    },
    render: (args, value) => [{
      type: 'text',
      text: `Member "${value.member_name}" removed (status ${value.status}); requeued tasks: ${value.requeued_tasks.join(', ') || 'none'}.`,
    }],
  })
}
