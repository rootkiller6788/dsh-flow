// Event log → current state.
//
// The log is the record; this file is the reading of it. Every function here is
// a fold over the event list with no side effects, which is what makes replay,
// point-in-time inspection and "what changed between two seqs" all the same
// operation with different inputs.
//
// Message events deliberately do not touch the team record. Mail lives in the
// per-agent inboxes, not in `TeamState`; those events are in the log so the
// conversation can be replayed, and the projection leaves them alone.
import { sanitizeKey } from './identifiers.js'

const clone = value => structuredClone(value)

/**
 * Apply one event to a draft, returning the next draft.
 *
 * Exported because it is the single definition of what an event *means*: the
 * fold in `projectTeam` and the verification in `reconcile.js` both have to
 * agree with it exactly, and two copies of this switch would be two chances for
 * the log and the record to drift apart.
 */
export function reduceTeamEvent(draft, event) {
  switch (event.type) {
    case 'team.created':
      return {
        name: event.name,
        id: sanitizeKey(event.name),
        captainSessionId: event.captainSessionId,
        createdAt: event.at,
        members: [],
        tasks: [],
        taskSeq: 0,
        phase: event.phase ?? 'running',
        ...event.description === undefined ? {} : { description: event.description },
        ...event.profile === undefined ? {} : { profile: event.profile },
      }

    case 'team.phase_changed':
      return {
        ...draft,
        phase: event.to,
        // A staged team that has never been reviewed is awaiting review; the
        // field is only meaningful while staged.
        ...event.to === 'staged' ? { planReviewState: draft.planReviewState ?? 'awaiting_review' } : {},
      }

    case 'team.halted':
      return { ...draft, halted: true, haltedAt: event.at }

    case 'team.resumed': {
      const { haltedAt: _at, halted: _halted, ...rest } = draft
      return { ...rest, halted: false }
    }

    case 'member.added': {
      const member = {
        joinedAt: event.at,
        status: 'idle',
        ...clone(event.member),
      }
      // Empty ids are legal only while staged; normalise the common case so the
      // projection matches what the validator accepts.
      if (member.id === undefined) member.id = ''
      return { ...draft, members: [...draft.members, member] }
    }

    case 'member.updated':
      return {
        ...draft,
        members: draft.members.map(member => (
          member.id === event.id || member.name === event.id ? { ...member, ...clone(event.patch) } : member
        )),
      }

    case 'member.removed':
      return {
        ...draft,
        members: draft.members.map(member => (
          member.id === event.id || member.name === event.id ? { ...member, status: 'removed' } : member
        )),
      }

    case 'task.created': {
      const nextSeq = draft.taskSeq + 1
      const task = {
        id: event.task.id ?? `t${nextSeq}`,
        status: 'pending',
        dependencies: [],
        createdAt: event.at,
        updatedAt: event.at,
        ...clone(event.task),
      }
      return { ...draft, taskSeq: nextSeq, tasks: [...draft.tasks, task] }
    }

    case 'task.removed':
      return { ...draft, tasks: draft.tasks.filter(task => task.id !== event.id) }

    case 'task.transitioned':
      return {
        ...draft,
        tasks: draft.tasks.map(task => (
          task.id === event.id ? { ...task, status: event.to, updatedAt: event.at } : task
        )),
      }

    case 'task.attempt_started':
      // Mirrors `activateTaskAttempt` field for field: an activated generation
      // clears the previous output and the handoff gap marker, because the gap
      // it marked is now closed by work that has started.
      return {
        ...draft,
        tasks: draft.tasks.map(task => task.id === event.id
          ? {
              ...task,
              status: 'claimed',
              attempt: event.attempt ?? (task.attempt ?? 0) + 1,
              attemptId: event.attemptId,
              ...event.assignee === undefined ? {} : { assignee: event.assignee },
              handoffId: undefined,
              reassigning: false,
              output: undefined,
              updatedAt: event.at,
            }
          : task),
      }

    case 'task.attempt_failed':
      // The automatic consequence of a lost attempt: the capability is revoked
      // and the work returns to the pool. What happened is kept in the log, not
      // in the state — that is the whole point of `task.attempt_failed`.
      return {
        ...draft,
        tasks: draft.tasks.map(task => task.id === event.id
          ? { ...task, attemptId: undefined, reassigning: false, updatedAt: event.at }
          : task),
      }

    case 'task.rolled_back':
      // A rollback takes the work back. `assignee` says who, if anyone, holds it
      // now: absent means the event did not speak to it, `null` means the task
      // returned to the unassigned pool, and a name restores the owner the
      // failed generation replaced. The distinction is not decoration — a task
      // left pointing at a member that could not be reached would be handed
      // straight back to it as a "recovery" on the next kick.
      //
      // `restoredAttemptId` is the capability that comes back with the owner. It
      // is a separate field from `attemptId`, which names the failed generation
      // and is here to say *what* was revoked — a reader that conflated the two
      // would see a parked generation restored as a fresh start.
      return {
        ...draft,
        tasks: draft.tasks.map(task => task.id === event.id
          ? {
              ...task,
              status: event.toStatus,
              attemptId: event.restoredAttemptId,
              ...event.attempt === undefined ? {} : { attempt: event.attempt },
              ...'assignee' in event ? { assignee: event.assignee ?? undefined } : {},
              reassigning: false,
              updatedAt: event.at,
            }
          : task),
      }

    case 'task.completed':
      return {
        ...draft,
        tasks: draft.tasks.map(task => task.id === event.id
          ? {
              ...task,
              status: 'completed',
              updatedAt: event.at,
              ...event.verdict === undefined ? {} : { verdict: event.verdict },
              ...event.acceptanceResults === undefined ? {} : { acceptanceResults: clone(event.acceptanceResults) },
              ...event.changedPaths === undefined ? {} : { changedPaths: clone(event.changedPaths) },
              ...event.output === undefined ? {} : { output: event.output },
            }
          : task),
      }

    default:
      return draft
  }
}

