// Contract for the assembled runner: what it refuses, and what its disposal
// actually waits for.
//
// The quiescence tests are the point of this file. The host awaits whatever a
// disposer returns but cannot force it to wait for work the disposer forgot
// about, so "dispose resolved" has to mean "nothing of mine is still running".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSubagentsRunner } from '../src/runner/index.js'
import { UnsupportedHarnessError } from '../src/runner/harness-compat.js'
import { createFakeStore } from './support/fake-store.js'

const member = (name, extra = {}) => ({ id: `child-${name}`, name, joinedAt: 1, status: 'idle', ...extra })
const task = (id, extra = {}) => ({ id, subject: `s-${id}`, status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1, ...extra })
const team = extra => ({ name: 'T', id: 'T', captainSessionId: 'sess-cap', createdAt: 1, taskSeq: 0, members: [], tasks: [], ...extra })

/** A host where delivery is held open until the test releases it. */
function build(options = {}) {
  const store = createFakeStore(options.team)
  const gate = { pending: [], release: null }
  const drains = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    agents: { get: id => ({ id, status: 'idle' }) },
    subagents: {
      startContinuable: async () => ({ childId: 'child-a', messageId: 'm' }),
      interrupt: () => {},
      async followup() {
        if (options.holdDelivery === true) await new Promise(resolve => { gate.release = resolve })
        return 'msg-1'
      },
      async drainContinuableDescendants(parents) {
        drains.push(parents)
        if (options.drainEnqueues !== undefined) await options.drainEnqueues()
      },
    },
  }
  const runner = createSubagentsRunner(ctx, {
    deps: store,
    stateDir: '.dsh-flow',
    ownedParents: options.ownedParents ?? (() => []),
  })
  return { store, ctx, runner, gate, drains }
}

test('a host that cannot execute is refused at mount, not at dispatch', () => {
  // A runner that silently did nothing would look like a working deployment
  // until someone wondered why no member ever started.
  assert.throws(
    () => createSubagentsRunner({ logger: { warn: () => {} }, agents: {}, subagents: {} }, {
      deps: createFakeStore(), stateDir: '.d',
    }),
    error => {
      assert.ok(error instanceof UnsupportedHarnessError)
      // The subagent operations are checked first, so they are what gets named
      // — and all three missing ones are named at once, because fixing a wrong
      // install one error at a time is three restarts.
      assert.match(error.message, /ctx\.subagents is missing startContinuable, followup, interrupt/)
      return true
    },
  )

  // A host with the subagent service but no agent registry is the other gap.
  assert.throws(
    () => createSubagentsRunner({
      logger: { warn: () => {} },
      agents: {},
      subagents: { startContinuable: () => {}, followup: () => {}, interrupt: () => {} },
    }, { deps: createFakeStore(), stateDir: '.d' }),
    /ctx\.agents is missing get/,
  )
})

test('a dispatch reaches the scheduler and claims the task', async () => {
  const { store, runner } = build({ team: team({ members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }) })
  const outcome = await runner.run({ action: 'dispatch', teamId: 'T', memberName: 'a', parentSessionId: 'sess-cap' })
  assert.equal(outcome.outcome, 'dispatched')
  assert.deepEqual(outcome.events, [])
  assert.equal(store.teams.get('T').tasks[0].status, 'claimed')
})

test('an interrupt is forwarded with the human-facing authority', async () => {
  const { ctx, runner } = build({ team: team({ members: [member('a')], tasks: [] }) })
  let seen
  ctx.subagents.interrupt = (...args) => { seen = args }
  await runner.run({ action: 'interrupt', teamId: 'T', memberName: 'a', memberSessionId: 'child-a', parentSessionId: 'sess-cap' })
  assert.deepEqual(seen, ['child-a', { kind: 'user', parentSessionId: 'sess-cap' }])
})

test('a dispatch after dispose is refused rather than started', async () => {
  const { runner } = build({ team: team({ members: [member('a')], tasks: [] }) })
  await runner.dispose()
  const outcome = await runner.run({ action: 'dispatch', teamId: 'T', memberName: 'a', parentSessionId: 's' })
  assert.equal(outcome.outcome, 'unsupported')
  assert.match(outcome.error, /disposed/)
})

test('dispose waits for a delivery that is still in flight', async () => {
  const { runner, gate } = build({
    team: team({ members: [member('a')], tasks: [task('t1', { assignee: 'a' })] }),
    holdDelivery: true,
  })
  const dispatch = runner.run({ action: 'dispatch', teamId: 'T', memberName: 'a', parentSessionId: 'sess-cap' })
  // Let the dispatch reach the held delivery.
  await new Promise(resolve => setImmediate(resolve))

  let disposed = false
  const disposal = runner.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false, 'dispose must not resolve while a delivery is open')
  assert.equal(runner.inFlightCount() > 0, true)

  gate.release()
  await Promise.all([dispatch, disposal])
  assert.equal(disposed, true)
  assert.equal(runner.inFlightCount(), 0)
})

test('dispose drains only the parents it owns', async () => {
  // Draining everything would let one plugin's unload stop another's work.
  const parent = { id: 'sess-cap' }
  const { runner, drains } = build({ team: team({ members: [], tasks: [] }), ownedParents: () => [parent] })
  await runner.dispose()
  assert.deepEqual(drains, [[parent]])
})

test('dispose with no owned parents does not call the drain', async () => {
  const { runner, drains } = build({ team: team({ members: [], tasks: [] }) })
  await runner.dispose()
  assert.deepEqual(drains, [], 'an empty drain would be a wide, pointless call')
})

test('dispose waits for work the drain itself stirred up', async () => {
  // Draining settles callbacks, and a settled callback is work. If dispose
  // returned at the end of the drain, that work would outlive the plugin.
  let drained = false
  const { runner, ctx } = build({
    team: team({ members: [], tasks: [] }),
    ownedParents: () => [{ id: 'sess-cap' }],
    drainEnqueues: async () => {
      drained = true
      // A kick admitted just before the cutoff lands during the drain.
      await runner.run({ action: 'dispatch', teamId: 'T', memberName: 'a', parentSessionId: 'sess-cap' })
    },
  })
  ctx.subagents.followup = async () => {
    assert.equal(drained, true, 'the work starts during the drain')
    await new Promise(resolve => setTimeout(resolve, 5))
    return 'msg'
  }
  const store = runner.scheduler
  assert.ok(store !== undefined)
  await runner.dispose()
  assert.equal(runner.inFlightCount(), 0, 'and dispose waited for it')
})

test('dispose is safe to call twice and on a runner that never ran', async () => {
  const { runner } = build({ team: team({ members: [], tasks: [] }) })
  await runner.dispose()
  await runner.dispose()
  assert.equal(runner.inFlightCount(), 0)
})
