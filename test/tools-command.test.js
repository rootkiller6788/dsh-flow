// Contract for the `/dsh-flow` slash command and the gesture boundary behind it.
//
// Two properties carry this feature, and both are about *not* doing something:
//
//   a gesture is recognised only in the newest user message — an older one has
//   already been acted on, and re-reading it would create a second team on a
//   later turn;
//
//   a named profile that does not exist is answered rather than ignored — the
//   captain must not fall back to "some team" when the user asked for a
//   specific one.
//
// The host's message factory is injected. Everything else here is pure, which is
// what lets the recognition and the wording be tested without a host at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { profileCommandName } from '../src/rules/index.js'
import {
  FLOW_COMMAND, FLOW_PROFILE_COMMAND_PREFIX, flowActivationDirective, invokedFlowCommand,
  parseFlowCommandText, profileForCommand, registerFlowCommand,
} from '../src/tools/command.js'

const PROFILES = {
  feature: { name: 'feature', description: 'ship a feature' },
  'bug fix': { name: 'bug fix' },
  report: { name: 'report', taskPlanning: 'captain' },
}

/** A user message in the host's shape. */
const fromUser = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

// --- the command namespace -------------------------------------------------

test('a profile becomes a command name only when it is representable', () => {
  // A profile key is free text a deployment chose; a command name is a closed
  // namespace. Normalising `bug fix` would have to decide what it becomes, and
  // any answer could collide it with another profile.
  assert.equal(profileCommandName('feature', FLOW_PROFILE_COMMAND_PREFIX), 'dsh-flow-feature')
  assert.equal(profileCommandName('  Feature  ', FLOW_PROFILE_COMMAND_PREFIX), 'dsh-flow-feature')
  assert.equal(profileCommandName('bug fix', FLOW_PROFILE_COMMAND_PREFIX), undefined, 'a space is not representable')
  assert.equal(profileCommandName('bug_fix', FLOW_PROFILE_COMMAND_PREFIX), undefined, 'nor an underscore')
  assert.equal(profileCommandName('修复', FLOW_PROFILE_COMMAND_PREFIX), undefined, 'nor a non-ASCII key')
  assert.equal(profileCommandName('feature-', FLOW_PROFILE_COMMAND_PREFIX), undefined, 'nor a trailing dash')
})

test('an alias resolves only when exactly one profile maps to it', () => {
  assert.equal(profileForCommand('dsh-flow-feature', PROFILES), 'feature')
  assert.equal(profileForCommand('dsh-flow-nope', PROFILES), undefined)
  // Two profiles that would share a command name means neither is reachable
  // under it, and picking one would make the other silently unaddressable.
  assert.equal(profileForCommand('dsh-flow-feature', { feature: {}, ' Feature ': {} }), undefined)
})

// --- recognition -----------------------------------------------------------

test('the generic gesture and a profile alias both parse', () => {
  assert.deepEqual(parseFlowCommandText('/dsh-flow build it', PROFILES), { goal: 'build it' })
  assert.deepEqual(parseFlowCommandText('/dsh-flow --profile feature build it', PROFILES), { goal: 'build it', profile: 'feature' })
  // The alias carries the profile in its own name, so what follows is all goal.
  assert.deepEqual(parseFlowCommandText('/dsh-flow-feature build it', PROFILES), { profile: 'feature', goal: 'build it' })
  assert.deepEqual(parseFlowCommandText('/dsh-flow-feature', PROFILES), { profile: 'feature', goal: '' })
})

test('text that is not the gesture is not recognised', () => {
  // The command name is a prefix of the aliases, so the boundary after it is
  // what keeps `/dsh-flow-feature` from parsing as the generic form with a
  // goal of `-feature`.
  for (const text of ['build it', '/dsh-flowx build', 'see /dsh-flow for details', '/other x', '', undefined]) {
    assert.equal(parseFlowCommandText(text, PROFILES), undefined, JSON.stringify(text))
  }
  assert.equal(parseFlowCommandText('/dsh-flow-nope build it', PROFILES), undefined, 'an unknown alias is not a gesture')
})

test('only the newest user message is read', () => {
  // An older gesture has already been acted on. Re-reading it would re-issue
  // something the captain has done — the difference between a command that
  // works and one that creates a second team on every later turn.
  assert.deepEqual(
    invokedFlowCommand([fromUser('/dsh-flow first'), fromUser('carry on'), fromUser('and again')], () => PROFILES),
    { goal: 'first' },
    'the only gesture present is found wherever it is',
  )
  assert.deepEqual(
    invokedFlowCommand([fromUser('/dsh-flow first'), fromUser('/dsh-flow second')], () => PROFILES),
    { goal: 'second' },
  )
})

test('messages that are not the user talking are skipped', () => {
  const assistant = { source: { kind: 'assistant' }, content: [{ type: 'text', text: '/dsh-flow from the model' }] }
  const toolOnly = { source: { kind: 'user' }, content: [{ type: 'tool-result', text: '/dsh-flow' }] }
  assert.equal(invokedFlowCommand([assistant, toolOnly], () => PROFILES), undefined)
  assert.equal(invokedFlowCommand(undefined, () => PROFILES), undefined)
})

// --- the directive ---------------------------------------------------------

test('a profile that does not exist is answered, not ignored', () => {
  // Falling back to "some team" would hand the user a roster they did not ask
  // for, and the mistake would be invisible until the plan came back wrong.
  const text = flowActivationDirective({ goal: 'ship it', profile: 'nope' }, PROFILES)
  assert.match(text, /profile "nope" does not exist/)
  assert.match(text, /feature, bug fix, report/)
  assert.match(text, /Do not create a team/)
})

