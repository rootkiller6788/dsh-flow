// Reading `.agent-teams/` as a team source: the migration path.
//
// This is the second implementation the source seam exists for, and it is
// read-only by construction rather than by a flag — the module has no write
// method, so no caller can be given one. Two things follow, and both are the
// point of doing it this way instead of importing the directory once:
//
//   A deployment can run with agent-teams still installed, see both sets of
//   teams in one canvas, and migrate on its own schedule. The moment the
//   migration is a config line rather than a big-bang import is the moment it
//   can be reversed by deleting that line.
//
//   What it cannot do is pretend. agent-teams keeps a snapshot, so a team
//   loaded from there has no attempt history, no rollback record and no
//   "this changed and changed back" — because those never happened anywhere it
//   could have recorded them. The events below are synthesized to reproduce the
//   *state*, and the log says so by being exactly as long as the state needs.
//
// The ids are preserved, so a team that migrates keeps the name other records
// refer to it by.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isTeamState, parseMailboxLines, sanitizeKey } from '../rules/index.js'

/** One source's name in the registry. */
export const SOURCE_ID = 'agent-teams'

/**
 * Read a team's snapshot into events.
 *
 * The order matters and is not arbitrary: the team exists, then its members,
 * then its tasks — and only then the attempt and status events that move each
 * task to where the snapshot says it is. Emitting them out of order would
 * produce a log whose own projection disagrees with the state it came from.
 *
 * @param state - the raw `team.json` record, already parsed.
 * @param at - the timestamp to stamp the synthesized events with.
 * @returns the events, in order.
 */
export function eventsFromTeamState(state, at) {
  if (!isTeamState(state, state.id)) {
    throw new Error(`cannot read team "${String(state?.id)}": the record is not a valid dsh-agent-teams state`)
  }
  // Synthesized events are stamped with one time. The snapshot has no times for
  // anything but the task timestamps, and inventing a spread would be inventing
  // history — which is the one thing this source must not do.
  const events = []
  const push = (type, payload) => events.push({ type, at, seq: events.length, ...payload })

  push('team.created', {
    name: state.name,
    captainSessionId: state.captainSessionId,
    ...state.description === undefined ? {} : { description: state.description },
    ...state.profile === undefined ? {} : { profile: state.profile },
    phase: state.phase ?? 'running',
  })
  if (state.halted === true) push('team.halted', {})

  // Fields the projection stamps are *removed* from the payload rather than
  // set to undefined: the reducer spreads the payload over its own defaults, so
  // a present-but-undefined `status` would overwrite `idle` with nothing.
  const without = (record, keys) => Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.includes(key)),
  )

  for (const member of state.members ?? []) {
    push('member.added', { member: without(member, ['status', 'joinedAt']) })
  }
  for (const task of state.tasks ?? []) {
    push('task.created', { task: without(task, ['status', 'attempt', 'attemptId', 'reassigning']) })
  }

  // Then the state each task is actually in. A task the snapshot reports as
  // having been attempted is one an attempt was started for, so the attempt is
  // synthesized too — but only where the snapshot recorded a capability. One it
  // did not is left without, because a fabricated id would be a capability
  // nothing holds and nothing can present.
  for (const task of state.tasks ?? []) {
    const attempted = task.attempt !== undefined && task.attempt > 0
    if (attempted) {
      push('task.attempt_started', {
        id: task.id,
        attemptId: task.attemptId ?? `imported-${task.id}-${task.attempt}`,
        attempt: task.attempt,
        ...task.assignee === undefined ? {} : { assignee: task.assignee },
      })
    }
    if (task.status === 'completed') {
      push('task.completed', {
        id: task.id,
        ...task.verdict === undefined ? {} : { verdict: task.verdict },
        ...task.output === undefined ? {} : { output: task.output },
      })
    } else if (task.status !== 'pending' && task.status !== (attempted ? 'claimed' : 'pending')) {
      // A status the attempt already implies is not re-stated: a second
      // transition for one fact is a transition no table ever produced.
      push('task.transitioned', {
        id: task.id,
        from: attempted ? 'claimed' : 'pending',
        to: task.status,
      })
    }
  }

  for (const member of state.members ?? []) {
    if (member.status === 'removed') push('member.removed', { id: member.id === '' ? member.name : member.id })
  }
  return events
}

/**
 * The source, over a `.agent-teams` root.
 *
 * @param options.root - the absolute directory holding agent-teams' team
 *   directories.
 * @param options.onMalformedLine - `(teamId, memberName, line, error) => void`.
 * @returns a source the registry can hold.
 */
export function createAgentTeamsSource(options) {
  const root = options.root
  const teamDir = teamId => join(root, teamId)

  const readJson = async path => {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  const snapshotOf = async teamId => {
    const raw = await readJson(join(teamDir(teamId), 'team.json'))
    if (raw === undefined) return undefined
    return { ...raw, id: teamId }
  }

  return {
    id: SOURCE_ID,
    // Read-only by construction: there is no `append` here to call. A source
    // that could write would make agent-teams' record a second writer of the
    // same team, and the two would disagree after the first concurrent update.
    writable: false,

    describe() {
      return {
        id: SOURCE_ID,
        writable: false,
        // What a reader needs to know before choosing this source: the records
        // are somebody else's format, and the history in them is whatever that
        // format kept, which is a snapshot rather than a log.
        note: 'reads .agent-teams/ team records; state only, no attempt history',
      }
    },

    async enumerate() {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        return entries
          .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'archive')
          .map(entry => ({ teamId: entry.name, source: SOURCE_ID }))
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
    },

    async load(teamId) {
      const state = await snapshotOf(teamId)
      return state === undefined ? undefined : eventsFromTeamState(state, Date.now())
    },

    async readTeam(teamId) {
      return snapshotOf(teamId)
    },

    async readMailbox(teamId, memberName, onMalformedLine) {
      const key = sanitizeKey(memberName)
      try {
        const raw = await readFile(join(teamDir(teamId), 'inbox', `${key}.jsonl`), 'utf8')
        return parseMailboxLines(raw, (line, error) => onMalformedLine?.(teamId, memberName, line, error))
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
    },
  }
}
