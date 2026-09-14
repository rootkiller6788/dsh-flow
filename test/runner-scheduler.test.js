// Contract for the dispatch loop.
//
// The store and the host are both faked, so what these can prove is the
// decision, not the delivery: which member is asked to do what, when a member
// is left alone, and what a failed dispatch leaves behind. Whether the real
// service accepts the delivery is not reachable from a unit test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTeamScheduler } from '../src/runner/scheduler.js'
import { createFakeStore } from './support/fake-store.js'

const member = (name, extra = {}) => ({ id: `child-${name}`, name, joinedAt: 1, status: 'idle', ...extra })
const task = (id, extra = {}) => ({ id, subject: `s-${id}`, status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1, ...extra })
const team = extra => ({ name: 'T', id: 'T', captainSessionId: 'sess-cap', createdAt: 1, taskSeq: 0, members: [], tasks: [], ...extra })

function build(options = {}) {
  const store = createFakeStore(options.team)
  const deliveries = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    agents: {
      // No `??` fallback: a fake that cannot say "absent" cannot model
      // "no live captain", which is a case the scheduler must handle.
      get: options.agents?.get ?? (id => ({ id, status: 'idle' })),
    },
    subagents: {
      // Delivery resolves with a message id, as the real service does when the
      // child's inbox accepts the prompt.
      async followup(parent, childId, content, followupOptions) {
        if (options.deliveryFails === true) throw new Error('member is gone')
        deliveries.push({ childId, content, followupOptions })
        return `msg-${deliveries.length}`
      },
    },
  }
  const scheduler = installTeamScheduler(ctx, { deps: store, stateDir: '.dsh-flow' })
  return { store, scheduler, ctx, deliveries }
}

test('a halted team is not dispatched to', async () => {
  const { store, scheduler } = build({ team: team({ halted: true, members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }) })
  await scheduler.kickTeam('T')
  assert.equal(store.teams.get('T').tasks[0].status, 'pending', 'nothing was claimed')
})

test('a staged team is not dispatched to', async () => {
  const { store, scheduler } = build({ team: team({ phase: 'staged', members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }) })
  await scheduler.kickTeam('T')
  assert.equal(store.teams.get('T').tasks[0].status, 'pending')
})

test('without a live captain nothing is dispatched', async () => {
  const { store, scheduler } = build({
    team: team({ members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }),
    agents: { get: id => (id === 'sess-cap' ? undefined : { id, status: 'idle' }) },
  })
  await scheduler.kickTeam('T')
  assert.equal(store.teams.get('T').tasks[0].status, 'pending')
})

test('a captain still running is not interrupted with a kick', async () => {
  const { store, scheduler } = build({
    team: team({ members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }),
    agents: { get: id => ({ id, status: id === 'sess-cap' ? 'running' : 'idle' }) },
  })
  await scheduler.kickTeam('T')
  assert.equal(store.teams.get('T').tasks[0].status, 'pending')
})

test('a removed member, or one that has not been spawned, is skipped', async () => {
  for (const [label, m] of [['removed', member('a', { status: 'removed' })], ['unspawned', { ...member('a'), id: '' }]]) {
    const { store, scheduler } = build({ team: team({ members: [m], tasks: [task('t1', { assignee: 'a' })] }) })
    await scheduler.kickTeam('T')
    assert.equal(store.teams.get('T').tasks[0].status, 'pending', `${label} must not be given work`)
  }
})

test('a busy member is not given a second task', async () => {
  const { store, scheduler } = build({
    team: team({ members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }),
    agents: { get: id => ({ id, status: id === 'child-a' ? 'running' : 'idle' }) },
  })
  await scheduler.kickTeam('T')
  assert.equal(store.teams.get('T').tasks[0].status, 'pending')
})

test('a successful dispatch claims the task and marks the member working', async () => {
  const { store, scheduler } = build({ team: team({ members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }) })
  await scheduler.kickTeam('T')
  const claimed = store.teams.get('T').tasks[0]
  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.assignee, 'a')
  assert.equal(claimed.attempt, 1)
  assert.ok(claimed.attemptId)
  assert.equal(store.teams.get('T').members[0].status, 'working')
})

test('an owned unfinished attempt is preferred over fresh work', async () => {
  // Otherwise a member that briefly went idle is handed a second task while its
  // first is still open.
  const { store, scheduler } = build({
    team: team({
      members: [member('a')],
      tasks: [task('t1', { status: 'in_progress', assignee: 'a', attemptId: 'live' }), task('t2', { assignee: 'a' })],
    }),
  })
  await scheduler.kickTeam('T')
  const tasks = store.teams.get('T').tasks
  assert.equal(tasks[0].attempt, 1, 'the recovery starts the generation counter')
  assert.notEqual(tasks[0].attemptId, 'live', 'and mints a new capability')
  assert.equal(tasks[1].status, 'pending', 'fresh work waits')
})

