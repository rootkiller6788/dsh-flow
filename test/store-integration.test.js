// The dispatch loop against the real store, on a real filesystem.
//
// The scheduler was ported from agent-teams and mutates a record in place
// before saving it; the store derives everything from an append-only log. Those
// two models only fit together because `writeTeam` reconciles the difference,
// and this is the test that says so — every scenario below runs the actual
// ported code against the actual store and then checks what a *second* store
// instance reads back from disk.
//
// A fake store cannot answer that question. It stores object identity, so a
// mutation is "saved" by doing nothing, which is exactly the bug this covers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installTeamScheduler } from '../src/runner/scheduler.js'
import { createFlowStore } from '../src/store/index.js'
import { EVENTS_FILE, STATE_FILE } from '../src/store/team-store.js'
import { teamEvent } from '../src/rules/index.js'

/** Hooks the store demands but these scenarios never reach. */
const inert = { buildTeam: async () => {}, planEdits: () => [], spawnMembers: async () => 0, kickTeam: async () => {} }

/** A log that produces a running team with one member and one task. */
function runningLog() {
  return [
    teamEvent('team.created', { name: 'T', captainSessionId: 'sess-cap' }, 1000, 0),
    teamEvent('team.phase_changed', { from: 'staged', to: 'running' }, 1001, 1),
    teamEvent('member.added', { member: { id: 'child-a', name: 'a', role: 'engineer' } }, 1002, 2),
    teamEvent('task.created', { task: { subject: 'one', objective: 'pin it' } }, 1003, 3),
  ]
}

async function build(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-integration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const opened = createFlowStore({ root, hooks: inert })
  await opened.store.createTeam('T')
  await opened.service.appendEvents('T', options.events ?? runningLog())

  const deliveries = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    agents: { get: id => ({ id, status: 'idle' }) },
    subagents: {
      async followup(parent, childId, content, followupOptions) {
        if (options.deliveryFails === true) throw new Error('member is gone')
        deliveries.push({ childId, content, followupOptions })
        return `msg-${deliveries.length}`
      },
    },
  }
  const scheduler = installTeamScheduler(ctx, { deps: opened.runnerDeps, stateDir: '.dsh-flow' })
  const captain = { id: 'sess-cap', status: 'idle' }

  // A second handle over the same directory: whatever it sees is what the log
  // says, not what this process happens to be holding in memory.
  const reopened = createFlowStore({ root, hooks: inert })
  return { root, opened, reopened, scheduler, deliveries, captain }
}

const types = events => events.map(event => event.type)

test('a dispatch is recorded as events, and survives being read back from disk', async t => {
  const { scheduler, reopened, root } = await build(t)
  await scheduler.kickTeam('T')

  const team = await reopened.service.readTeam('T')
  assert.equal(team.tasks[0].status, 'claimed')
  assert.equal(team.tasks[0].assignee, 'a')
  assert.equal(team.tasks[0].attempt, 1)
  assert.ok(team.tasks[0].attemptId, 'the capability is on disk, not only in memory')
  assert.equal(team.members[0].status, 'working')

  const recorded = await reopened.service.readTeamEvents('T')
  assert.deepEqual(types(recorded).slice(-2), ['member.updated', 'task.attempt_started'])
  assert.match(readFileSync(join(root, 'T', EVENTS_FILE), 'utf8'), /"type":"task\.attempt_started"/)
})

test('a member with nothing to do is recorded as idle, not merely set idle', async t => {
  const { scheduler, reopened } = await build(t, {
    events: [
      teamEvent('team.created', { name: 'T', captainSessionId: 'sess-cap' }, 1000, 0),
      teamEvent('member.added', { member: { id: 'child-a', name: 'a' } }, 1001, 1),
      teamEvent('member.updated', { id: 'child-a', patch: { status: 'working' } }, 1002, 2),
    ],
  })
  await scheduler.kickTeam('T')
  assert.equal((await reopened.service.readTeam('T')).members[0].status, 'idle')
  assert.deepEqual(types(await reopened.service.readTeamEvents('T')), [
    'team.created', 'member.added', 'member.updated', 'member.updated',
  ])
})

