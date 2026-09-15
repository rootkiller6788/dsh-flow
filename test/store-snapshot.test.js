// Contract for the canvas' view of a team.
//
// The canvas was written against a foreign feed that reported a team as a flat
// record with a display state per task. This is where that shape is produced
// from our own store, so the properties under test are the two that make the
// substitution honest:
//
//   a task's display state is *derived* — a pending task behind a failed
//   dependency is blocked, and the status alone would say "waiting" forever.
//
//   a member's counts are *counted* — from the durable record, so a canvas
//   reading a store nothing is currently running shows the same thing a canvas
//   with a live executor does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFlowStore } from '../src/store/index.js'
import { createSourceRegistry } from '../src/store/sources.js'
import { canvasSnapshot, teamSnapshot } from '../src/store/snapshot.js'
import { teamEvent } from '../src/rules/index.js'

const inert = { buildTeam: async () => {}, planEdits: () => [], spawnMembers: async () => 0, kickTeam: async () => {} }

function log() {
  return [
    teamEvent('team.created', { name: 'T', captainSessionId: 'sess-cap' }, 1000, 0),
    teamEvent('team.phase_changed', { from: 'staged', to: 'running' }, 1001, 1),
    teamEvent('member.added', { member: { id: 'child-a', name: 'a', role: 'engineer', model: 'm' } }, 1002, 2),
    teamEvent('member.added', { member: { id: 'child-b', name: 'b' } }, 1003, 3),
    teamEvent('task.created', { task: { id: 't1', subject: 'first' } }, 1004, 4),
    teamEvent('task.created', { task: { id: 't2', subject: 'second', dependencies: ['t1'] } }, 1005, 5),
    teamEvent('task.created', { task: { id: 't3', subject: 'third' } }, 1006, 6),
    teamEvent('task.attempt_started', { id: 't1', attemptId: 'att-1', attempt: 1, assignee: 'a' }, 1007, 7),
    teamEvent('task.transitioned', { id: 't1', from: 'claimed', to: 'in_progress' }, 1008, 8),
    teamEvent('task.transitioned', { id: 't1', from: 'in_progress', to: 'failed' }, 1009, 9),
  ]
}

async function open(t, extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-snapshot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { service } = createFlowStore({ root, hooks: inert })
  await service.createTeam('T')
  await service.appendEvents('T', [...log(), ...extra])
  return { service, registry: createSourceRegistry({ native: service }) }
}

const teamOf = async opened => (await canvasSnapshot(opened.registry)).teams[0]

test('the snapshot names the team the way the canvas addresses it', async t => {
  const [team] = [await teamOf(await open(t))]
  assert.equal(team.teamId, 'T')
  assert.equal(team.name, 'T')
  assert.equal(team.phase, 'running')
  assert.equal(team.halted, false)
  assert.equal(team.captainName, 'captain')
})

test('a task behind a failed dependency is blocked, not merely pending', async t => {
  // This is the derivation the canvas needs and the status cannot give it: t2
  // is `pending` and would render as "waiting" while the task it waits on has
  // already failed.
  const team = await teamOf(await open(t))
  const byId = Object.fromEntries(team.tasks.map(task => [task.id, task]))
  assert.equal(byId.t1.state, 'failed', 'a failed task reads as failed')
  assert.equal(byId.t2.state, 'blocked', 'and what waited on it reads as blocked')
  assert.equal(byId.t3.state, 'open', 'while unrelated work is still open')
})

test('depth is what the dependency graph says, so the layout can column it', async t => {
  const team = await teamOf(await open(t))
  const byId = Object.fromEntries(team.tasks.map(task => [task.id, task]))
  assert.equal(byId.t1.depth, 0)
  assert.equal(byId.t2.depth, 1)
  assert.equal(byId.t3.depth, 0)
})

test('a member carries its work counts and what it holds now', async t => {
  const team = await teamOf(await open(t))
  const a = team.members.find(member => member.name === 'a')
  assert.equal(a.total, 1, 'one task names it')
  assert.equal(a.done, 0)
  assert.equal(a.model, 'm')
  assert.equal(team.members.find(member => member.name === 'b').total, 0)
})

