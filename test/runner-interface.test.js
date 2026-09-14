// Contract for the execution seam's service definition.
//
// The point of this module is that a dispatch is reproducible from its spec
// alone: everything a runner needs is either supplied or filled in once, here,
// and nothing is invented later inside `run`. So the tests are mostly about
// what `resolveRunnerRequest` fills and what it refuses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUNNER_NAMES, RUNNER_ACTIONS, RUNNER_OUTCOMES,
  runnerSpecError, resolveRunnerRequest, runnerOutcomeError,
} from '../src/runner/interface.js'

const dispatch = {
  teamId: 'T', parentSessionId: 'sess', taskId: 't1', memberName: '建模手', prompt: 'do it',
}

test('the seam names exactly two runners, and only one may be mounted', () => {
  assert.deepEqual([...RUNNER_NAMES], ['manual', 'subagents'])
})

test('a complete dispatch resolves', () => {
  const { spec, error } = resolveRunnerRequest({ ...dispatch, action: 'dispatch' })
  assert.equal(error, undefined)
  assert.equal(spec.runner, 'subagents', 'an unspecified runner defaults to the real one')
  assert.equal(spec.action, 'dispatch')
  assert.equal(spec.taskId, 't1')
  assert.ok(spec.signal instanceof AbortSignal, 'an absent signal becomes one that never aborts')
})

test('a caller-supplied signal is passed through, not replaced', () => {
  const controller = new AbortController()
  const { spec } = resolveRunnerRequest({ ...dispatch, signal: controller.signal })
  assert.equal(spec.signal, controller.signal)
})

test('defaulting happens in resolve, never in run', () => {
  // The distinction the host insists on: resolve() returns a whole spec, so a
  // runner reading `spec.prompt` can trust it is a string.
  const { spec } = resolveRunnerRequest({ ...dispatch, reason: undefined, memberSessionId: undefined })
  assert.equal(spec.reason, 'interrupt')
  assert.equal(spec.memberSessionId, '')
  assert.equal(runnerSpecError(spec), undefined)
})

test('each action demands the fields it reads', () => {
  assert.match(resolveRunnerRequest({ action: 'dispatch' }).error, /teamId/)
  assert.match(resolveRunnerRequest({ ...dispatch, taskId: undefined }).error, /taskId/)
  assert.match(resolveRunnerRequest({ ...dispatch, memberName: undefined }).error, /memberName/)
  assert.match(resolveRunnerRequest({ ...dispatch, prompt: undefined }).error, /non-empty prompt/)
  assert.match(resolveRunnerRequest({ ...dispatch, prompt: '' }).error, /non-empty prompt/)
  assert.match(resolveRunnerRequest({ action: 'deliver', teamId: 'T', parentSessionId: 's' }).error, /memberName/)
  // A delivery body may be empty: telling a member to stop needs no words.
  assert.equal(resolveRunnerRequest({ action: 'deliver', teamId: 'T', parentSessionId: 's', memberName: 'a', content: '' }).error, undefined)
  assert.equal(resolveRunnerRequest({ action: 'interrupt', teamId: 'T', parentSessionId: 's', memberName: 'a' }).error, undefined)
  assert.equal(resolveRunnerRequest({ action: 'probe', teamId: 'T', parentSessionId: 's' }).error, undefined)
})

test('an unknown runner or action is refused rather than defaulted', () => {
  assert.match(resolveRunnerRequest({ ...dispatch, runner: 'bash' }).error, /unknown runner/)
  assert.match(resolveRunnerRequest({ ...dispatch, action: 'evict' }).error, /unknown runner action/)
})

test('a blank parent session is refused', () => {
  // Without it there is no authority to spawn under, and an empty string would
  // otherwise sail through every typeof check.
  assert.match(resolveRunnerRequest({ ...dispatch, parentSessionId: '' }).error, /parentSessionId/)
  assert.match(resolveRunnerRequest({ ...dispatch, teamId: '' }).error, /teamId/)
})

test('an outcome always carries events, including when it fails', () => {
  assert.equal(runnerOutcomeError({ outcome: 'dispatched', events: [] }), undefined)
  assert.match(runnerOutcomeError({ outcome: 'dispatched' }), /events array/)
  assert.match(runnerOutcomeError({ outcome: 'gave-up', events: [] }), /unknown runner outcome/)
})

test('an unsupported outcome must explain itself', () => {
  // The whole value of "unsupported" over a silent resolve is the message.
  assert.match(runnerOutcomeError({ outcome: 'unsupported', events: [] }), /must explain itself/)
  assert.equal(runnerOutcomeError({ outcome: 'unsupported', error: 'why', events: [] }), undefined)
})

test('the outcome vocabulary is closed', () => {
  assert.deepEqual([...RUNNER_OUTCOMES], ['dispatched', 'deferred', 'unsupported'])
})