test('a failed dispatch leaves the rollback in the log, and the state agrees with it', async t => {
  const { scheduler, reopened } = await build(t, { deliveryFails: true })
  await scheduler.kickTeam('T')

  const team = await reopened.service.readTeam('T')
  assert.equal(team.tasks[0].status, 'pending', 'the work went back to the pool')
  assert.equal(team.tasks[0].attemptId, undefined, 'and the capability with it')
  assert.equal(team.tasks[0].assignee, undefined, 'nobody holds a task in the pool')
  assert.equal(team.members[0].status, 'idle')

  const recorded = await reopened.service.readTeamEvents('T')
  assert.deepEqual(types(recorded).slice(-3), ['task.attempt_failed', 'task.rolled_back', 'member.updated'])
  const rolled = recorded.at(-2)
  assert.match(rolled.reason, /dispatch failed/)
  assert.equal(rolled.assignee, null, 'the rollback says the task went back to the pool')
  assert.equal(rolled.attempt, 1, 'and the counter still records that the attempt happened')
})

test('a failed recovery restores the previous generation in the log too', async t => {
  // The case the reconcile was built for: the caller restores fields the events
  // have to carry, and the state after a reload must be the restored generation
  // rather than the one that just failed.
  const { scheduler, reopened } = await build(t, {
    deliveryFails: true,
    events: [
      teamEvent('team.created', { name: 'T', captainSessionId: 'sess-cap' }, 1000, 0),
      teamEvent('member.added', { member: { id: 'child-a', name: 'a' } }, 1001, 1),
      teamEvent('task.created', { task: { subject: 'one' } }, 1002, 2),
      teamEvent('task.attempt_started', { id: 't1', attemptId: 'original', attempt: 3, assignee: 'a' }, 1003, 3),
      teamEvent('member.updated', { id: 'child-a', patch: { status: 'working' } }, 1004, 4),
    ],
  })
  await scheduler.kickTeam('T')

  const team = await reopened.service.readTeam('T')
  assert.equal(team.tasks[0].status, 'claimed', 'the previous generation is back')
  assert.equal(team.tasks[0].attempt, 3, 'on the generation counter it was on')
  assert.equal(team.tasks[0].attemptId, 'original', 'holding the capability it held')
  assert.equal(team.tasks[0].assignee, 'a', 'and its owner')
  assert.equal(team.members[0].status, 'idle')
  assert.equal(scheduler.parkedCount(), 1, 'stays parked, so it is not retried endlessly')

  const recorded = await reopened.service.readTeamEvents('T')
  const rolled = recorded.at(-2)
  assert.equal(rolled.toStatus, 'claimed', 'and the log is what said so, not the caller')
  assert.equal(rolled.assignee, 'a')
  assert.equal(rolled.attempt, 3)
})

test('counting attempts is what the log is for', async t => {
  // agent-teams leaves a monotonic counter, so it can say how many attempts
  // happened but never what became of any of them. Here each one is a fact that
  // outlives the state it came from.
  const { scheduler, reopened } = await build(t, { deliveryFails: true })
  await scheduler.kickTeam('T')
  await scheduler.kickTeam('T')

  const recorded = await reopened.service.readTeamEvents('T')
  const failures = recorded.filter(event => event.type === 'task.attempt_failed')
  const rollbacks = recorded.filter(event => event.type === 'task.rolled_back')
  assert.equal(failures.length, 2, 'both failures are still readable after the fact')
  assert.equal(rollbacks.length, 2)
  assert.deepEqual(failures.map(event => event.attemptId).filter(id => id !== undefined).length, 2,
    'each naming the capability it revoked')

  // The record alone says "two attempts happened". Only the log says both of
  // them failed and why, which is the difference the two models are about.
  const team = await reopened.service.readTeam('T')
  assert.equal(team.tasks[0].attempt, 2)
  assert.equal(team.tasks[0].status, 'pending', 'and it is back in the pool either way')
})

