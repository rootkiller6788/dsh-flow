// Contract for the event-log projection.
//
// The acceptance criterion is stated in the plan and checked here directly: a
// log folded through `projectTeam` must produce a record that passes every
// entity validator. If the projection can produce something the validators
// reject, then the log and the state are two different models of the same team.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  teamEvent, isTeamState, projectTeam, replayTeam, taskAttempts, taskRollbacks,
} from '../src/rules/index.js'

/** A log that exercises every event type that touches the team record. */
function fullLog() {
  const events = []
  let seq = 0
  const push = (type, payload, at) => { events.push(teamEvent(type, payload, at, seq++)) }

  push('team.created', { name: '建模 Team', captainSessionId: 'sess-1', description: 'goal' }, 1000)
  push('team.phase_changed', { from: 'staged', to: 'running' }, 1001)
  push('member.added', { member: { id: 'child-1', name: '建模手', role: 'scientist' } }, 1002)
  push('member.added', { member: { id: 'child-2', name: '程序员', role: 'engineer' } }, 1003)
  push('task.created', { task: { subject: '标定参数', kind: 'requirements', objective: 'pin the model', acceptance: ['fits'] } }, 1004)
  push('task.created', { task: { subject: '实现求解器', kind: 'implementation', dependencies: ['t1'], inScope: ['src/'], verify: ['npm test'] } }, 1005)
  push('task.attempt_started', { id: 't1', attemptId: 'att-1', assignee: '建模手' }, 1006)
  push('task.attempt_failed', { id: 't1', attemptId: 'att-1', reason: 'member went idle', code: 'MEMBER_IDLE' }, 1007)
  push('task.rolled_back', { id: 't1', toStatus: 'pending', reason: 'revoked', attemptId: 'att-1' }, 1008)
  push('task.attempt_started', { id: 't1', attemptId: 'att-2', assignee: '建模手' }, 1009)
  push('task.completed', { id: 't1', verdict: 'pass', output: 'done' }, 1010)
  push('member.updated', { id: 'child-2', patch: { model: 'deepseek-v4' } }, 1011)
  push('team.halted', { reason: 'wait' }, 1012)
  push('team.resumed', { reason: 'continue' }, 1013)
  push('member.removed', { id: 'child-2', reason: 'done' }, 1014)
  push('team.archived', {}, 1015)
  return events
}

test('a full log projects to a record every validator accepts', () => {
  const projected = projectTeam(fullLog())
  assert.ok(projected !== undefined)
  assert.ok(isTeamState(projected.state, projected.state.id), 'projected state must satisfy isTeamState')
})

test('the projected record reflects what the log said', () => {
  const { state, archived } = projectTeam(fullLog())
  assert.equal(state.name, '建模 Team')
  assert.equal(state.id, '建模-team', 'the id is the sanitized name, and is what the validators key on')
  assert.equal(state.phase, 'running')
  assert.equal(state.halted, false, 'halted then resumed is not halted')
  assert.equal(state.haltedAt, undefined)
  assert.equal(archived, true)
  assert.equal(state.tasks.length, 2)
  assert.equal(state.taskSeq, 2)
  assert.equal(state.tasks[0].status, 'completed')
  assert.equal(state.tasks[0].verdict, 'pass')
  assert.equal(state.tasks[1].dependencies[0], 't1')
  assert.equal(state.members.find(m => m.name === '程序员').status, 'removed')
  assert.equal(state.members.find(m => m.name === '程序员').model, 'deepseek-v4')
})

test('a log without a beginning projects to nothing', () => {
  assert.equal(projectTeam([]), undefined)
  assert.equal(projectTeam([teamEvent('team.archived', {}, 1, 0)]), undefined)
})

test('replay reproduces the state as it stood', () => {
  const events = fullLog()
  const beforeComplete = replayTeam(events, 5)
  assert.equal(beforeComplete.state.tasks[0].status, 'pending')
  assert.equal(beforeComplete.state.halted, undefined)
  const afterComplete = replayTeam(events, 10)
  assert.equal(afterComplete.state.tasks[0].status, 'completed')
})

test('the projection does not mutate the log', () => {
  const events = fullLog()
  const snapshot = JSON.stringify(events)
  projectTeam(events)
  assert.equal(JSON.stringify(events), snapshot)
})

// The two things the snapshot model cannot express.
test('attempt history survives, including what became of each attempt', () => {
  const attempts = taskAttempts(fullLog(), 't1')
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0], {
    attemptId: 'att-1', at: 1006, assignee: '建模手', outcome: 'failed',
    reason: 'member went idle', code: 'MEMBER_IDLE', endedAt: 1007,
  })
  assert.equal(attempts[1].outcome, 'started', 'the second attempt never reported an outcome')
})

test('rollbacks are recorded as facts, not silently applied', () => {
  assert.deepEqual(taskRollbacks(fullLog(), 't1'), [
    { at: 1008, toStatus: 'pending', reason: 'revoked', code: undefined, attemptId: 'att-1' },
  ])
})

test('a failed attempt revokes the capability without inventing an outcome', () => {
  const partial = fullLog().slice(0, 8)
  const state = projectTeam(partial).state
  const task = state.tasks.find(item => item.id === 't1')
  assert.equal(task.attemptId, undefined, 'the reverted capability is gone')
  assert.equal(task.attempt, 1, 'the attempt counter still records that it happened')
  assert.equal(task.status, 'claimed', 'the automatic revert leaves the status alone; the explicit rollback moves it')
})

test('message events do not enter the team record', () => {
  const events = [
    teamEvent('team.created', { name: 'T', captainSessionId: 's' }, 1, 0),
    teamEvent('message.sent', { from: 'captain', to: 'a', content: 'hi' }, 2, 1),
    teamEvent('message.acked', { id: 'm1' }, 3, 2),
  ]
  const { state } = projectTeam(events)
  assert.equal(state.tasks.length, 0)
  assert.equal(state.members.length, 0)
  assert.ok(isTeamState(state, state.id))
})
