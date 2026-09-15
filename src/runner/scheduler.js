// The dispatch loop.
//
// Ported from agent-teams' `scheduler.ts`. Two properties of that design are
// load-bearing and easy to lose in a rewrite:
//
//   **Event-driven, with no timer anywhere.** There is no tick, no interval, no
//   backoff, and no boot-time recovery scan. Work moves when the host says an
//   agent changed status, or when something explicitly kicks. A reopened
//   process recovers lazily, on the next event, not on startup.
//
//   **Selection is ordered, and the order is the policy.** A member's unread
//   mail is delivered before new work, and a member's own unfinished attempt is
//   preferred over fresh work — otherwise a member that briefly went idle is
//   handed a second task while its first is still open.
//
// Everything that touches the store is injected. The store is a later step's
// module, and keeping it out of here is what lets the selection and rollback
// paths be tested without one.
import {
  attemptFailureEvents, assignmentPrompt, fallbackMailboxPrompt,
  collectCompletedDependencyOutputs, nextReadyTask, ownedOpenTask,
} from '../rules/index.js'
import { deliverToMember } from './member-ops.js'

/** The key one member's serial queue is filed under. */
const memberQueueKey = (teamId, memberName) => `${teamId}\u0000${memberName}`

/**
 * Run operations for one member strictly in order.
 *
 * Two kicks for the same member must not interleave: both would read the same
 * task list, both would decide it was theirs to take, and one attempt would
 * overwrite the other's capability. Different members stay independent.
 *
 * A re-entrant call for the same key deadlocks — this is a queue, not a
 * reentrant lock, and caller code must not kick from inside a kick.
 */
function createMemberQueues() {
  const queues = new Map()
  return async function serializeMember(key, operation) {
    const previous = queues.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    queues.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      // Drop the entry once we are still the tail, so a settled member does not
      // leave one resolved promise chained forever.
      if (queues.get(key) === tail) queues.delete(key)
    }
  }
}

/**
 * Install the scheduler.
 *
 * @param ctx - the plugin context; `ctx.agents.get` and `ctx.logger` are used.
 * @param options.deps - the store, mailbox and lookup operations (see below).
 * @param options.deps.readTeam - `(teamId) => Promise<TeamState | undefined>`.
 * @param options.deps.writeTeam - `(team) => Promise<void>`.
 * @param options.deps.withTeamLock - `(teamId, fn) => Promise<T>`.
 * @param options.deps.readUnreadMailbox - `(teamId, memberName) => Promise<TeamMessage[]>`.
 * @param options.deps.claimDelivery / acknowledgeDelivery / releaseDelivery.
 * @param options.deps.findTeamByParticipant - `(sessionId) => Promise<string | undefined>`.
 * @param options.stateDir - named in the assignment prompt as read-only.
 * @param options.executionPrompt - deployment-level guidance, if any.
 * @returns the scheduler handle.
 */