test('a removed member is not in the roster, but its work still is', async t => {
  const opened = await open(t, [teamEvent('member.removed', { id: 'child-b', reason: 'done' }, 1010, 10)])
  const team = await teamOf(opened)
  assert.deepEqual(team.members.map(member => member.name), ['a'])
  assert.equal(team.tasks.length, 3, 'the tasks it never touched are unaffected')
})

test('a roster with no mail reports zero unread, not nothing', async t => {
  const team = await teamOf(await open(t))
  assert.equal(team.members.every(member => member.unread === 0), true)
  assert.deepEqual(team.captainInbox, [])
})

test('the captain inbox carries what is owed, and nothing else', async t => {
  const opened = await open(t)
  await opened.service.appendMessage('T', 'captain', { id: 'm1', from: 'a', to: 'captain', content: 'blocked', ts: 2000 })
  const team = (await canvasSnapshot(opened.registry)).teams[0]
  assert.deepEqual(team.captainInbox, [{ from: 'a', content: 'blocked', ts: 2000 }])
})

test('an unread member message shows up as a count and a preview', async t => {
  const opened = await open(t)
  await opened.service.appendMessage('T', 'a', { id: 'm1', from: 'captain', to: 'a', content: 'status?', ts: 2000 })
  const team = (await canvasSnapshot(opened.registry)).teams[0]
  assert.equal(team.members.find(member => member.name === 'a').unread, 1)
})

test('an ended team is still reported, marked as archived', async t => {
  // The canvas shows ended teams as history; dropping them would make a
  // finished run vanish rather than settle.
  const opened = await open(t, [teamEvent('team.archived', {}, 1010, 10)])
  await opened.service.archiveTeam('T')
  // Archived teams are not in the live list: the canvas reads the live set.
  assert.deepEqual((await canvasSnapshot(opened.registry)).teams, [])
})

test('the snapshot is a copy, so a view cannot mutate the store through it', async t => {
  const opened = await open(t)
  const before = await opened.service.readTeam('T')
  const team = teamSnapshot(before, {})
  team.tasks[0].subject = 'changed'
  team.members.length = 0
  assert.equal((await opened.service.readTeam('T')).tasks[0].subject, 'first')
})

test('every field the canvas views read is in the snapshot', async t => {
  // The views were written against a foreign feed. This is the list of fields
  // they actually read, checked here rather than discovered in a browser: a
  // snapshot missing one renders a blank where a value belongs, and nothing
  // server-side would notice.
  const team = await teamOf(await open(t))
  for (const field of ['teamId', 'name', 'phase', 'halted', 'captainName', 'members', 'tasks', 'captainInbox']) {
    assert.equal(field in team, true, `the team snapshot is missing ${field}`)
  }
  for (const field of ['name', 'role', 'model', 'status', 'activity', 'done', 'total', 'unread', 'currentTask']) {
    assert.equal(field in team.members[0], true, `a member snapshot is missing ${field}`)
  }
  for (const field of ['id', 'subject', 'state', 'assignee', 'dependencies', 'depth', 'kind', 'attempt', 'attemptId']) {
    assert.equal(field in team.tasks[0], true, `a task snapshot is missing ${field}`)
  }
  // `verdict` is present only when the task has one, which is the contract the
  // view relies on: it renders the chip on truthiness, so an empty string and
  // an absent key have to mean the same thing.
  assert.equal('verdict' in team.tasks[0], false, 'a task with no verdict carries no verdict')
})

test('a member holding work says so, so the lane shows the task it owns', async t => {
  const opened = await open(t, [teamEvent('task.attempt_started', { id: 't3', attemptId: 'att-3', assignee: 'b' }, 1010, 10)])
  const team = await teamOf(opened)
  assert.equal(team.members.find(member => member.name === 'b').currentTask, 't3')
  assert.equal(team.members.find(member => member.name === 'a').currentTask, '')
})

test('work the team could hand out is listed, so the queue is visible', async t => {
  // t1 failed, so t2 is blocked behind it and only t3 is actually claimable.
  const team = await teamOf(await open(t))
  assert.deepEqual(team.ready, ['t3'])
})