/**
 * Fold a whole event log into the current team record.
 *
 * @param events - events in log order.
 * @returns `{ state, archived, lastSeq }`, or `undefined` when the log has no
 *   `team.created` — a log without a beginning describes nothing, and returning
 *   an empty team would be a lie.
 */
export function projectTeam(events) {
  let draft
  let archived = false
  for (const event of events) {
    if (event.type === 'team.created') draft = reduceTeamEvent(draft ?? {}, event)
    else if (draft !== undefined) draft = reduceTeamEvent(draft, event)
    if (event.type === 'team.archived') archived = true
  }
  if (draft === undefined) return undefined
  return { state: draft, archived, lastSeq: events.length === 0 ? -1 : events[events.length - 1].seq }
}

/**
 * The team record as it stood after a given seq.
 *
 * A fold, not a diff: the log is small and immutable, so replaying it is the
 * simplest thing that is certainly correct.
 *
 * @param events - events in log order.
 * @param seq - the last seq to include.
 * @returns the same shape as `projectTeam`.
 */
export function replayTeam(events, seq) {
  return projectTeam(events.filter(event => event.seq <= seq))
}

/**
 * Attempt history for one task, oldest first.
 *
 * This is the question the snapshot model cannot answer: agent-teams leaves a
 * monotonic `attempt` counter, so it can say *how many* attempts happened but
 * never what became of them.
 *
 * @param events - events in log order.
 * @param taskId - the task to trace.
 * @returns one entry per attempt that started, each with its outcome when known.
 */
export function taskAttempts(events, taskId) {
  const attempts = []
  const byId = new Map()
  for (const event of events) {
    if (event.id !== taskId) continue
    if (event.type === 'task.attempt_started') {
      const entry = {
        attemptId: event.attemptId,
        at: event.at,
        assignee: event.assignee,
        outcome: 'started',
      }
      attempts.push(entry)
      byId.set(event.attemptId, entry)
    }
    if (event.type === 'task.attempt_failed') {
      const entry = byId.get(event.attemptId)
      if (entry !== undefined) {
        entry.outcome = 'failed'
        entry.reason = event.reason
        entry.code = event.code
        entry.endedAt = event.at
      }
    }
  }
  return attempts
}

/**
 * Rollbacks recorded against one task, oldest first.
 *
 * agent-teams performs the same recovery and writes only the restored snapshot,
 * so afterwards a rolled-back task is indistinguishable from one that was never
 * attempted.
 */
export function taskRollbacks(events, taskId) {
  return events.filter(event => event.type === 'task.rolled_back' && event.id === taskId).map(event => ({
    at: event.at,
    toStatus: event.toStatus,
    reason: event.reason,
    code: event.code,
    attemptId: event.attemptId,
  }))
}
