// Contract for the canvas-only runner.
//
// Its whole job is to refuse clearly. A runner that resolved quietly here would
// leave the caller waiting for a member that was never started, and the failure
// would only surface later as "the team seems stuck".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManualRunner } from '../src/runner/manual.js'
import { runnerOutcomeError } from '../src/runner/interface.js'

const dispatch = { teamId: 'T', parentSessionId: 'sess', taskId: 't1', memberName: '建模手', prompt: 'do it' }

test('every action reports unsupported rather than resolving quietly', async () => {
  const runner = createManualRunner()
  for (const action of ['dispatch', 'deliver', 'interrupt', 'probe']) {
    const outcome = await runner.run({ ...dispatch, action })
    assert.equal(outcome.outcome, 'unsupported', `${action} must not claim success`)
    assert.equal(runnerOutcomeError(outcome), undefined, `${action} produced an invalid outcome`)
    assert.deepEqual(outcome.events, [], 'nothing happened, so nothing is recorded')
  }
})

test('the refusal says why, not just that it failed', async () => {
  const outcome = await createManualRunner().run({ ...dispatch })
  assert.match(outcome.error, /no execution kernel is mounted/)
})

test('the runner identifies itself as manual regardless of what the request says', async () => {
  const runner = createManualRunner()
  assert.equal(runner.name, 'manual')
  const outcome = await runner.run({ ...dispatch, runner: 'subagents' })
  assert.equal(outcome.outcome, 'unsupported', 'a manual runner cannot become the real one on request')
})

test('an invalid request is refused before anything else', async () => {
  const outcome = await createManualRunner().run({ action: 'dispatch' })
  assert.equal(outcome.outcome, 'unsupported')
  assert.match(outcome.error, /teamId/)
})

test('dispose resolves immediately because nothing was ever started', async () => {
  await createManualRunner().dispose()
})
