// Contract for per-child member recognition and failure re-routing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memberLabel, parseMemberLabel } from '../src/runner/member-ops.js'
import { installMemberRuntime, memberSetupContribution } from '../src/runner/member-runtime.js'
import { createFakeHost } from './support/fake-host.js'

const childHost = () => createFakeHost()
const member = extra => ({ id: 'child-1', name: '建模手', joinedAt: 1, status: 'idle', ...extra })

test('a label round-trips, and the separator is unambiguous', () => {
  // The prefix ends in a colon, so `:` on both sides would make a team id
  // containing one unparseable.
  assert.equal(memberLabel('cumcm-q1', '建模手'), 'dsh-flow:cumcm-q1/建模手')
  assert.deepEqual(parseMemberLabel('dsh-flow:cumcm-q1/建模手'), { teamId: 'cumcm-q1', memberName: '建模手' })
  assert.deepEqual(parseMemberLabel('dsh-flow:a/b/c'), { teamId: 'a', memberName: 'b/c' }, 'the first separator wins')
})

test('a label that is not ours, or is malformed, is not recognised', () => {
  for (const label of ['agent-teams:t/a', 'dsh-flow:cumcm-q1', 'dsh-flow:/member', 'dsh-flow:team/', 'dsh-flow:', '', undefined, null, 42]) {
    assert.equal(parseMemberLabel(label), undefined, JSON.stringify(label))
  }
})

test('only continuable children carrying our label get a runtime', () => {
  const installed = []
  const contribute = memberSetupContribution({
    descriptorOf: child => child.descriptor,
    install: payload => { installed.push(payload); return () => {} },
  })

  contribute({}, { descriptor: { mode: 'one-shot', label: 'dsh-flow:t/a' } })
  contribute({}, { descriptor: { mode: 'continuable', label: 'agent-teams:t/a' } })
  contribute({}, { descriptor: undefined })
  assert.equal(installed.length, 0, 'none of those are our continuable members')

  const teardown = contribute({}, { descriptor: { mode: 'continuable', label: 'dsh-flow:t/a' } })
  assert.equal(installed.length, 1)
  assert.equal(installed[0].teamId, 't')
  assert.equal(installed[0].memberName, 'a')
  assert.equal(typeof teardown, 'function', 'a contribution returns its teardown')
})

function runtimeFixture(memberRecord, options = {}) {
  const host = childHost()
  const switches = []
  const settled = []
  installMemberRuntime(host.ctx, {
    teamId: 'T', memberName: '建模手',
    loadMember: async () => (options.memberMissing === true ? undefined : memberRecord),
    switchRoute: async route => { switches.push(route) },
    onFailureSettled: async payload => { settled.push(payload) },
  })
  return { host, switches, settled }
}

test('a fallbackable failure on a first-choice route switches to the fallback', async () => {
  const { host, switches, settled } = runtimeFixture(member({
    provider: 'deepseek', model: 'v4-pro', fallback: { provider: 'backup', model: 'small' },
  }))
  host.emit('agent/error', { error: { code: 'QUOTA' } })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(switches, [{ provider: 'backup', model: 'small' }])
  assert.deepEqual(settled, [{ teamId: 'T', memberName: '建模手', code: 'QUOTA' }])
})

test('a member already on its fallback is not switched again', async () => {
  // Otherwise a persistently failing provider would rotate routes forever.
  const { host, switches, settled } = runtimeFixture(member({
    provider: 'deepseek', model: 'v4-pro',
    fallback: { provider: 'backup', model: 'small' }, fallbackActive: true,
    activeProvider: 'backup', activeModel: 'small',
  }))
  host.emit('agent/error', { error: { code: 'QUOTA' } })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(switches, [], 'no second switch')
  assert.equal(settled.length, 1, 'but the failure is still recorded')
})

test('a failure a different route would not fix is recorded without switching', async () => {
  const { host, switches, settled } = runtimeFixture(member({
    provider: 'deepseek', model: 'v4-pro', fallback: { provider: 'backup', model: 'small' },
  }))
  host.emit('agent/error', { error: { code: 'BAD_REQUEST' } })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(switches, [], 'the same request would fail the same way elsewhere')
  assert.deepEqual(settled, [{ teamId: 'T', memberName: '建模手', code: 'BAD_REQUEST' }])
})

test('a failure with no code at all is still recorded', async () => {
  const { host, settled } = runtimeFixture(member({ provider: 'p', model: 'm' }))
  host.emit('agent/error', {})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(settled, [{ teamId: 'T', memberName: '建模手', code: 'UNKNOWN' }])
})

test('a member with no configured fallback is never switched', async () => {
  const { host, switches } = runtimeFixture(member({ provider: 'p', model: 'm' }))
  host.emit('agent/error', { error: { code: 'QUOTA' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(switches, [])
})

test('a member that no longer exists is left alone', async () => {
  const { host, switches, settled } = runtimeFixture(undefined, { memberMissing: true })
  host.emit('agent/error', { error: { code: 'QUOTA' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(switches, [])
  assert.deepEqual(settled, [], 'a removed member has no team to report to')
})

test('the request-error waterfall delegates rather than short-circuiting', async () => {
  // Returning without calling `next()` would stop every later listener from
  // seeing the error, which is a silent change to someone else's behaviour.
  const { host } = runtimeFixture(member({}))
  let delegated = 0
  host.emit('agent/request-error', { request: {} }, () => { delegated++ })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(delegated, 1)
})

test('a waterfall payload without next() does not throw', () => {
  const { host } = runtimeFixture(member({}))
  assert.doesNotThrow(() => host.emit('agent/request-error', { request: {} }))
})

test('both hooks die with the child', async () => {
  const { host, settled } = runtimeFixture(member({ provider: 'p', model: 'm' }))
  assert.equal(host.listenerCount('agent/error'), 1)
  await host.disposeAll()
  assert.equal(host.listenerCount('agent/error'), 0)
  assert.equal(host.listenerCount('agent/request-error'), 0)

  host.emit('agent/error', { error: { code: 'QUOTA' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(settled, [], 'a disposed runtime does not observe anything')
})