test('a halted team is not dispatched to, so its log stays untouched', async t => {
  const { scheduler, opened, reopened } = await build(t)
  await opened.service.appendEvents('T', [teamEvent('team.halted', { reason: 'hold' }, 1004, 4)])
  const before = types(await reopened.service.readTeamEvents('T'))

  await scheduler.kickTeam('T')
  assert.deepEqual(types(await reopened.service.readTeamEvents('T')), before)
  assert.deepEqual(await reopened.service.readTeam('T').then(team => team.tasks[0].status), 'pending')
})

test('unread mail is delivered, leased and acknowledged, and the inbox is a file', async t => {
  const { opened, scheduler, deliveries, captain } = await build(t)
  // The log records that a message was *sent*; the mailbox records whether it
  // was delivered. Two stores, because they answer two different questions.
  await opened.mail.appendMessage('T', 'a', { id: 'm1', from: 'captain', to: 'a', content: 'status?', ts: 2000 })

  await scheduler.kickMember('T', 'a', captain)

  const delivered = deliveries.at(-1)
  assert.ok(delivered !== undefined, 'the member was told')
  assert.match(delivered.content[0].text, /status\?/)

  const [message] = await opened.mail.readMailbox('T', 'a')
  assert.equal(message.readAt !== undefined, true, 'and it is acknowledged rather than re-delivered')
  assert.deepEqual(await opened.mail.readUnreadMailbox('T', 'a'), [])
  assert.deepEqual((await opened.service.readTeam('T')).tasks[0].status, 'pending', 'mail comes before new work')
})

test('the capability the prompt carries is the one the log recorded', async t => {
  const { scheduler, deliveries, reopened } = await build(t)
  await scheduler.kickTeam('T')
  const team = await reopened.service.readTeam('T')
  assert.match(deliveries[0].content[0].text, new RegExp(`attempt_id=${team.tasks[0].attemptId}`))
})

test('a mutation with no event behind it is refused, not dropped', async t => {
  // `writeTeam` reconciles, so a field the log has no vocabulary for is an
  // error. Dropping it would recreate the failure the log exists to prevent: a
  // change that happened and left no trace.
  const { opened, reopened } = await build(t)
  const team = await opened.service.readTeam('T')
  team.tasks[0].acceptance = ['invented after the fact']
  await assert.rejects(() => opened.runnerDeps.writeTeam(team), /cannot express/)
  assert.equal((await reopened.service.readTeam('T')).tasks[0].acceptance, undefined, 'and nothing was recorded')
})

test('a save that changes nothing records nothing', async t => {
  // The dispatch loop calls `writeTeam` on paths that changed nothing, and a
  // reconcile that invented an event there would bury the real ones.
  const { opened, reopened } = await build(t)
  const before = await reopened.service.readTeamEvents('T')
  await opened.runnerDeps.writeTeam(await opened.service.readTeam('T'))
  assert.deepEqual(await reopened.service.readTeamEvents('T'), before)
})

test('the checkpoint is disposable: deleting it costs one replay', async t => {
  const { scheduler, root, reopened, opened } = await build(t)
  await scheduler.kickTeam('T')
  const fromLog = await opened.service.readTeam('T')

  rmSync(join(root, 'T', STATE_FILE))
  assert.deepEqual(await reopened.service.readTeam('T'), fromLog)
})

test('a store without its hooks refuses to mount', () => {
  // A plugin that loads and then fails the first time the model calls a tool is
  // a plugin whose failure gets attributed to the model.
  assert.throws(
    () => createFlowStore({ root: '.', hooks: { buildTeam: async () => {} } }),
    /planEdits hook/,
  )
})