export function installTeamScheduler(ctx, options) {
  const { deps, stateDir, executionPrompt } = options
  const serializeMember = createMemberQueues()

  // An idle edge observed here proves the member ended its turn while the
  // attempt was still open. Harness may dispose the continuable handle right
  // after, so a missing registry entry is not evidence the owner was lost —
  // the marker is sticky, and only a durable attempt this process has never
  // seen is eligible for one cold recovery. A fresh process starts empty,
  // which is exactly what makes that recovery happen at all.
  const parkedAttempts = new Map()

  const liveCaptain = async (team, supplied) => {
    if (supplied !== undefined) return supplied
    const captain = ctx.agents.get(team.captainSessionId)
    return captain === undefined || captain.status === 'running' ? undefined : captain
  }

  const isMemberAvailable = member => {
    const live = ctx.agents.get(member.id)
    return live === undefined || live.status === 'idle'
  }

  /** Deliver whatever mail is waiting, then report whether that consumed the turn. */
  async function deliverMailbox(team, member, captain) {
    const unread = await deps.readUnreadMailbox(team.id, member.name)
    if (unread.length === 0) return false
    const ids = unread.map(message => message.id)
    const signal = new AbortController().signal
    let accepted = false
    try {
      await deps.claimDelivery(team.id, member.name, ids)
      await deliverToMember(ctx, {
        parent: captain,
        childId: member.id,
        text: fallbackMailboxPrompt(unread),
        signal,
      })
      accepted = true
    } finally {
      // The lease is acknowledged only when the host accepted the follow-up;
      // otherwise it is released so the next kick can try again.
      if (accepted) await deps.acknowledgeDelivery(team.id, member.name, ids)
      else await deps.releaseDelivery(team.id, member.name, ids)
    }
    return true
  }

  /** Decide and claim the next attempt, or return undefined when there is none. */
  async function claimNextAttempt(teamId, memberName) {
    return deps.withTeamLock(teamId, async () => {
      const team = await deps.readTeam(teamId)
      if (team === undefined || team.halted === true || team.phase === 'staged') return undefined
      const member = team.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
      if (member === undefined || member.id === '' || !isMemberAvailable(member)) return undefined

      const owned = ownedOpenTask(team.tasks, member.name)
      const parkedAttemptId = parkedAttempts.get(member.id)
      const recoverOwned = owned !== undefined
        && (owned.attemptId === undefined || owned.attemptId !== parkedAttemptId)
      const task = recoverOwned ? owned : owned === undefined ? nextReadyTask(team.tasks, member.name) : undefined
      if (task === undefined) {
        if (member.status !== 'idle') {
          member.status = 'idle'
          await deps.writeTeam(team)
        }
        return undefined
      }

      const previousAssignee = task.assignee
      const previousStatus = recoverOwned ? task.status : undefined
      const previousAttempt = recoverOwned ? task.attempt : undefined
      const previousAttemptId = recoverOwned ? task.attemptId : undefined

      const attemptId = deps.beginAttempt(task, member.name)
      if (recoverOwned) parkedAttempts.set(member.id, attemptId)
      else parkedAttempts.delete(member.id)
      member.status = 'working'
      await deps.writeTeam(team)

      return {
        teamId,
        taskId: task.id,
        memberName: member.name,
        memberId: member.id,
        attempt: task.attempt ?? 1,
        attemptId,
        previousAssignee,
        recoveredOwned: recoverOwned,
        ...previousStatus === undefined ? {} : { previousStatus },
        ...previousAttempt === undefined ? {} : { previousAttempt },
        ...previousAttemptId === undefined ? {} : { previousAttemptId },
        subject: task.subject,
        ...task.description === undefined ? {} : { description: task.description },
        ...team.description === undefined ? {} : { teamDescription: team.description },
        ...task.profileSeedId === undefined ? {} : { profileSeedId: task.profileSeedId },
        ...team.profile?.protocol === undefined ? {} : { profileProtocol: team.profile.protocol },
        ...(team.profile?.executionPrompt ?? executionPrompt) === undefined
          ? {}
          : { executionPrompt: team.profile?.executionPrompt ?? executionPrompt },
        kind: task.kind ?? 'work',
        ...task.round === undefined ? {} : { round: task.round },
        ...task.objective === undefined ? {} : { objective: task.objective },
        ...task.inScope === undefined ? {} : { inScope: task.inScope },
        ...task.outOfScope === undefined ? {} : { outOfScope: task.outOfScope },
        ...task.acceptance === undefined ? {} : { acceptance: task.acceptance },
        ...task.verify === undefined ? {} : { verify: task.verify },
        ...task.reviewedTaskId === undefined ? {} : { reviewedTaskId: task.reviewedTaskId },
        dependencyOutputs: collectCompletedDependencyOutputs(team.tasks, task.id, message => ctx.logger.warn(message)),
      }
    })
  }

  /**
   * Undo exactly our own failed dispatch.
   *
   * The guard is the attempt id: if a concurrent handoff already replaced the
   * capability, that handoff wins and this does nothing. Restoring a recovered
   * generation puts back the previous attempt and keeps it parked, so later
   * status kicks cannot spend an unbounded run of fresh attempts on a member
   * that is simply not there.
   */
  async function rollbackDispatch(ticket, failure) {
    await deps.withTeamLock(ticket.teamId, async () => {
      const team = await deps.readTeam(ticket.teamId)
      if (team === undefined) return
      const task = team.tasks.find(candidate => candidate.id === ticket.taskId)
      if (task === undefined || task.attemptId !== ticket.attemptId) return

      // The rollback is recorded, not merely applied: the store derives state
      // from events, so without these the recovery would leave no trace. It is
      // recorded *before* the fields below move, so the log is the thing the
      // caller's record is then reconciled against rather than the other way
      // round — `writeTeam` diffs, so recording after would double the fact.
      //
      // The generation, the owner and the capability are named here because the
      // projection needs them: a recovered attempt restores the generation it
      // replaced, and the alternatives are worse than they look — a task left
      // pointing at a member that could not be reached would be handed straight
      // back to it on the next kick, and a restored capability recorded as a
      // new one would read as work starting that never started.
      const restored = ticket.recoveredOwned && ticket.previousStatus !== undefined
      const seq = await Promise.resolve(deps.nextSeq?.(ticket.teamId) ?? 0)
      await deps.appendEvents?.(ticket.teamId, attemptFailureEvents(task, {
        reason: failure.reason,
        ...failure.code === undefined ? {} : { code: failure.code },
        toStatus: restored ? ticket.previousStatus : 'pending',
        assignee: restored ? ticket.previousAssignee ?? null : null,
        ...restored && ticket.previousAttempt !== undefined ? { attempt: ticket.previousAttempt } : {},
        ...restored && ticket.previousAttemptId !== undefined
          ? { restoredAttemptId: ticket.previousAttemptId }
          : {},
      }, Date.now(), seq))

      if (ticket.recoveredOwned && ticket.previousStatus !== undefined && ticket.previousAttemptId !== undefined) {
        task.status = ticket.previousStatus
        task.assignee = ticket.previousAssignee
        task.attempt = ticket.previousAttempt
        task.attemptId = ticket.previousAttemptId
        parkedAttempts.set(ticket.memberId, ticket.previousAttemptId)
      } else {
        task.status = 'pending'
        task.assignee = ticket.previousAssignee
        task.attemptId = undefined
        parkedAttempts.delete(ticket.memberId)
      }
      task.handoffId = undefined
      task.reassigning = false
      task.updatedAt = Date.now()
      const member = team.members.find(candidate => candidate.name === ticket.memberName)
      if (member !== undefined && member.status !== 'removed') member.status = 'idle'
      await deps.writeTeam(team)
    })
  }

  return {
    /** Dispatch to every member of a team, in order. */
    async kickTeam(teamId, suppliedCaptain) {
      const team = await deps.readTeam(teamId)
      if (team === undefined || team.halted === true || team.phase === 'staged') return
      const captain = await liveCaptain(team, suppliedCaptain)
      if (captain === undefined) return
      for (const member of team.members) {
        if (member.status === 'removed') continue
        await this.kickMember(teamId, member.name, captain)
      }
    },

    /** Dispatch to one member, serialized against its own other kicks. */
    async kickMember(teamId, memberName, suppliedCaptain) {
      await serializeMember(memberQueueKey(teamId, memberName), async () => {
        const team = await deps.readTeam(teamId)
        if (team === undefined || team.halted === true || team.phase === 'staged') return
        const captain = await liveCaptain(team, suppliedCaptain)
        if (captain === undefined) return
        const member = team.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
        if (member === undefined || member.id === '' || !isMemberAvailable(member)) return

        if (await deliverMailbox(team, member, captain)) return

        const ticket = await claimNextAttempt(teamId, memberName)
        if (ticket === undefined) return

        try {
          await deliverToMember(ctx, {
            parent: captain,
            childId: ticket.memberId,
            text: assignmentPrompt(ticket, stateDir, teamId),
            signal: new AbortController().signal,
          })
        } catch (error) {
          await rollbackDispatch(ticket, { reason: `dispatch failed: ${String(error)}` })
        }
      })
    },

    /**
     * Record that a member's agent went idle, which parks its current attempt.
     *
     * Called from the `agent/status` listener. Parking here is what stops the
     * next kick from treating a still-open attempt as recoverable and starting
     * a second one.
     */
    noteMemberIdle(sessionId, team) {
      const member = team?.members.find(candidate => candidate.id === sessionId)
      if (member === undefined) return
      // The capability lives on the *task*, not on the member: a member is a
      // person, an attempt is a job. Parking requires finding the one it owns.
      const owned = ownedOpenTask(team.tasks, member.name)
      if (owned?.attemptId === undefined) return
      parkedAttempts.set(sessionId, owned.attemptId)
    },

    /** Forget everything parked for a session that no longer participates. */
    forgetSession(sessionId) {
      parkedAttempts.delete(sessionId)
    },

    /** Parked attempt ids, for diagnostics. */
    parkedCount() {
      return parkedAttempts.size
    },
  }
}
