// Contract for the team lifecycle tools.
//
// The store is faked, so what these prove is the decision and the recording:
// what a call is allowed to do, what it refuses, and what it appends. Whether a
// real store derives the same state from those events is the store's contract,
// tested where the store lives.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installFlowTools } from '../src/tools/index.js'
import { FLOW_TOOL_NAMES } from '../src/rules/index.js'
import { createFakeHost } from './support/fake-host.js'

/** A recording set of tool dependencies. */
function buildTools(options = {}) {
  const events = []
  const teams = new Map()
  // The fixture captain is the caller unless a test says otherwise, which is
  // what makes `locateTeamByCaptain` find the team and `requireFresh` accept the
  // caller. A test that wants the refusal overrides `captainSessionId`.
  if (options.team !== undefined) teams.set(options.team.id, { captainSessionId: 'sess-cap', ...options.team })
  const seqs = new Map()
  const spawnCalls = []
  const kicks = []
  let clock = 1000

  const deps = {
    now: () => (clock += 1),
    listTeamIds: async () => new Set(teams.keys()),
    readTeam: async id => teams.get(id),
    async appendEvents(teamId, batch) { for (const event of batch) events.push({ teamId, ...event }) },
    async nextSeq(teamId) {
      const next = seqs.get(teamId) ?? 0
      seqs.set(teamId, next + 1)
      return next
    },
    async materialize(teamId) { return teams.get(teamId) ?? { id: teamId, members: [], tasks: [] } },
    async withTeamLock(_teamId, operation) { return operation() },
    planEdits: (team, args) => options.planEdits?.(team, args) ?? [],
    captainSessionId: () => 'sess-cap',
    async findTeamByCaptain(id) {
      for (const team of teams.values()) if (team.captainSessionId === id) return team.id
      return undefined
    },
    async buildTeam({ teamId, name, phase }) {
      return { teamId, name, phase: phase ?? 'staged', members: 2, tasks: 3, events: [
        { type: 'team.created', at: 1, seq: 0, name, captainSessionId: 'sess-cap' },
      ] }
    },
    async spawnMembers(teamId) { spawnCalls.push(teamId); return 2 },
    async kickTeam(teamId) { kicks.push(teamId) },
  }

  const host = createFakeHost()
  const registered = []
  host.ctx.tools = { register: definition => { registered.push(definition); return () => {} } }
  const names = installFlowTools(host.ctx, deps)
  return { host, deps, names, registered, events, teams, spawnCalls, kicks }
}

const tool = (built, name) => built.registered.find(definition => definition.name === name)
const exec = { signal: new AbortController().signal }

test('every tool is registered with the output declaration the host requires', () => {
  const built = buildTools()
  // Asserted against the rules constant rather than a literal list: the names
  // the role rules deny a member and the names actually registered have to be
  // the same set, and a copy here would let them drift apart silently.
  assert.deepEqual(built.names, [...FLOW_TOOL_NAMES])
  for (const definition of built.registered) {
    assert.ok(definition.output, `${definition.name} has no output declaration`)
    assert.deepEqual(Object.keys(definition.output).sort(), ['render', 'schema'])
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 0, `${definition.name} needs a description the model can read`)
  }
})

test('creating a team records the events that make it exist', async () => {
  const built = buildTools()
  const result = await tool(built, 'flow_create').execute({ goal: '模型求解 C 题' }, exec)
  assert.equal(result.phase, 'staged')
  assert.equal(result.members, 2)
  assert.equal(result.tasks, 3)
  assert.deepEqual(built.events.map(event => event.type), ['team.created'])
})

test('a created team id is derived from the goal and does not collide', async () => {
  const built = buildTools()
  const first = await tool(built, 'flow_create').execute({ goal: 'Solve it' }, exec)
  built.teams.set(first.teamId, { id: first.teamId })
  const second = await tool(built, 'flow_create').execute({ goal: 'Solve it' }, exec)
  assert.notEqual(second.teamId, first.teamId, 'two teams with the same goal still get distinct ids')
  assert.equal(second.teamId.startsWith(first.teamId), true)
})

test('creating without a goal is refused before anything is recorded', async () => {
  const built = buildTools()
  await assert.rejects(() => tool(built, 'flow_create').execute({ goal: '   ' }, exec), /needs a goal/)
  assert.deepEqual(built.events, [])
})

