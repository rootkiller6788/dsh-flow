// Who is calling, and what that entitles them to.
//
// Every tool starts by answering the same three questions: which team is this
// session acting in, is it the captain or a member of it, and is the answer
// still true now that the record has been read under a lock. Getting that wrong
// is not a cosmetic bug — a member that can be mistaken for the captain can
// create teams, and a caller that reads a team outside the lock can act on a
// record that has already changed.
//
// So the questions live here, once, and every tool asks them in the same order.
// The alternative — each tool rolling its own checks — is how one of them ends
// up missing the third.
import { CAPTAIN_KEY } from '../rules/index.js'
import { FlowToolError } from './define.js'

/** The session id a tool call is being made by. */
export function callerId(exec, deps) {
  return deps.captainSessionId(exec)
}

function requireCaller(exec, deps) {
  const id = callerId(exec, deps)
  if (id === '') throw new FlowToolError('dsh-flow tools need a calling agent (exec.agent was undefined)')
  return id
}

/**
 * The team a session leads.
 *
 * Ambiguity is refused rather than resolved: a session that leads two teams has
 * a stored relationship the captain no longer remembers creating, and picking
 * one would silently act on the wrong team.
 */
export async function locateTeamByCaptain(exec, deps) {
  const id = requireCaller(exec, deps)
  const teamId = await deps.findTeamByCaptain(id)
  if (teamId === undefined) {
    throw new FlowToolError('you are not leading any team yet — call flow_create first')
  }
  const team = await deps.readTeam(teamId)
  if (team === undefined) throw new FlowToolError(`team "${teamId}" is no longer active`)
  return { team, caller: { kind: 'captain', name: CAPTAIN_KEY, id } }
}

/** The team a session leads or belongs to, for the tools members may call. */
export async function locateTeamByParticipant(exec, deps) {
  const id = requireCaller(exec, deps)
  const teamId = await deps.findTeamByParticipant(id)
  if (teamId === undefined) throw new FlowToolError('you do not lead or belong to any active team yet')
  const team = await deps.readTeam(teamId)
  if (team === undefined) throw new FlowToolError(`team "${teamId}" is no longer active`)
  const member = team.members.find(candidate => candidate.id === id && candidate.status !== 'removed')
  const caller = team.captainSessionId === id
    ? { kind: 'captain', name: CAPTAIN_KEY, id }
    : member === undefined
      ? undefined
      : { kind: 'member', name: member.name, id }
  if (caller === undefined) {
    throw new FlowToolError(`you are no longer an active participant in team "${team.name}"`)
  }
  return { team, caller }
}

/**
 * Re-read a team inside its lock and re-check the caller's authority.
 *
 * The read at the start of a tool is a *locator*, not a decision: by the time
 * the lock is held, the team may have been archived or the caller removed. This
 * is the check the decision is made on, and it is deliberately the last thing
 * before any mutation.
 *
 * @param teamId - the team to re-read.
 * @param caller - the identity established before the lock.
 * @param expected - `'captain'` or `'participant'`.
 * @param deps - the tool dependencies.
 * @returns the fresh team record.
 */
export async function requireFresh(teamId, caller, expected, deps) {
  const team = await deps.readTeam(teamId)
  if (team === undefined) throw new FlowToolError(`team "${teamId}" is no longer active`)
  if (team.captainSessionId !== caller.id) {
    if (expected === 'captain') {
      throw new FlowToolError(`only the captain of team "${team.name}" may perform this operation`)
    }
    const member = team.members.find(candidate => candidate.id === caller.id && candidate.status !== 'removed')
    if (member === undefined) {
      throw new FlowToolError(`you are no longer an active participant in team "${team.name}"`)
    }
  }
  return team
}

/** One member by name, refusing a removed one. */
export function requireMember(team, name) {
  const member = team.members.find(candidate => candidate.name === name && candidate.status !== 'removed')
  if (member === undefined) throw new FlowToolError(`no active member named "${name}" in team "${team.name}"`)
  return member
}

/** One task by id. */
export function requireTask(team, taskId) {
  const task = team.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) {
    throw new FlowToolError(`no task "${taskId}" in team "${team.name}" — use flow_status to list tasks`)
  }
  return task
}

/** A member's open work, if it has any: at most one unfinished task each. */
export function memberOpenTask(team, memberName, exceptId) {
  return team.tasks.find(task => (
    task.id !== exceptId
    && task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress')
  ))
}

/** The captain's open takeover, if it has one. */
export function captainOpenTask(team, exceptId) {
  return team.tasks.find(task => (
    task.id !== exceptId
    && task.assignee === CAPTAIN_KEY
    && (task.status === 'claimed' || task.status === 'in_progress')
  ))
}

/** A trimmed non-empty string, or undefined — never the empty string. */
export function trimmed(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}
