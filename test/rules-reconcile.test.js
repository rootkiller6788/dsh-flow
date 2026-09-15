// Contract for state → events.
//
// The property under test is not "these particular events come out" but the
// one the whole design rests on: **folding what this returns onto the state it
// was given must reproduce the state the caller asked for**. Every case below
// is a way of asking that question, and the last group asks the inverse — that
// a difference with no event to carry it is refused rather than dropped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  teamEvent, projectTeam, applyEvents, teamDiffEvents, beginTaskAttempt, attemptFailureEvents,
} from '../src/rules/index.js'

/** A running team, as the projection of a small log would leave it. */
function running() {
  const events = []
  let seq = 0
  const push = (type, payload, at) => events.push(teamEvent(type, payload, at, seq++))
  push('team.created', { name: 'T', captainSessionId: 'sess-cap' }, 1000)
  push('team.phase_changed', { from: 'staged', to: 'running' }, 1001)
  push('member.added', { member: { id: 'child-a', name: 'a', role: 'engineer' } }, 1002)
  push('member.added', { member: { id: 'child-b', name: 'b', role: 'engineer' } }, 1003)
  push('task.created', { task: { subject: 'one', objective: 'do it', acceptance: ['ok'] } }, 1004)
  push('task.created', { task: { subject: 'two' } }, 1005)
  return projectTeam(events).state
}

/**
 * The record with the fields the log stamps removed.
 *
 * `joinedAt` and the timestamps are written from the event's own clock on the
 * way back in, so requiring them to match is requiring the caller's clock to
 * agree with the log's. The contract is that the events reproduce what the
 * caller *decided*, and those are not decisions.
 */
const decided = state => JSON.parse(JSON.stringify(state, (key, value) => (
  ['joinedAt', 'createdAt', 'updatedAt'].includes(key) ? undefined : value
)))

/** Diff `mutate(state)` against `state`, and insist the events reproduce it. */
function reconcile(state, mutate, at = 2000) {
  const after = structuredClone(state)
  mutate(after)
  const events = teamDiffEvents(state, after, at, 99)
  assert.deepEqual(decided(applyEvents(state, events)), decided(after), 'the events must reproduce the caller\'s record')
  return events
}

test('an untouched team produces no events', () => {
  // The scheduler calls `writeTeam` after every path, including the ones that
  // changed nothing. A reconcile that invented an event there would fill the
  // log with noise and make "what happened" unreadable.
  assert.deepEqual(reconcile(running(), () => {}), [])
})

test('a member going to work is one event, and it names the member', () => {
  const events = reconcile(running(), team => { team.members[0].status = 'working' })
  assert.deepEqual(events, [{ type: 'member.updated', at: 2000, seq: 99, id: 'child-a', patch: { status: 'working' } }])
})

test('claiming work is an attempt_started, not a status change', () => {
  // The two are one fact. Recording both would put a "pending → claimed"
  // transition in the log that no transition table ever produced.
  const events = reconcile(running(), team => {
    beginTaskAttempt(team.tasks[0], 'a', { attemptId: 'att-1', now: 2000 })
    team.members[0].status = 'working'
  })
  // Members are reconciled before tasks; nothing reads the log incrementally,
  // so the order is only there to be stable.
  assert.deepEqual(events.map(event => event.type), ['member.updated', 'task.attempt_started'])
  assert.equal(events[1].attemptId, 'att-1')
  assert.equal(events[1].attempt, 1)
  assert.equal(events[1].assignee, 'a')
})

test('a second generation of the same task counts up', () => {
  const state = applyEvents(running(), [
    teamEvent('task.attempt_started', { id: 't1', attemptId: 'att-1', assignee: 'a' }, 1500, 6),
  ])
  const events = reconcile(state, team => { beginTaskAttempt(team.tasks[0], 'b', { attemptId: 'att-2', now: 2000 }) })
  assert.equal(events.length, 1)
  assert.equal(events[0].attempt, 2)
  assert.equal(events[0].assignee, 'b')
})

test('completing a task carries its result, not a bare status', () => {
  const events = reconcile(running(), team => {
    team.tasks[0].status = 'completed'
    team.tasks[0].verdict = 'pass'
    team.tasks[0].output = 'done'
  })
  assert.deepEqual(events, [{
    type: 'task.completed', at: 2000, seq: 99, id: 't1', verdict: 'pass', output: 'done',
  }])
})

