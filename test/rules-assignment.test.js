// Contract for task selection and the assignment prompt.
//
// `scheduler.ts` imports `@deepseek-ai/cordis`, so there is no runnable original
// to diff against. The expectations below are transcribed from the rules in the
// source — which for selection is a handful of lines, and for the prompt is the
// template itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEPENDENCY_OUTPUT_MAX_CHARS, DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS,
  ownedOpenTask, nextReadyTask, formatDependencyOutputs, fallbackMailboxPrompt, assignmentPrompt,
} from '../src/rules/index.js'

const task = (id, status, assignee, extra = {}) => ({ id, subject: `s-${id}`, status, assignee, dependencies: [], ...extra })

test('an owned unfinished task comes first', () => {
  assert.equal(ownedOpenTask([task('t1', 'claimed', 'a'), task('t2', 'pending', 'a')], 'a').id, 't1')
  assert.equal(ownedOpenTask([task('t1', 'in_progress', 'a')], 'a').id, 't1')
  assert.equal(ownedOpenTask([task('t1', 'pending', 'a')], 'a'), undefined, 'pending is not owned yet')
  assert.equal(ownedOpenTask([task('t1', 'completed', 'a')], 'a'), undefined)
  assert.equal(ownedOpenTask([task('t1', 'claimed', 'b')], 'a'), undefined)
})

test('a member\'s own ready task beats the unassigned pool', () => {
  const tasks = [task('mine', 'pending', 'a'), task('free', 'pending', undefined)]
  assert.equal(nextReadyTask(tasks, 'a').id, 'mine')
  assert.equal(nextReadyTask(tasks, 'b').id, 'free')
})

test('an unfinished dependency keeps a task out of the pool', () => {
  const tasks = [task('t1', 'in_progress', 'b'), task('t2', 'pending', 'a', { dependencies: ['t1'] })]
  assert.equal(nextReadyTask(tasks, 'a'), undefined)
  tasks[0].status = 'completed'
  assert.equal(nextReadyTask(tasks, 'a').id, 't2')
})

test('a task mid-reassignment is not dispatchable', () => {
  // `reassigning` means a handoff is still quiescing the old owner.
  const tasks = [task('t1', 'pending', 'a', { reassigning: true }), task('t2', 'pending', 'a')]
  assert.equal(nextReadyTask(tasks, 'a').id, 't2')
})

test('a dependency on a task that does not exist blocks forever', () => {
  // Not an oversight: a dependency on a deleted task is a broken record, and
  // dispatching against it would start work nobody can verify.
  assert.equal(nextReadyTask([task('t1', 'pending', 'a', { dependencies: ['ghost'] })], 'a'), undefined)
})

test('dependency output formats as a list, and an empty list says so', () => {
  assert.equal(formatDependencyOutputs([]), '(none)')
  assert.equal(formatDependencyOutputs([{ id: 't1', subject: 'build' }]), '- t1 build:\n  (no output recorded)')
  assert.equal(
    formatDependencyOutputs([{ id: 't1', subject: 'build', output: 'done', profileSeedId: 'seed-a' }]),
    '- t1 [seed-a] build:\n  done',
  )
})

test('a long dependency output is truncated with a marker', () => {
  const formatted = formatDependencyOutputs([{ id: 't1', subject: 's', output: 'x'.repeat(DEPENDENCY_OUTPUT_MAX_CHARS + 100) }])
  assert.ok(formatted.endsWith('[truncated]'))
  assert.ok(formatted.length < DEPENDENCY_OUTPUT_MAX_CHARS + 100)
})

test('the combined block drops the oldest entries first', () => {
  // A dependency list is ordered, so the newest result is the one most likely
  // to still matter.
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `t${index}`, subject: `s${index}`, output: 'y'.repeat(DEPENDENCY_OUTPUT_MAX_CHARS - 100),
  }))
  const formatted = formatDependencyOutputs(items)
  assert.ok(formatted.length <= DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS + 200)
  assert.ok(formatted.includes('t19'), 'the newest survives')
  assert.ok(!formatted.includes('- t0 '), 'the oldest is dropped')
})

test('a single oversized entry is itself truncated to the total budget', () => {
  const formatted = formatDependencyOutputs([{ id: 't1', subject: 's', output: 'z'.repeat(DEPENDENCY_OUTPUT_MAX_CHARS - 1) }])
  assert.ok(formatted.length <= DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS + 20)
})

test('the assignment prompt states the whole contract, not a pointer to it', () => {
  const prompt = assignmentPrompt({
    taskId: 't2', memberName: '建模手', attempt: 3, attemptId: 'att-9', subject: 'calibrate',
    description: 'fit the model', teamDescription: 'win the contest', profileProtocol: 'be terse',
    executionPrompt: 'use python', dependencyOutputs: [], kind: 'implementation',
    round: 2, objective: 'pin parameters', inScope: ['src/'], outOfScope: ['lib/'],
    acceptance: ['fits'], verify: ['npm test'],
  }, '.agent-teams', 'cumcm')

  assert.match(prompt, /executing as configured member "建模手"/)
  assert.match(prompt, /win the contest/)
  assert.match(prompt, /be terse/)
  assert.match(prompt, /use python/)
  assert.match(prompt, /Task: t2 — calibrate\n\nfit the model/)
  assert.match(prompt, /Kind: implementation \(round 2\)/)
  assert.match(prompt, /Acceptance: fits/)
  assert.match(prompt, /Attempt id: att-9/)
  assert.match(prompt, /attempt_id=att-9/)
  assert.match(prompt, /\.agent-teams\/cumcm\/ is read-only/)
  // The structured payload is shown for the kinds that need it.
  assert.match(prompt, /acceptanceResults:/)
  assert.match(prompt, /commandsRun:/)
  assert.match(prompt, /changedPaths/)
})

test('the structured payload is withheld from kinds that do not need it', () => {
  const prompt = assignmentPrompt({
    taskId: 't1', memberName: 'a', attempt: 1, attemptId: 'x', subject: 's',
    dependencyOutputs: [], kind: 'review',
  }, '.d', 'T')
  // The trailing rules paragraph always names those fields; what is withheld is
  // the filled-in payload block, which would otherwise invite a review task to
  // report acceptance results it has no criteria for.
  assert.doesNotMatch(prompt, /Structured completion payload/)
  assert.match(prompt, /review\/requirements need verdict=pass/)
})

test('omitted ticket fields do not leave dangling labels', () => {
  const prompt = assignmentPrompt({
    taskId: 't1', memberName: 'a', attempt: 1, attemptId: 'x', subject: 's', dependencyOutputs: [],
  }, '.d', 'T')
  assert.match(prompt, /Team goal:\n\(not provided\)/)
  assert.match(prompt, /Profile protocol:\n\(none\)/)
  // The contract block is always present — every task has a kind, even when it
  // is the default one. What is absent is anything the ticket did not supply.
  assert.match(prompt, /Contract:\nKind: work/)
  assert.doesNotMatch(prompt, /Execution guidance:/)
  assert.doesNotMatch(prompt, /Reviewed task:/)
})

test('a fallback mailbox prompt names each sender', () => {
  const prompt = fallbackMailboxPrompt([{ from: '建模手', content: 'done' }, { from: 'captain', content: 'again' }])
  assert.match(prompt, /From 建模手:\ndone/)
  assert.match(prompt, /From captain:\nagain/)
  assert.match(prompt, /flow_claim_task/)
})