test('an attempt this process watched go idle is parked, not recovered', async () => {
  const initial = team({ members: [member('a')], tasks: [task('t1', { status: 'in_progress', assignee: 'a', attemptId: 'att-1' })] })
  const { store, scheduler } = build({ team: initial })

  scheduler.noteMemberIdle('child-a', store.teams.get('T'))
  assert.equal(scheduler.parkedCount(), 1)

  await scheduler.kickTeam('T')
  assert.equal(store.teams.get('T').tasks[0].attemptId, 'att-1', 'a parked attempt is not re-dispatched')
})

test('a durable attempt this process never saw gets one cold recovery', async () => {
  // A fresh process has an empty parked map, which is exactly what makes
  // restart recovery happen at all.
  const { store, scheduler } = build({
    team: team({ members: [member('a')], tasks: [task('t1', { status: 'claimed', assignee: 'a', attemptId: 'from-a-previous-process' })] }),
  })
  await scheduler.kickTeam('T')
  const recovered = store.teams.get('T').tasks[0]
  assert.equal(recovered.attempt, 1)
  assert.notEqual(recovered.attemptId, 'from-a-previous-process')
})

test('a member with nothing to do is reset to idle', async () => {
  const { store, scheduler } = build({ team: team({ members: [member('a', { status: 'working' })], tasks: [] }) })
  await scheduler.kickTeam('T')
  assert.equal(store.teams.get('T').members[0].status, 'idle')
})

test('kicks for the same member are serialized, not interleaved', async () => {
  const { store, scheduler } = build({ team: team({ members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }) })
  await Promise.all([scheduler.kickTeam('T'), scheduler.kickTeam('T'), scheduler.kickTeam('T')])
  // Serialized, not deduplicated: the first kick starts a fresh attempt, the
  // second sees an owned attempt it has not parked and recovers it once, and
  // the third is stopped by the parking. Three attempts would mean the queue
  // was not serializing; one would mean recovery never happens.
  const t1 = store.teams.get('T').tasks[0]
  assert.equal(t1.attempt, 2, `expected one start plus one recovery, saw ${t1.attempt} attempt(s)`)
  assert.equal(scheduler.parkedCount(), 1, 'and the third kick is stopped by the parking')
})

test('a missing team is a no-op, not an error', async () => {
  const { scheduler } = build({ team: undefined })
  await scheduler.kickTeam('nope')
  await scheduler.kickMember('nope', 'a')
})

test('the assignment prompt is what actually gets delivered', async () => {
  const { store, scheduler, deliveries } = build({ team: team({ members: [member('a')], tasks: [task('t1', { assignee: 'a', objective: 'pin it' })] }) })
  await scheduler.kickTeam('T')
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].childId, 'child-a')
  const text = deliveries[0].content[0].text
  assert.match(text, /Task: t1/)
  assert.match(text, /Objective: pin it/)
  assert.match(text, /attempt_id=att-1/, 'the prompt carries the capability it must present back')
  assert.equal(deliveries[0].followupOptions.source.plugin, 'dsh-flow')
})

test('a failed delivery rolls the task back and records why', async () => {
  const { store, scheduler } = build({
    team: team({ members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }),
    deliveryFails: true,
  })
  await scheduler.kickTeam('T')
  const rolled = store.teams.get('T').tasks[0]
  assert.equal(rolled.status, 'pending', 'fresh work returns to the pool')
  assert.equal(rolled.attemptId, undefined, 'and its capability is revoked')
  assert.equal(store.teams.get('T').members[0].status, 'idle')
  assert.deepEqual(store.events.map(event => event.type), ['task.attempt_failed', 'task.rolled_back'])
  assert.match(store.events[1].reason, /dispatch failed: Error: member is gone/)
})

test('a failed recovery restores the previous generation instead of the pool', async () => {
  // Returning it to pending would let every later kick spend another fresh
  // attempt on a member that is simply not there.
  const { store, scheduler } = build({
    team: team({ members: [member('a')], tasks: [task('t1', { status: 'in_progress', assignee: 'a', attempt: 3, attemptId: 'original' })] }),
    deliveryFails: true,
  })
  await scheduler.kickTeam('T')
  const restored = store.teams.get('T').tasks[0]
  assert.equal(restored.status, 'in_progress')
  assert.equal(restored.attempt, 3)
  assert.equal(restored.attemptId, 'original')
  assert.equal(scheduler.parkedCount(), 1, 'and stays parked so it is not retried endlessly')
})
