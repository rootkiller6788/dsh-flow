// Contract for agent-scoped capability decisions.
//
// The runner installs two things per agent — a tool restriction and a prompt
// section — and must take both back when it unloads. What these tests can prove
// is that it asks for the right things and revokes them. Whether the real host
// honours the ask is not something a unit test can reach.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTeamCapabilities } from '../src/runner/capabilities.js'
import { FLOW_CAPTAIN_TOOL_NAMES, FLOW_MEMBER_TOOL_NAMES } from '../src/rules/index.js'
import { createFakeHost, createFakeAgent } from './support/fake-host.js'

const install = (host, roleOf) => installTeamCapabilities(host.ctx, {
  stateDir: '.dsh-flow', captainPrompt: 'captain instructions', roleOf,
})

test('a member is denied exactly the captain tools', () => {
  const host = createFakeHost()
  const fake = createFakeAgent('child-1')
  host.ctx.agents.list = () => [fake.agent]
  install(host, () => 'member')

  assert.equal(fake.restricted.length, 1)
  assert.deepEqual(fake.restricted[0].deny, [...FLOW_CAPTAIN_TOOL_NAMES])
  for (const name of FLOW_MEMBER_TOOL_NAMES) {
    assert.ok(!fake.restricted[0].deny.includes(name), `${name} is a member tool and must not be denied`)
  }
})

test('a captain is not restricted at all', () => {
  const host = createFakeHost()
  const fake = createFakeAgent('sess-1')
  host.ctx.agents.list = () => [fake.agent]
  install(host, () => 'captain')
  assert.deepEqual(fake.restricted, [], 'no deny list is the same as no restriction')
})

test('the prompt section tells a member the member contract', () => {
  const host = createFakeHost()
  const member = createFakeAgent('child-1')
  const captain = createFakeAgent('sess-1')
  install(host, agent => (agent.id === 'sess-1' ? 'captain' : 'member'))

  host.emit('agent/session-start', { agent: member.agent })
  host.emit('agent/session-start', { agent: captain.agent })

  assert.equal(host.calls.sections.length, 1, 'one section, not one per agent')
  const section = host.calls.sections[0]
  assert.equal(section.name, 'dsh-flow:usage')
  assert.match(section.text({ agent: member.agent }), /You are a dsh-flow member/)
  assert.match(section.text({ agent: captain.agent }), /captain instructions/)
  assert.match(section.text({ agent: undefined }), /captain instructions/, 'an unknown agent is not a member')
})

test('the role is decided once and then held', () => {
  // A team created or archived mid-conversation must not rewrite the prefix the
  // model already saw.
  const host = createFakeHost()
  const fake = createFakeAgent('child-1')
  let role = 'member'
  install(host, () => role)
  host.emit('agent/session-start', { agent: fake.agent })
  assert.equal(fake.restricted.length, 1)

  role = 'captain'
  host.emit('agent/session-start', { agent: fake.agent })
  assert.equal(fake.restricted.length, 1, 're-delivery is ignored, not re-evaluated')
  assert.deepEqual(fake.restricted[0].deny, [...FLOW_CAPTAIN_TOOL_NAMES])
})

test('a damaged role source degrades to unrelated, and says so', () => {
  const host = createFakeHost()
  const fake = createFakeAgent('child-1')
  host.ctx.agents.list = () => [fake.agent]
  install(host, () => { throw new Error('team.json is unreadable') })

  assert.deepEqual(fake.restricted, [], 'ordinary conversation keeps working')
  assert.equal(host.calls.logger.length, 1)
  assert.match(host.calls.logger[0], /capability hydration failed: Error: team\.json is unreadable/)
})

test('agents already running when the plugin mounts are attached', () => {
  const host = createFakeHost()
  const existing = createFakeAgent('child-old')
  host.ctx.agents.list = () => [existing.agent]
  install(host, () => 'member')
  assert.equal(existing.restricted.length, 1)
})

test('unloading revokes every installed capability', async () => {
  const host = createFakeHost()
  const a = createFakeAgent('child-a')
  const b = createFakeAgent('child-b')
  host.ctx.agents.list = () => [a.agent, b.agent]
  install(host, () => 'member')

  assert.equal(a.revokedCount, 0)
  await host.disposeAll()

  assert.equal(a.revokedCount, 1, 'the deny list is handed back')
  assert.equal(b.revokedCount, 1)
  assert.equal(host.listenerCount('agent/session-start'), 0, 'the listener is removed too')
})

test('walking an agent through its own lifetime disposes it once', async () => {
  const host = createFakeHost()
  const fake = createFakeAgent('child-1')
  install(host, () => 'member')
  host.emit('agent/session-start', { agent: fake.agent })

  await fake.disposeEffects()
  await fake.disposeEffects()
  assert.equal(fake.revokedCount, 1, 'disposal is idempotent')
})

test('an agent arriving after unload is not attached at all', async () => {
  // The host removes the listener when the plugin unloads, so a later agent
  // never reaches the role decision. That is the mechanism — not a flag that
  // has to be tested somewhere else.
  const host = createFakeHost()
  const late = createFakeAgent('child-late')
  install(host, () => 'member')
  await host.disposeAll()
  host.emit('agent/session-start', { agent: late.agent })
  assert.deepEqual(late.restricted, [])
})
