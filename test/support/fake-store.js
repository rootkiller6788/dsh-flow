// An in-memory stand-in for the team store, for scheduler tests.
//
// The store is a later step's module; the scheduler only needs these six
// operations from it. Modelling them here keeps the scheduler's decisions —
// selection order, parking, rollback — testable without a filesystem.
import { beginTaskAttempt } from '../../src/rules/index.js'

export function createFakeStore(initial) {
  const teams = new Map()
  if (initial !== undefined) teams.set(initial.id, initial)
  const locks = new Map()
  const events = []
  let seq = 0
  let uuid = 0

  return {
    teams,
    events,
    deliveries: [],

    async readTeam(teamId) { return teams.get(teamId) },
    async writeTeam(team) { teams.set(team.id, team) },

    async withTeamLock(teamId, operation) {
      const previous = locks.get(teamId) ?? Promise.resolve()
      let release
      const gate = new Promise(resolve => { release = resolve })
      locks.set(teamId, previous.then(() => gate))
      await previous
      try { return await operation() } finally { release() }
    },

    async readUnreadMailbox() { return [] },
    async claimDelivery() {},
    async acknowledgeDelivery() {},
    async releaseDelivery() {},

    async findTeamByParticipant(sessionId) {
      for (const team of teams.values()) {
        if (team.captainSessionId === sessionId) return team.id
        if (team.members.some(member => member.id === sessionId)) return team.id
      }
      return undefined
    },

    beginAttempt(task, assignee) {
      uuid += 1
      return beginTaskAttempt(task, assignee, { attemptId: `att-${uuid}`, now: 1000 + uuid })
    },
    appendEvents(teamId, batch) { for (const event of batch) events.push({ teamId, ...event }) },
    nextSeq() { return seq++ },
  }
}
