// Wiring the store into the plugin, and into everything that was written
// against an injected store.
//
// The runner and the tools were both built to take their dependencies as
// arguments, which is what let them be tested without one. This is the module
// that finally supplies the real thing — and it is deliberately a thin adapter:
// if it grew logic of its own, that logic would be the only part of the system
// with no test that does not go through three other layers.
//
// Two things it does own, because neither belongs anywhere else.
//
// `writeTeam` is the **reconcile**: the dispatch loop is ported from
// agent-teams and mutates a record in place, and this is where that record is
// diffed against the log and the difference recorded as events. It is the only
// writer, so a change that cannot be expressed as an event fails here rather
// than disappearing.
//
// The four `hooks` are the parts that depend on deployment configuration — the
// profile registry, the runner, the scheduler — and are supplied by the plugin
// entry rather than imported, so this module stays testable without a host.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createMailboxStore } from './mailbox.js'
import { createTeamStore } from './team-store.js'
import { beginTaskAttempt, teamDiffEvents } from '../rules/index.js'

/** The four things a store cannot supply for itself. */
const REQUIRED_HOOKS = ['buildTeam', 'planEdits', 'spawnMembers', 'kickTeam']

/**
 * Build the store and the two dependency sets over it.
 *
 * @param options.root - the absolute directory holding team directories.
 * @param options.stateDir - the name used in prompts and diagnostics.
 * @param options.hooks.buildTeam - `(request) => Promise<{ name, phase, members, tasks, events }>`.
 * @param options.hooks.planEdits - `(team, args, now) => object[]`, the events an edit means.
 * @param options.hooks.spawnMembers - `(teamId) => Promise<number>`.
 * @param options.hooks.kickTeam - `(teamId) => Promise<void>`.
 * @param options.onMalformedLine - `(teamId, line, error) => void`.
 */