test('the directive says what to do now, and stops before approval', () => {
  const text = flowActivationDirective({ goal: 'ship it', profile: 'feature' }, PROFILES)
  assert.match(text, /Goal: ship it/)
  assert.match(text, /flow_create/)
  assert.match(text, /Do not approve or start it in the same turn/)
  assert.match(text, /Do not recreate the same members or seed tasks by hand/, 'a seeded profile declares its own tasks')
})

test('a captain-planned profile is told to do the planning itself', () => {
  // The failure this prevents is a captain that was asked to derive a task
  // graph and instead asks the user whether to split the work.
  const text = flowActivationDirective({ goal: 'ship it', profile: 'report' }, PROFILES)
  assert.match(text, /derive the task graph from the goal yourself/)
  assert.match(text, /do not ask the user whether to split/)
})

test('a missing goal is asked for rather than guessed', () => {
  assert.match(flowActivationDirective({ goal: '' }, PROFILES), /ask the user what the team should accomplish/)
})

// --- registration ----------------------------------------------------------

/** A context with the things the command installs into, and nothing else. */
function fakeCtx(options = {}) {
  const listeners = new Map()
  const commandList = []
  const state = { effects: 0 }
  return {
    commands: { register: definition => { commandList.push(definition); return () => { commandList.pop() } } },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      return () => listeners.get(event)?.delete(handler)
    },
    effect(execute) {
      state.effects += 1
      return execute()
    },
    /** Every registration, in order, for the assertions below. */
    listed: commandList,
    state,
    /** Deliver one host event to the handler the command installed. */
    emit: async (event, payload, next) => {
      for (const handler of listeners.get(event) ?? []) return handler(payload, next)
      return undefined
    },
    ...options,
  }
}

test('the command and one alias per representable profile are registered', () => {
  const ctx = fakeCtx()
  registerFlowCommand(ctx, { profiles: PROFILES, createUserMessage: () => ({}) })
  assert.deepEqual(ctx.listed.map(definition => definition.name), [
    FLOW_COMMAND, 'dsh-flow-feature', 'dsh-flow-report',
  ], '`bug fix` is not representable and is skipped rather than normalised')
  assert.equal(ctx.listed[0].input.hint, '[--profile <name>] <goal>')
  assert.equal(ctx.state.effects, 1, 'the registrations are one effect, so unload removes them together')
})

test('the boundary injects the directive on the step the gesture arrives in', async () => {
  const ctx = fakeCtx()
  const injected = []
  registerFlowCommand(ctx, {
    profiles: PROFILES,
    createUserMessage: input => ({ ...input, id: 'm1' }),
  })

  const decision = await ctx.emit('agent/pre-step', { messages: [fromUser('/dsh-flow ship it')] }, async () => ({
    kind: 'enter', messages: [{ role: 'user', content: [] }],
  }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, 'the downstream messages are kept, not replaced')

  const added = decision.messages[1]
  assert.match(added.content[0].text, /Goal: ship it/)
  // The human typed a command, not this directive. A transcript that attributed
  // the directive to them would record something that never happened.
  assert.equal(added.source.kind, 'dsh-flow-command')
})

test('a step with no gesture is passed through untouched', async () => {
  const ctx = fakeCtx()
  registerFlowCommand(ctx, { profiles: PROFILES, createUserMessage: () => ({}) })
  const original = { kind: 'enter', messages: [{ role: 'user', content: [] }] }
  const decision = await ctx.emit('agent/pre-step', { messages: [fromUser('just talking')] }, async () => original)
  assert.equal(decision, original, 'the same object, so nothing downstream can tell we were here')
})

test('a rejected step stays rejected', async () => {
  const ctx = fakeCtx()
  registerFlowCommand(ctx, { profiles: PROFILES, createUserMessage: () => ({}) })
  const decision = await ctx.emit('agent/pre-step', { messages: [fromUser('/dsh-flow x')] }, async () => ({ kind: 'reject', reason: 'no' }))
  assert.deepEqual(decision, { kind: 'reject', reason: 'no' })
})

test('a malformed invocation is answered rather than thrown', async () => {
  // A listener that throws is logged and the turn proceeds, so the user would
  // watch their command do nothing and be told nothing about why.
  const ctx = fakeCtx()
  registerFlowCommand(ctx, { profiles: PROFILES, createUserMessage: input => input })
  const decision = await ctx.emit(
    'agent/pre-step',
    { messages: [fromUser('/dsh-flow --profile a --profile b goal')] },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.match(decision.messages[0].content[0].text, /could not be parsed/)
})

test('without a message factory the gesture is recognised and nothing is injected', async () => {
  // The half that needs the host is injection. Fabricating a plausible message
  // object instead would be guessing at a shape the host owns, and the guess
  // would surface as a dropped step rather than as a missing feature.
  const warnings = []
  const ctx = fakeCtx()
  registerFlowCommand(ctx, { profiles: PROFILES, createUserMessage: undefined, onWarn: message => warnings.push(message) })
  const original = { kind: 'enter', messages: [] }
  const decision = await ctx.emit('agent/pre-step', { messages: [fromUser('/dsh-flow ship it')] }, async () => original)
  assert.equal(decision, original)
  assert.equal(warnings.length, 1, 'and the deployment is told once, not once per turn')
  assert.match(warnings[0], /user-message factory is unavailable/)
})

test('a host without a command service still gets the boundary', () => {
  // The boundary is the half that carries the feature: a typed gesture arrives
  // as ordinary text whether or not the host has a palette to pick it from.
  const ctx = fakeCtx({ commands: undefined })
  assert.doesNotThrow(() => registerFlowCommand(ctx, { profiles: PROFILES, createUserMessage: () => ({}) }))
  assert.equal(ctx.state.effects, 1)
})