test('an explicit name becomes the team name and the id source', async () => {
  const built = buildTools()
  const result = await tool(built, 'flow_create').execute({ goal: 'the goal', name: 'Cumcm Q1' }, exec)
  assert.equal(result.name, 'Cumcm Q1')
  assert.equal(result.teamId, 'cumcm-q1')
})

test('a running team\'s plan cannot be edited', async () => {
  // Its task list is the record of what is happening; rewriting it underneath
  // live members would invalidate the attempts they hold.
  const built = buildTools({ team: { id: 'T', phase: 'running', members: [], tasks: [] } })
  await assert.rejects(
    () => tool(built, 'flow_edit_plan').execute({ teamId: 'T' }, exec),
    /only a staged plan can be edited/,
  )
  assert.deepEqual(built.events, [])
})

test('an edit that changes nothing is refused rather than recorded', async () => {
  const built = buildTools({ team: { id: 'T', phase: 'staged', members: [], tasks: [] } })
  await assert.rejects(() => tool(built, 'flow_edit_plan').execute({ teamId: 'T' }, exec), /nothing to change/)
})

test('a staged plan edit is recorded', async () => {
  const built = buildTools({
    team: { id: 'T', phase: 'staged', members: [], tasks: [] },
    planEdits: () => [{ type: 'task.created', at: 5, seq: 0, task: { subject: 's' } }],
  })
  const result = await tool(built, 'flow_edit_plan').execute({ teamId: 'T', addTasks: [{ subject: 's' }] }, exec)
  assert.equal(result.teamId, 'T')
  assert.deepEqual(built.events.map(event => event.type), ['task.created'])
})

test('editing a team the caller does not lead is refused', async () => {
  // The team is located from the caller and never from the argument: a session
  // that names a team it does not lead is refused rather than obeyed, so the
  // `teamId` a call carries is not an authority. That also covers the team that
  // does not exist at all — the caller's own state is what gets checked.
  const built = buildTools()
  await assert.rejects(
    () => tool(built, 'flow_edit_plan').execute({ teamId: 'ghost' }, exec),
    /not leading any team/,
  )
  assert.deepEqual(built.events, [], 'and nothing was recorded')
})

test('somebody else\'s plan cannot be edited', async () => {
  // The hole this closes: without the caller check, any session able to call
  // tools could rewrite any staged team's plan by naming its id.
  const built = buildTools({ team: { id: 'T', phase: 'staged', members: [], tasks: [], captainSessionId: 'someone-else' } })
  await assert.rejects(
    () => tool(built, 'flow_edit_plan').execute({ teamId: 'T' }, exec),
    /not leading any team/,
  )
  assert.deepEqual(built.events, [])
})

test('approving moves the phase and spawns the members', async () => {
  const built = buildTools({ team: { id: 'T', phase: 'staged', members: [], tasks: [] } })
  const result = await tool(built, 'flow_approve').execute({ teamId: 'T' }, exec)
  assert.equal(result.phase, 'running')
  assert.equal(result.spawned, 2)
  assert.deepEqual(built.events.map(event => event.type), ['team.phase_changed'])
  assert.equal(built.events[0].from, 'staged')
  assert.equal(built.events[0].to, 'running')
  assert.deepEqual(built.kicks, ['T'], 'and the first tasks are dispatched')
})

test('approving a running team is refused, so nobody is spawned twice', async () => {
  // A second spawn would give the same member two durable child sessions.
  const built = buildTools({ team: { id: 'T', phase: 'running', members: [], tasks: [] } })
  await assert.rejects(() => tool(built, 'flow_approve').execute({ teamId: 'T' }, exec), /already running/)
  assert.deepEqual(built.spawnCalls, [])
})

test('approving a team the caller does not lead is refused', async () => {
  const built = buildTools()
  await assert.rejects(
    () => tool(built, 'flow_approve').execute({ teamId: 'ghost' }, exec),
    /not leading any team/,
  )
  assert.deepEqual(built.spawnCalls, [], 'and nothing was started')
})

test('somebody else\'s plan cannot be approved', async () => {
  // The most consequential of the two: approval is the moment a plan becomes
  // work — members spawn and the first tasks go out. Naming a team id must not
  // be enough to start it.
  const built = buildTools({ team: { id: 'T', phase: 'staged', members: [], tasks: [], captainSessionId: 'someone-else' } })
  await assert.rejects(
    () => tool(built, 'flow_approve').execute({ teamId: 'T' }, exec),
    /not leading any team/,
  )
  assert.deepEqual(built.spawnCalls, [])
  assert.deepEqual(built.events, [])
})