export function createFlowStore(options) {
  const store = createTeamStore({ root: options.root, onMalformedLine: options.onMalformedLine })

  // Checked at mount rather than at first use: a plugin that loads and then
  // fails the first time the model calls a tool is a plugin whose failure is
  // attributed to the model.
  for (const hook of REQUIRED_HOOKS) {
    if (typeof options.hooks?.[hook] !== 'function') {
      throw new Error(`createFlowStore needs a ${hook} hook; a store without one cannot serve its tools`)
    }
  }

  const mail = createMailboxStore({
    teamDir: teamId => join(options.root, teamId),
    ...options.now === undefined ? {} : { now: options.now },
    ...options.onMalformedLine === undefined ? {} : { onMalformedLine: options.onMalformedLine },
  })

  /**
   * Append events the caller has already decided on.
   *
   * Sequence numbers are the log's business, so they are assigned here rather
   * than by the caller — a caller that had to know the current length could not
   * compute it correctly from outside the team lock.
   */
  const appendEvents = (teamId, events) => store.appendEvents(teamId, events)

  /**
   * Save a team the caller mutated in place.
   *
   * Diffs against the log rather than against the record the caller read: the
   * dispatch loop records a failure's reason *before* it moves the fields, and
   * diffing against the log is what makes that a recorded fact instead of a
   * duplicate one.
   *
   * Callers must hold the team lock. `appendEvents` does not take it, and this
   * does not either, because the dispatch paths that call it are already inside
   * one — taking it again would deadlock a queue that is not reentrant.
   */
  const writeTeam = async team => {
    const before = await store.readTeam(team.id)
    const events = teamDiffEvents(before, team, Date.now(), await store.nextSeq(team.id))
    if (events.length > 0) await store.appendEvents(team.id, events)
    return store.readTeam(team.id)
  }

  /**
   * The team a session is acting in, if any.
   *
   * Both lookups scan the live teams. That is a directory read per call, which
   * is honest about what it costs: an index would be a second record of the
   * same relationship, and the two could disagree after a crash. A team that
   * has been archived does not appear, which is the point — an ended team is
   * not one you can keep acting in.
   */
  const findTeamBy = predicate => async sessionId => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    for (const teamId of await store.listTeamIds()) {
      const team = await store.readTeam(teamId)
      if (team !== undefined && predicate(team, sessionId)) return teamId
    }
    return undefined
  }
  const findTeamByCaptain = findTeamBy((team, sessionId) => team.captainSessionId === sessionId)
  const findTeamByParticipant = findTeamBy((team, sessionId) => (
    team.captainSessionId === sessionId || team.members.some(member => member.id === sessionId)
  ))

  /** The service other plugins and the canvas read. */
  const service = {
    listTeamIds: () => store.listTeamIds(),
    listArchivedTeamIds: () => store.listArchivedTeamIds(),
    readTeam: teamId => store.readTeam(teamId),
    readTeamEvents: teamId => store.readTeamEvents(teamId),
    readCheckpoint: teamId => store.readCheckpoint(teamId),
    nextSeq: teamId => store.nextSeq(teamId),
    appendEvents,
    createTeam: teamId => store.createTeam(teamId),
    hasTeam: teamId => store.hasTeam(teamId),
    archiveTeam: teamId => store.archiveTeam(teamId),
    removeTeam: teamId => store.removeTeam(teamId),
    materialize: teamId => store.materialize(teamId),
    readMailbox: (teamId, memberName, onMalformedLine) => mail.readMailbox(teamId, memberName, onMalformedLine),
    readUnreadMailbox: (teamId, memberName, onMalformedLine) => mail.readUnreadMailbox(teamId, memberName, onMalformedLine),
    appendMessage: (teamId, memberName, message) => mail.appendMessage(teamId, memberName, message),
    claimDelivery: (teamId, memberName, ids) => mail.claimDelivery(teamId, memberName, ids),
    acknowledgeDelivery: (teamId, memberName, ids) => mail.acknowledgeDelivery(teamId, memberName, ids),
    releaseDelivery: (teamId, memberName, ids) => mail.releaseDelivery(teamId, memberName, ids),
    listMailboxes: teamId => mail.listMailboxes(teamId),
    findTeamByCaptain,
    findTeamByParticipant,
    /**
     * Save a team the caller mutated in place, by reconciling it with the log.
     *
     * The caller MUST hold the team lock: this neither takes it nor can take it
     * — the dispatch paths that reach it are already inside one, and the queue
     * is not reentrant. Prefer `appendEvents` with events you decided yourself;
     * this exists for callers that genuinely hold a mutated record.
     */
    writeTeam: team => writeTeam(team),
    withTeamLock: (teamId, operation) => store.withTeamLock(teamId, operation),

    /**
     * The team a session is acting in, or undefined.
     *
     * Read by the capability layer, which decides a session's role once and
     * freezes it — so this is called once per agent, not once per turn.
     */
    async teamOf(sessionId) {
      const teamId = await findTeamByParticipant(sessionId)
      return teamId === undefined ? undefined : store.readTeam(teamId)
    },

    /** The captains this deployment owns, for scoping a teardown. */
    async captainSessionIds() {
      const ids = []
      for (const teamId of await store.listTeamIds()) {
        const team = await store.readTeam(teamId)
        if (team !== undefined) ids.push(team.captainSessionId)
      }
      return ids
    },
  }

  /** What the dispatch loop needs. */
  const runnerDeps = {
    readTeam: service.readTeam,
    writeTeam,
    appendEvents,
    nextSeq: service.nextSeq,
    withTeamLock: service.withTeamLock,
    beginAttempt: (task, assignee) => beginTaskAttempt(task, assignee, { attemptId: randomUUID(), now: Date.now() }),
    readUnreadMailbox: (teamId, memberName) => mail.readUnreadMailbox(teamId, memberName),
    claimDelivery: (teamId, memberName, ids) => mail.claimDelivery(teamId, memberName, ids),
    acknowledgeDelivery: (teamId, memberName, ids) => mail.acknowledgeDelivery(teamId, memberName, ids),
    releaseDelivery: (teamId, memberName, ids) => mail.releaseDelivery(teamId, memberName, ids),
    findTeamByParticipant,
    findTeamByCaptain,
    archiveTeam: teamId => store.archiveTeam(teamId),
    removeTeam: teamId => store.removeTeam(teamId),
    createTeam: teamId => store.createTeam(teamId),
  }

  /**
   * What the tools need.
   *
   * `buildTeam` and `planEdits` turn a tool call into events. They stay in the
   * hooks rather than in the tool bodies so the two halves remain separable:
   * the tool decides *what was asked*, the hook decides *what that means as a
   * record*, and only the second needs the profile registry.
   */
  const toolDeps = {
    ...runnerDeps,
    now: () => Date.now(),
    listTeamIds: async () => new Set(await store.listTeamIds()),
    materialize: teamId => store.materialize(teamId),
    captainSessionId: exec => String(exec?.agent?.id ?? ''),
    buildTeam: request => options.hooks.buildTeam(request),
    planEdits: (team, args, now) => options.hooks.planEdits(team, args, now),
    spawnMembers: teamId => options.hooks.spawnMembers(teamId),
    kickTeam: teamId => options.hooks.kickTeam(teamId),
  }

  return { store, mail, service, runnerDeps, toolDeps }
}
