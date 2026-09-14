// Contract for the member operations, against a recording fake.
//
// What these can prove: the right host operation is called with the right
// arguments — in particular that a member is never driven through the captain's
// own conversational handles. What they cannot prove: that the real service
// accepts those arguments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMBER_LABEL_PREFIX, textBlocks, memberLabel,
  spawnMember, deliverToMember, interruptMember, steerCaptainReport,
} from '../src/runner/member-ops.js'

function fakeSubagents() {
  const calls = { startContinuable: [], followup: [], interrupt: [] }
  return {
    calls,
    async startContinuable(spec) { calls.startContinuable.push(spec); return { childId: 'child-1', messageId: 'msg-1' } },
    async followup(...args) { calls.followup.push(args); return 'msg-2' },
    interrupt(...args) { calls.interrupt.push(args) },
  }
}

const parent = { id: 'sess-cap' }
const signal = new AbortController().signal

test('a prompt is a content-block list, not a string', () => {
  assert.deepEqual(textBlocks('hello'), [{ type: 'text', text: 'hello' }])
  assert.deepEqual(textBlocks(42), [{ type: 'text', text: '42' }])
})

test('a member label is namespaced so it cannot be mistaken for another plugin\'s', () => {
  assert.equal(MEMBER_LABEL_PREFIX, 'dsh-flow:')
  assert.equal(memberLabel('cumcm-q1', '建模手'), 'dsh-flow:cumcm-q1/建模手')
})

test('spawning passes a continuable spec with the documented fields only', async () => {
  const subagents = fakeSubagents()
  const result = await spawnMember({ subagents }, { provider: 'in-process', teamId: 'T', memberName: '建模手', parent, prompt: 'do it', signal })

  const spec = subagents.calls.startContinuable[0]
  assert.deepEqual(Object.keys(spec).sort(), ['label', 'provider', 'request', 'signal'])
  assert.equal(spec.provider, 'in-process')
  assert.equal(spec.label, 'dsh-flow:T/建模手')
  assert.equal(spec.signal, signal)
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'do it' }])
  assert.equal(spec.request.parent, parent)
  assert.ok(!('outputSchema' in spec.request), 'outputSchema is excluded from the continuable path')
  assert.ok(!('label' in spec.request), 'the label belongs on the spec, not the request')
  assert.ok(!('signal' in spec.request), 'the signal belongs on the spec, not the request')
  assert.deepEqual(result, { childId: 'child-1', messageId: 'msg-1' })
})

test('optional spawn fields are omitted rather than passed as undefined', async () => {
  const subagents = fakeSubagents()
  await spawnMember({ subagents }, { provider: 'p', teamId: 'T', memberName: 'a', parent, prompt: 'x', signal })
  const spec = subagents.calls.startContinuable[0]
  assert.ok(!('persona' in spec.request))
  assert.ok(!('agentOptions' in spec.request))

  await spawnMember({ subagents }, { provider: 'p', teamId: 'T', memberName: 'a', parent, prompt: 'x', signal, persona: 'you are', agentOptions: { model: 'm' } })
  const full = subagents.calls.startContinuable[1]
  assert.equal(full.request.persona, 'you are')
  assert.deepEqual(full.request.agentOptions, { model: 'm' })
})

test('delivery goes through the subagent service, never the captain\'s own handles', async () => {
  // Driving a member through `parent.followup` would land the work in the
  // captain's turn, which looks like success and is not.
  const subagents = fakeSubagents()
  let captainHandlesTouched = 0
  const watchedParent = { id: 'sess-cap', followup: () => { captainHandlesTouched++ }, steer: () => { captainHandlesTouched++ } }

  const messageId = await deliverToMember({ subagents }, { parent: watchedParent, childId: 'child-1', text: 'status?', signal })

  assert.equal(messageId, 'msg-2')
  assert.equal(captainHandlesTouched, 0)
  const [passedParent, childId, content, options] = subagents.calls.followup[0]
  assert.equal(passedParent, watchedParent)
  assert.equal(childId, 'child-1')
  assert.deepEqual(content, [{ type: 'text', text: 'status?' }])
  assert.deepEqual(options.source, { kind: 'plugin', plugin: 'dsh-flow' })
  assert.equal(options.signal, signal)
})

test('an interrupt carries the human-facing authority, not the caller identity', () => {
  const subagents = fakeSubagents()
  interruptMember({ subagents }, { targetSessionId: 'child-1', parentSessionId: 'sess-cap' })
  assert.deepEqual(subagents.calls.interrupt[0], ['child-1', { kind: 'user', parentSessionId: 'sess-cap' }])
})

test('an interrupt may be authorised by the live ancestor instead', () => {
  const subagents = fakeSubagents()
  const ancestor = { id: 'sess-cap' }
  interruptMember({ subagents }, { targetSessionId: 'child-1', ancestor })
  assert.deepEqual(subagents.calls.interrupt[0], ['child-1', { kind: 'ancestor', agent: ancestor }])
})

test('a report is steered into the captain, and a dead captain reports failure', () => {
  const steered = []
  assert.equal(steerCaptainReport({ steer: message => steered.push(message) }, '建模手', 'done'), true)
  assert.deepEqual(steered[0].content, [{ type: 'text', text: 'dsh-flow message from member 建模手:\n\ndone' }])
  assert.deepEqual(steered[0].source, { kind: 'plugin', plugin: 'dsh-flow' })

  assert.equal(steerCaptainReport({ steer: () => { throw new Error('not live') } }, 'a', 'b'), false)
})
