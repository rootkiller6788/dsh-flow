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

/**
 * A continuable child, with the agent-scoped context the host gives every real
 * one. The runtime is installed on the child, not on the plugin, so a fake
 * without one is a fake the runner cannot be driven against at all.
 */
function fakeChild(id, label) {
  const listeners = new Map()
  const child = {
    id,
    session: { header: { label } },
    ctx: {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(handler)
        return () => listeners.get(event)?.delete(handler)
      },
      effect(execute) {
        return execute()
      },
    },
  }
  return {
    child,
    listenerCount: event => listeners.get(event)?.size ?? 0,
    async emit(event, payload, next) {
      for (const handler of [...(listeners.get(event) ?? [])]) await handler(payload, next)
    },
  }
}

/** A host where delivery is held open until the test releases it. */
function build(options = {}) {
  const store = createFakeStore(options.team)
  const gate = { pending: [], release: null }
  const drains = []
  const admissions = []
  const listeners = new Map()
  let admitting = true
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      return () => listeners.get(event)?.delete(handler)
    },
    effect(execute) {
      return execute()
    },
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
      registerContinuableSetup(setup) {
        admissions.push(setup)
        // The host owns this registration with an effect, so unloading revokes
        // admission even while the service stays live. Modelling it as a flag
        // is what makes "no child is admitted after dispose" checkable.
        return () => { admitting = false; admissions.length = 0 }
      },
    },
  }
  const runner = createSubagentsRunner(ctx, {
    deps: store,
    stateDir: '.dsh-flow',
    ownedParents: options.ownedParents ?? (() => []),
  })
  /** Hand one child to the host's admission hook, the way the host would. */
  const admit = child => {
    for (const setup of admissions) setup(child.ctx, child)
    return admitting
  }
  /**
   * Report a member's status, the way the host does.
   *
   * The listener is deliberately fire-and-forget — the host does not await it —
   * so the test has to let the work it started settle before asserting.
   */
  const emitStatus = async (id, status) => {
    for (const handler of listeners.get('agent/status') ?? []) handler({ agent: { id }, status })
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return { store, ctx, runner, gate, drains, admissions, admit, emitStatus }
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

// --- per-member runtime ----------------------------------------------------

/** A member holding one claimed attempt, which is what a failure has to undo. */
const holding = extra => team({
  members: [member('a', { status: 'working', ...extra })],
  tasks: [task('t1', { status: 'claimed', assignee: 'a', attempt: 1, attemptId: 'att-old' })],
})

test('a child is admitted as a member by its label, and nothing else is', () => {
  // Admission rather than discovery. Installed here, the member has its failure
  // handling before its first request; installed on some later signal, that
  // first request can already have failed with nothing watching it.
  const { admissions, admit } = build({ team: team({ members: [member('a')], tasks: [] }) })
  assert.equal(admissions.length, 1, 'the host hook was taken')

  const ours = fakeChild('child-a', 'dsh-flow:T/a')
  admit(ours.child)
  assert.equal(ours.listenerCount('agent/error'), 1)
  assert.equal(ours.listenerCount('agent/request-error'), 1)

  // A foreign continuable child, and one with no label at all, are left alone.
  // The label is the only thing that says a session is one of our members —
  // guessing from anything else would attach this runtime to somebody else's
  // work.
  const theirs = fakeChild('child-b', 'agent-teams:T/b')
  assert.equal(admit(theirs.child), true)
  const bare = fakeChild('child-c', undefined)
  admit(bare.child)
  assert.equal(theirs.listenerCount('agent/error'), 0)
  assert.equal(bare.listenerCount('agent/error'), 0)
})

test('a turn that died gives its work back and the team is dispatched again', async () => {
  // The scheduler's other recovery path waits for an idle edge. A turn that
  // ended in a terminal error may never produce one, so the failure has to
  // record the loss and kick on its own rather than wait to be noticed.
  const { store, admit } = build({ team: holding() })
  const ours = fakeChild('child-a', 'dsh-flow:T/a')
  admit(ours.child)

  await ours.emit('agent/error', { error: { code: 'SERVER_ERROR' } })

  const rollback = store.events.find(event => event.type === 'task.rolled_back')
  assert.ok(rollback !== undefined, 'the loss is in the log, not only in memory')
  assert.equal(rollback.reason, 'member turn failed')
  assert.equal(rollback.code, 'SERVER_ERROR')
  assert.equal(rollback.toStatus, 'pending', 'the work went back to the pool')

  // And it did not merely sit there: the kick that follows the record handed it
  // back out, on a new generation.
  const task = store.teams.get('T').tasks[0]
  assert.equal(task.status, 'claimed')
  assert.equal(task.attempt, 2)
  assert.notEqual(task.attemptId, 'att-old', 'a fresh capability, so a late update with the old one is refused')
})

test('a fallbackable failure moves the member to its fallback route', async () => {
  const { store, admit } = build({
    team: holding({ provider: 'deepseek', model: 'v4-pro', fallback: { provider: 'backup', model: 'small' } }),
  })
  const ours = fakeChild('child-a', 'dsh-flow:T/a')
  admit(ours.child)

  await ours.emit('agent/error', { error: { code: 'QUOTA' } })

  const record = store.teams.get('T').members[0]
  assert.equal(record.activeProvider, 'backup')
  assert.equal(record.activeModel, 'small')
  assert.equal(record.fallbackActive, true)
  // The configured route is what was asked for; the active one is what is
  // happening. Overwriting the former would destroy the intent the fallback
  // exists to preserve.
  assert.equal(record.provider, 'deepseek')
  assert.equal(record.model, 'v4-pro')
})

test('a failure that a different route would not fix is not a route change', async () => {
  const { store, admit } = build({
    team: holding({ provider: 'deepseek', model: 'v4-pro', fallback: { provider: 'backup', model: 'small' } }),
  })
  const ours = fakeChild('child-a', 'dsh-flow:T/a')
  admit(ours.child)

  await ours.emit('agent/error', { error: { code: 'BAD_REQUEST' } })

  const record = store.teams.get('T').members[0]
  assert.equal(record.activeProvider, undefined, 'the same request would fail the same way elsewhere')
  assert.equal(store.events.find(event => event.type === 'task.rolled_back')?.code, 'BAD_REQUEST',
    'but the loss is still recorded')
})

test('a member holding nothing has no attempt to give back', async () => {
  // The ordinary case, not a degenerate one: a turn can fail while the member
  // owns no work. Minting an attempt to roll back would put a failure in the log
  // that no task ever had.
  const { store, admit } = build({ team: team({ members: [member('a', { status: 'idle' })], tasks: [] }) })
  const ours = fakeChild('child-a', 'dsh-flow:T/a')
  admit(ours.child)

  await ours.emit('agent/error', { error: { code: 'QUOTA' } })

  assert.deepEqual(store.events, [])
  assert.equal(store.teams.get('T').members[0].fallbackActive, undefined, 'and nothing was switched either')
})

test('dispose stops admitting members', async () => {
  // Admission is an effect the host revokes on unload. A child admitted during
  // the drain would be handed a runtime this disposer then has to reach into a
  // second time, after it has already said it was finished.
  const { runner, admit } = build({ team: team({ members: [member('a')], tasks: [] }) })
  await runner.dispose()

  const late = fakeChild('child-late', 'dsh-flow:T/a')
  admit(late.child)
  assert.equal(late.listenerCount('agent/error'), 0)
})

// --- the idle edge ---------------------------------------------------------

test('a member that goes idle keeps the attempt it already holds', async () => {
  // The parking marker. Without it every status change would treat the member's
  // still-open attempt as recoverable, mint a fresh capability underneath it,
  // and invalidate the one the member is working with.
  const { store, emitStatus } = build({ team: holding() })
  await emitStatus('child-a', 'idle')

  const task = store.teams.get('T').tasks[0]
  assert.equal(task.attemptId, 'att-old', 'the capability it holds is untouched')
  assert.equal(task.attempt, 1, 'and no new generation was minted')
  assert.equal(store.teams.get('T').members[0].status, 'idle', 'while the recorded status follows the host')
})

test('a member that goes idle is handed the next task it can take', async () => {
  // There is no timer anywhere in this scheduler, so this edge is the only thing
  // that picks work back up after a turn ended. Without a kick here, finishing a
  // task would leave the next one waiting for a human to notice.
  const { store, emitStatus } = build({
    team: team({
      members: [member('a', { status: 'working' })],
      tasks: [
        task('t1', { status: 'completed', assignee: 'a', attempt: 1, attemptId: 'att-1' }),
        task('t2', { assignee: 'a' }),
      ],
    }),
  })
  await emitStatus('child-a', 'idle')

  const next = store.teams.get('T').tasks[1]
  assert.equal(next.status, 'claimed', 'the queued work went out on the idle edge')
  assert.equal(next.assignee, 'a')
})

test('a status for an agent that is not in any team is ignored', async () => {
  // The host reports every agent it has. Acting on one that belongs to another
  // plugin's team would be this scheduler writing into somebody else's record.
  const { store, emitStatus } = build({ team: team({ members: [member('a')], tasks: [] }) })
  await emitStatus('stranger', 'idle')
  assert.equal(store.teams.get('T').members[0].status, 'idle')
  assert.deepEqual(store.events, [])
})
