// Contract for model-route fallback and the events a lost attempt leaves.
//
// `members.ts` imports `@deepseek-ai/dsh-agent`, which is not installed here, so
// unlike the step-1 rules there is no runnable original to diff against. The
// selection rule is four lines and fully specified, so its expectations below
// are transcribed from the rule rather than from this implementation — which is
// what makes the test worth running.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_FAILURE_CODES, isFallbackFailureCode, selectFallbackRoute, attemptFailureEvents,
} from '../src/rules/index.js'

const CURRENT = { provider: 'primary', model: 'big' }
const FALLBACK = { provider: 'backup', model: 'small' }

test('the re-routable failures are exactly the route-shaped ones', () => {
  // A different route plausibly helps for these. A malformed request or an
  // over-long context fails identically wherever it is sent.
  assert.deepEqual([...FALLBACK_FAILURE_CODES], ['QUOTA', 'RATE_LIMIT', 'AUTH', 'MISSING_CREDENTIAL', 'NO_ADAPTER'])
  assert.equal(isFallbackFailureCode('QUOTA'), true)
  for (const code of ['BAD_REQUEST', 'CONTEXT_LENGTH', 'TIMEOUT', '', 'quota']) {
    assert.equal(isFallbackFailureCode(code), false, `${JSON.stringify(code)} is not a fallback reason`)
  }
})

test('the selection rule, transcribed from the source', () => {
  // if (alreadySwitched || fallback undefined || !isFallbackFailureCode(code))
  //   -> { retry: false, switched: alreadySwitched, selection: current }
  // else
  //   -> { retry: true, switched: true, selection: fallback }
  const cases = [
    // [label, alreadySwitched, fallback, code, expected]
    ['first failure on a fallbackable code', false, FALLBACK, 'QUOTA', { retry: true, switched: true, selection: FALLBACK }],
    ['already on the fallback', true, FALLBACK, 'QUOTA', { retry: false, switched: true, selection: CURRENT }],
    ['no fallback configured', false, undefined, 'QUOTA', { retry: false, switched: false, selection: CURRENT }],
    ['an unlisted code', false, FALLBACK, 'BAD_REQUEST', { retry: false, switched: false, selection: CURRENT }],
    ['already switched and unlisted', true, undefined, 'BAD_REQUEST', { retry: false, switched: true, selection: CURRENT }],
    ['every code in the list', false, FALLBACK, 'NO_ADAPTER', { retry: true, switched: true, selection: FALLBACK }],
  ]
  for (const [label, alreadySwitched, fallback, code, expected] of cases) {
    assert.deepEqual(selectFallbackRoute(CURRENT, fallback, code, alreadySwitched), expected, label)
  }
})

test('the rule is total: it never returns a partial decision', () => {
  for (const alreadySwitched of [true, false]) {
    for (const fallback of [FALLBACK, undefined]) {
      for (const code of FALLBACK_FAILURE_CODES) {
        const result = selectFallbackRoute(CURRENT, fallback, code, alreadySwitched)
        const shouldRetry = !alreadySwitched && fallback !== undefined
        assert.equal(result.retry, shouldRetry)
        assert.equal(result.switched, shouldRetry || alreadySwitched)
        assert.equal(result.selection, shouldRetry ? fallback : CURRENT)
      }
    }
  }
})

// --- the events a lost attempt leaves -------------------------------------

const task = extra => ({ id: 't1', status: 'claimed', attemptId: 'att-1', ...extra })

test('a failed attempt leaves both facts, in order', () => {
  const events = attemptFailureEvents(task({}), { reason: 'member went idle', code: 'MEMBER_IDLE' }, 500, 7)
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], {
    type: 'task.attempt_failed', at: 500, seq: 7,
    id: 't1', attemptId: 'att-1', reason: 'member went idle', code: 'MEMBER_IDLE',
  })
  assert.deepEqual(events[1], {
    type: 'task.rolled_back', at: 500, seq: 8,
    id: 't1', toStatus: 'pending', reason: 'member went idle', attemptId: 'att-1', code: 'MEMBER_IDLE',
    // `assignee: null` is the rollback saying nobody holds the task now. An
    // absent key would mean the event had nothing to say about the owner, and
    // the two are different states: the first is a task back in the pool.
    assignee: null, attempt: 0,
  })
})

test('a rollback names the generation and owner it restores', () => {
  // A recovered generation that fails puts the previous one back, so the
  // projection has to be told which one that was.
  const events = attemptFailureEvents(task({ attempt: 3 }), {
    reason: 'unreachable', toStatus: 'in_progress', assignee: '建模手', attempt: 2,
  }, 1, 0)
  assert.equal(events[1].assignee, '建模手')
  assert.equal(events[1].attempt, 2)
  assert.equal(events[1].toStatus, 'in_progress')
})

test('a task that never started an attempt records only the rollback', () => {
  // Nothing to attribute a failure to, but the revocation still happened.
  const events = attemptFailureEvents(task({ attemptId: undefined }), { reason: 'revoked' }, 1, 0)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'task.rolled_back')
  assert.equal(events[0].seq, 0)
})

test('a terminal task is not rolled back', () => {
  // Claiming otherwise would say work was taken back when it had already ended.
  for (const status of ['completed', 'failed', 'cancelled']) {
    const events = attemptFailureEvents(task({ status }), { reason: 'late failure' }, 1, 0)
    assert.deepEqual(events.map(event => event.type), ['task.attempt_failed'], `${status} must not roll back`)
  }
})

test('an explicit target status is honoured', () => {
  const events = attemptFailureEvents(task({}), { reason: 'reassign', toStatus: 'cancelled' }, 1, 0)
  assert.equal(events[1].toStatus, 'cancelled')
})

test('an absent code is omitted rather than written as undefined', () => {
  const events = attemptFailureEvents(task({}), { reason: 'no code' }, 1, 0)
  assert.ok(!('code' in events[0]))
})

test('sequence numbers are contiguous so the log stays replayable', () => {
  const events = attemptFailureEvents(task({}), { reason: 'r' }, 1, 10)
  assert.deepEqual(events.map(event => event.seq), [10, 11])
})