test('adding a member is its own fact', () => {
  const added = reconcile(running(), team => { team.members.push({ id: '', name: 'c', role: 'engineer', status: 'idle' }) })
  assert.deepEqual(added.map(event => event.type), ['member.added'])
  assert.deepEqual(added[0].member, { name: 'c', role: 'engineer' }, 'the projection owns joinedAt and status')
})

test('giving a member a session id addresses the row by the name it still has', () => {
  // The id being assigned is what the update carries, but the row it applies to
  // is still filed under the name. Keying the event on the new id would name no
  // row, and the assignment would be recorded and then not happen.
  const events = reconcile(running(), team => { team.members[0].id = 'child-new' })
  assert.deepEqual(events, [{
    type: 'member.updated', at: 2000, seq: 99, id: 'child-a', patch: { id: 'child-new' },
  }])
})

test('a member is matched by name even when another already holds that id', () => {
  // Matching in one pass would let the earlier member shadow the later one, and
  // the update would be computed against the wrong row. Session ids are the
  // host's to keep unique, so this is about not depending on that.
  const state = applyEvents(running(), [
    teamEvent('member.updated', { id: 'child-a', patch: { id: 'shared' } }, 1500, 6),
  ])
  const events = reconcile(state, team => { team.members[1].id = 'shared' })
  assert.deepEqual(events, [{ type: 'member.updated', at: 2000, seq: 99, id: 'child-b', patch: { id: 'shared' } }])
})

test('deleting a member is refused, because removal is a tombstone', () => {
  // The member stays in the record marked `removed` — the tasks it touched and
  // the mail it received still name it. A caller that spliced it out is asking
  // for a record the log cannot produce.
  assert.throws(
    () => reconcile(running(), team => { team.members.splice(1, 1) }),
    /tombstone/,
  )
})

test('deleting a task is refused, because no event removes a task', () => {
  assert.throws(
    () => reconcile(running(), team => { team.tasks.pop() }),
    /no event that removes a task/,
  )
})

// --- the refusals ---------------------------------------------------------

test('a change to a plan field is refused, not dropped', () => {
  // A live member may be holding an attempt against this task. There is no
  // event that rewrites a plan, so the honest answer is an error.
  assert.throws(
    () => reconcile(running(), team => { team.tasks[0].acceptance = ['something else'] }),
    /acceptance.*cannot express|no vocabulary/s,
  )
})

test('a task that loses its capability without an attempt is refused', () => {
  // Revoking work is a fact with a reason. A reconcile cannot invent one, so
  // the caller is sent to record it rather than have it happen anonymously.
  const state = applyEvents(running(), [
    teamEvent('task.attempt_started', { id: 't1', attemptId: 'att-1', assignee: 'a' }, 1500, 6),
  ])
  assert.throws(
    () => reconcile(state, team => { team.tasks[0].attemptId = undefined }),
    /no vocabulary/,
  )
})

test('a rollback that was already recorded reconciles to nothing', () => {
  // The dispatch loop records the failure first, because a reason is narrative
  // no diff can recover, and only then moves the fields. The reconcile must see
  // the log, not a snapshot from before it, or the same fact lands twice.
  const state = applyEvents(running(), [
    teamEvent('task.attempt_started', { id: 't1', attemptId: 'att-1', attempt: 1, assignee: 'a' }, 1500, 6),
    teamEvent('member.updated', { id: 'child-a', patch: { status: 'working' } }, 1501, 7),
  ])
  const withFailure = applyEvents(state, attemptFailureEvents(state.tasks[0], {
    reason: 'unreachable', code: 'MEMBER_IDLE', toStatus: 'pending', assignee: null, attempt: 0,
  }, 1600, 8))

  const events = reconcile(withFailure, team => {
    team.tasks[0].status = 'pending'
    team.tasks[0].assignee = undefined
    team.tasks[0].attempt = 0
    team.members[0].status = 'idle'
  }, 1700)
  assert.deepEqual(events.map(event => event.type), ['member.updated'], 'only the member is left to record')
})

test('a team the log does not describe cannot be diffed', () => {
  assert.throws(() => teamDiffEvents(undefined, running(), 1, 0), /team\.created/)
})
