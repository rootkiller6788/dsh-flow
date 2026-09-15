// Contract for reading `.agent-teams/` as a team source.
//
// The property under test is the one that makes a migration honest rather than
// merely convenient: a team loaded from somebody else's snapshot must project
// to the state that snapshot described. Not a similar state — the same one. If
// the synthesized log disagrees with the record it came from, then the canvas
// is showing something neither source ever said.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentTeamsSource, eventsFromTeamState } from '../src/sources/source-agent-teams.js'
import { createSourceRegistry } from '../src/sources/sources.js'
import { createFlowStore } from '../src/store/index.js'
import { projectTeam, isTeamState, teamEvent } from '../src/rules/index.js'

const inert = { buildTeam: async () => {}, planEdits: () => [], spawnMembers: async () => 0, kickTeam: async () => {} }

/** A record in agent-teams' own shape, as its `team.json` holds it. */
const agentTeamsState = extra => ({
  name: '建模 Team',
  id: 'modeling',
  captainSessionId: 'sess-cap',
  createdAt: 1000,
  taskSeq: 3,
  phase: 'running',
  members: [
    { id: 'child-a', name: '建模手', role: 'scientist', joinedAt: 1001, status: 'working' },
    { id: 'child-b', name: '程序员', role: 'engineer', joinedAt: 1002, status: 'idle' },
  ],
  tasks: [
    { id: 't1', subject: 'pin it', status: 'completed', dependencies: [], attempt: 1, attemptId: 'att-1', assignee: '建模手', verdict: 'pass', output: 'pinned', createdAt: 1003, updatedAt: 1004 },
    { id: 't2', subject: 'build it', status: 'in_progress', dependencies: ['t1'], attempt: 2, attemptId: 'att-2', assignee: '程序员', createdAt: 1005, updatedAt: 1006 },
    { id: 't3', subject: 'later', status: 'pending', dependencies: [], attempt: 0, createdAt: 1007, updatedAt: 1007 },
  ],
  ...extra,
})

const readBack = state => projectTeam(eventsFromTeamState(state, 5000)).state

test('the synthesized log projects to the state the snapshot described', () => {
  const state = agentTeamsState()
  const projected = readBack(state)
  assert.ok(isTeamState(projected, projected.id))
  assert.equal(projected.name, '建模 Team')
  assert.equal(projected.phase, 'running')
  assert.deepEqual(projected.members.map(member => member.name), ['建模手', '程序员'])
  assert.deepEqual(projected.tasks.map(task => task.id), ['t1', 't2', 't3'])
})

test('each task lands on the status, attempt and assignee it was recorded with', () => {
  // Not "a plausible status": the one the record says. A migration that
  // re-derived work would leave members holding capabilities for tasks the
  // canvas draws as finished.
  const { tasks } = readBack(agentTeamsState())
  const byId = Object.fromEntries(tasks.map(task => [task.id, task]))
  assert.equal(byId.t1.status, 'completed')
  assert.equal(byId.t1.verdict, 'pass')
  assert.equal(byId.t1.output, 'pinned')
  assert.equal(byId.t2.status, 'in_progress')
  assert.equal(byId.t2.attempt, 2)
  assert.equal(byId.t2.attemptId, 'att-2')
  assert.equal(byId.t2.assignee, '程序员')
  assert.equal(byId.t3.status, 'pending')
  assert.equal(byId.t3.attempt, undefined, 'a task with no attempt keeps none')
  assert.equal(byId.t3.attemptId, undefined)
})

test('a task with no recorded capability gets none, not a fabricated one', () => {
  // A capability nothing holds is worse than a missing one: the next update
  // would be refused as stale against an id no member was ever given.
  const state = agentTeamsState({
    tasks: [{ id: 't1', subject: 'x', status: 'claimed', dependencies: [], attempt: 0, assignee: 'a', createdAt: 1, updatedAt: 1 }],
  })
  const task = readBack(state).tasks[0]
  assert.equal(task.status, 'claimed', 'the status is what the snapshot said')
  assert.equal(task.attemptId, undefined, 'and the capability is honestly absent')
})

test('a halted team comes back halted', () => {
  assert.equal(readBack(agentTeamsState({ halted: true, haltedAt: 1200 })).halted, true)
})

test('a removed member is a tombstone, as it is natively', () => {
  const state = agentTeamsState({
    members: [{ id: 'child-a', name: 'a', joinedAt: 1, status: 'removed' }],
  })
  const { members } = readBack(state)
  assert.equal(members[0].status, 'removed')
})

test('a record that is not a valid state is refused, not half-read', () => {
  // A garbled snapshot must not become a team: the canvas would render it and a
  // member would be dispatched against a task list nobody can trust.
  assert.throws(() => eventsFromTeamState({ id: 'x', name: '' }, 1), /not a valid dsh-agent-teams state/)
})

// --- the registry ----------------------------------------------------------

async function twoSources(t, agentTeams = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-sources-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const native = join(root, 'flow')
  const theirs = join(root, '.agent-teams')
  mkdirSync(native, { recursive: true })
  mkdirSync(join(theirs, 'modeling', 'inbox'), { recursive: true })
  writeFileSync(join(theirs, 'modeling', 'team.json'), JSON.stringify(agentTeamsState()))
  writeFileSync(join(theirs, 'modeling', 'inbox', 'captain.jsonl'), '{"id":"m1","from":"a","to":"captain","content":"hi","ts":1}\n')

  const { service } = createFlowStore({ root: native, hooks: inert })
  await service.createTeam('native-team')
  await service.appendEvents('native-team', [
    teamEvent('team.created', { name: 'native-team', captainSessionId: 'sess-2' }, 1000, 0),
  ])

  const registry = createSourceRegistry({
    native: service,
    ...agentTeams ? { agentTeamsRoot: theirs } : {},
  })
  return { registry, service, native, theirs }
}

test('both sources are registered, and only one of them can be appended to', async t => {
  const { registry } = await twoSources(t)
  assert.deepEqual(registry.describe().map(source => source.id), ['native', 'agent-teams'])
  assert.equal(registry.get('native').canAppend('modeling'), true)
  assert.equal(registry.get('agent-teams').canAppend('modeling'), false)
  // The query is what a caller branches on; the missing method is what makes
  // bypassing that branch an error rather than a silent write into somebody
  // else's record.
  assert.equal(typeof registry.get('agent-teams').append, 'undefined', 'read-only by construction, not by a flag')
})

test('each source says where its records come from', async t => {
  // A canvas drawing two sets of teams has to be able to say which is which;
  // during a migration that is the only thing distinguishing them.
  const { registry } = await twoSources(t)
  for (const source of registry.describe()) {
    assert.equal(typeof source.origin, 'string', `${source.id} does not say where it reads from`)
    assert.notEqual(source.origin, '')
    assert.equal(typeof source.writable, 'boolean')
  }
  assert.notEqual(registry.describe()[0].origin, registry.describe()[1].origin)
})

test('a source that cannot enumerate is not asked to', async t => {
  // "Not asked" and "asked and answered nothing" are different states, and only
  // the first is honest about a source with no notion of a team list.
  const { registry } = await twoSources(t)
  let asked = 0
  registry.register({
    id: 'listing-only',
    canEnumerate: () => false,
    enumerate: async () => { asked += 1; return [{ teamId: 'nope' }] },
  })
  assert.deepEqual((await registry.enumerate()).map(entry => entry.teamId).sort(), ['modeling', 'native-team'])
  assert.equal(asked, 0)
})

test('an id that is not a single path segment names no team', async t => {
  // Every source is asked whether it can serve an id rather than trusted to have
  // been handed a good one: an id *is* a path segment, so
  // `join(root, '../elsewhere')` reads a directory this deployment does not own.
  const { registry, theirs } = await twoSources(t)
  // A real record is planted one level up, so "refused" is distinguishable from
  // "absent" — joining the id onto the root would have found it.
  const outside = join(theirs, '..', 'modeling')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'team.json'), JSON.stringify(agentTeamsState()))

  for (const id of ['../modeling', 'a/b', 'a\\b', '..', '.', '']) {
    assert.equal(registry.get('agent-teams').canLoad(id), false, JSON.stringify(id))
    assert.equal(registry.get('native').canLoad(id), false, JSON.stringify(id))
  }
  assert.equal(registry.get('agent-teams').canLoad('modeling'), true)
  // The question is whether the *id* can name a team, not whether one is there:
  // `archive` is a well-formed segment, and whether it holds anything is what
  // `load` answers. Conflating the two would make the capability query a read.
  assert.equal(registry.get('agent-teams').canLoad('archive'), true)
  assert.equal(await registry.get('agent-teams').load('archive'), undefined)
  assert.equal(
    await registry.get('agent-teams').load('../modeling'),
    undefined,
    "the record one level up is not this source's to read",
  )
})

test('every team from every source is enumerated, tagged with where it came from', async t => {
  // The same team may exist in both during a migration, so an entry without its
  // source would be ambiguous exactly when the answer matters.
  const { registry } = await twoSources(t)
  const found = await registry.enumerate()
  assert.deepEqual(found.sort((left, right) => left.source.localeCompare(right.source)), [
    { teamId: 'modeling', source: 'agent-teams' },
    { teamId: 'native-team', source: 'native' },
  ])
})

test('a duplicate source id is refused rather than resolved', async t => {
  // Two sources claiming one id is a configuration error, and letting the later
  // one win silently would make the teams a deployment sees depend on mount
  // order.
  const { registry } = await twoSources(t)
  assert.throws(() => registry.register({ id: 'native' }), /already registered/)
})

test('a registered source can be removed by its own disposer', async t => {
  const { registry } = await twoSources(t)
  const dispose = registry.register({ id: 'extra', enumerate: async () => [] })
  assert.equal(registry.list().length, 3)
  dispose()
  assert.equal(registry.list().length, 2, 'and the registration is an effect, as the host requires')
})

test('with no agent-teams directory the source is not registered at all', async t => {
  // Not registered is different from registered-over-nothing: the first is a
  // deployment that does not use it, the second reports an empty list forever.
  const { registry } = await twoSources(t, false)
  assert.deepEqual(registry.describe().map(source => source.id), ['native'])
})

test('a migrated team loads into a log that projects to the same team', async t => {
  const { registry } = await twoSources(t)
  const events = await registry.get('agent-teams').load('modeling')
  const projected = projectTeam(events).state
  assert.ok(isTeamState(projected, projected.id))
  assert.deepEqual(projected.tasks.map(task => task.status), ['completed', 'in_progress', 'pending'])
})

test('an unrelated directory is not mistaken for a team', async t => {
  const { registry, theirs } = await twoSources(t)
  mkdirSync(join(theirs, 'archive'), { recursive: true })
  mkdirSync(join(theirs, '.mid-write'), { recursive: true })
  assert.deepEqual((await registry.get('agent-teams').enumerate()).map(entry => entry.teamId), ['modeling'])
  assert.equal(await registry.get('agent-teams').load('archive'), undefined)
})

test('an agent-teams mailbox is readable through the source', async t => {
  const { registry } = await twoSources(t)
  const messages = await registry.get('agent-teams').readMailbox('modeling', 'captain')
  assert.deepEqual(messages.map(message => message.id), ['m1'])
})
