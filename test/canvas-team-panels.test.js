// Contract for the team inspector's quality sections.
//
// This file exists because `team-panels.js` was written to be testable: it
// imports `html.js` and nothing else, so it loads under `node --test` where
// `view.js` — which touches `document` at module scope — cannot. The properties
// asserted here are the ones a browser check would otherwise be the only way to
// notice:
//
//   an empty answer renders *nothing*, rather than an empty section that reads
//   like a team with no requirements;
//
//   every blocker is shown in full, because a count throws away the only part
//   anyone can act on;
//
//   everything interpolated is escaped, since goal items and blocker text come
//   from model output.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attemptTimelineHtml, clockOf, coverageHtml, deliveryHtml, loopHtml, qualityPanelHtml, stagedPlanHtml, taskStateLabel,
} from '../src/canvas/team-panels.js'

test('a task display state gets a label, and an unknown one is shown as itself', () => {
  assert.equal(taskStateLabel('blocked'), '阻塞')
  assert.equal(taskStateLabel('completed'), '完成')
  // Not a blank: a state the map does not know is a state worth seeing.
  assert.equal(taskStateLabel('invented'), 'invented')
  assert.equal(taskStateLabel(undefined), '')
})

test('a halted team reads as halted, not as merely busy', () => {
  // The chip is the difference between "wait" and "act": a halted team needs a
  // resume before anything else can happen.
  const halted = loopHtml({ state: 'halted', halted: true, summary: 'Team is halted.' })
  assert.match(halted, /chip--halted/)
  assert.match(halted, /已停止/)
  assert.match(halted, /Team is halted\./)

  const running = loopHtml({ state: 'running', halted: false, summary: 'Work remains.' })
  assert.match(running, /chip--running/)
  assert.doesNotMatch(running, /chip--halted/)
})

test('a deliverable team is told apart from a running one', () => {
  assert.match(loopHtml({ state: 'deliverable', halted: false, deliverable: true, summary: 'Done.' }), /chip--idle/)
})

test('a missing loop answer renders nothing rather than an empty box', () => {
  for (const value of [undefined, null, {}, { summary: 42 }]) {
    assert.equal(loopHtml(value), '', JSON.stringify(value))
  }
})

test('every delivery blocker is shown, and none of them is summarised away', () => {
  // A count would be the one thing a reader cannot act on: each blocker names a
  // task and a condition, and that naming is the whole product of the gate.
  const html = deliveryHtml({ ok: false, blockers: ['t4 (verification) is not completed', 't2 failed without a follow-up repair'] })
  assert.match(html, /t4 \(verification\) is not completed/)
  assert.match(html, /t2 failed without a follow-up repair/)
  assert.equal(html.split('quality-blocker').length - 1, 2)
  assert.match(html, /2 项未过/)
})

test('a clear delivery gate says so without listing nothing', () => {
  const html = deliveryHtml({ ok: true, blockers: [] })
  assert.match(html, /通过/)
  assert.doesNotMatch(html, /quality-blocker/)
})

test('a goal item no task claims is a row, not an omission', () => {
  // Dropping the row would make an unclaimed requirement invisible — which is
  // exactly the failure the coverage matrix exists to surface.
  const html = coverageHtml([
    { goal_item: '稳定性', task_ids: ['t1', 't2'], status: 'passed' },
    { goal_item: '可读性', task_ids: [], status: 'missing' },
  ])
  assert.match(html, /稳定性/)
  assert.match(html, /t1 t2/)
  assert.match(html, /chip--state-completed/)
  assert.match(html, /可读性/)
  assert.match(html, /无任务/)
  assert.match(html, /chip--state-open/)
  assert.match(html, /2 项/)
})

test('coverage statuses are translated, not shown raw', () => {
  // `missing` and `blocked` are the matrix's vocabulary, not the canvas': the
  // reader sees what it means, on the chip colour that already means it.
  const html = coverageHtml([
    { goal_item: 'a', task_ids: [], status: 'missing' },
    { goal_item: 'b', task_ids: ['t'], status: 'blocked' },
    { goal_item: 'c', task_ids: ['t'], status: 'in_progress' },
  ])
  assert.doesNotMatch(html, />missing</)
  assert.match(html, /chip--state-failed/)
  assert.match(html, /chip--state-running/)
})

test('no coverage is no section', () => {
  for (const value of [undefined, [], 'nope']) assert.equal(coverageHtml(value), '', JSON.stringify(value))
})

test('model output cannot break out of the panel', () => {
  const hostile = '<img src=x onerror="alert(1)">'
  const html = qualityPanelHtml({
    loop: { state: 'running', halted: false, summary: hostile },
    delivery: { ok: false, blockers: [hostile] },
    coverage: [{ goal_item: hostile, task_ids: [hostile], status: 'missing' }],
  })
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /onerror="alert/)
  assert.match(html, /&lt;img src=x/)
})

// --- one task's attempt timeline -------------------------------------------

test('a timestamp is local wall clock, formatted the same way every time', () => {
  // Built from a local-time Date so the expectation holds in any zone; the
  // point is the format, not the zone.
  assert.equal(clockOf(new Date(2026, 0, 2, 3, 4, 5).getTime()), '03:04:05')
  for (const value of [undefined, null, 'x', Number.NaN]) assert.equal(clockOf(value), '', String(value))
})

test('attempts and rollbacks read as one sequence, not two lists', () => {
  // The reader is reconstructing what happened. Two lists would make them do
  // the merge in their head, and the ordering is the whole story here.
  const html = attemptTimelineHtml({
    taskId: 't1',
    subject: 'pin it',
    attempts: [
      { attemptId: 'a1', at: 1000, assignee: '建模手', outcome: 'failed', reason: 'quota', code: 'QUOTA' },
      { attemptId: 'a2', at: 3000, assignee: '程序员', outcome: 'started' },
    ],
    rollbacks: [{ at: 2000, toStatus: 'pending', reason: 'quota', attemptId: 'a1' }],
  })
  const rollbackAt = html.indexOf('回滚')
  const secondAttemptAt = html.indexOf('#2')
  assert.ok(rollbackAt !== -1 && secondAttemptAt !== -1)
  assert.ok(rollbackAt < secondAttemptAt, 'the rollback sorts between the two attempts')
  assert.match(html, /pin it/, 'the open row names the task it belongs to')
  assert.match(html, /2 次/)
  assert.match(html, /QUOTA/)
  assert.match(html, /建模手/)
})

test('an attempt that is not finished says so rather than reading as a failure', () => {
  // "started with no outcome" is the ordinary state of work in flight, and
  // showing it as anything else would make a healthy team look broken.
  const html = attemptTimelineHtml({ taskId: 't1', subject: 'x', attempts: [{ attemptId: 'a', at: 1, outcome: 'started' }], rollbacks: [] })
  assert.match(html, /未收尾/)
  assert.doesNotMatch(html, /失败/)
})

test('a task nobody has tried says so, rather than rendering an empty box', () => {
  const html = attemptTimelineHtml({ taskId: 't1', subject: 'later', attempts: [], rollbacks: [] })
  assert.match(html, /还没有任何尝试/)
  assert.equal(attemptTimelineHtml(undefined), '')
})

test('a timeline escapes what the log recorded', () => {
  const hostile = '<script>alert(1)</script>'
  const html = attemptTimelineHtml({
    taskId: 't1', subject: hostile,
    attempts: [{ attemptId: 'a', at: 1, assignee: hostile, outcome: 'failed', reason: hostile }],
    rollbacks: [],
  })
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})

// --- the staged-plan editor ------------------------------------------------

const staged = extra => ({
  teamId: 'T', phase: 'staged', writable: true,
  members: [{ name: '建模手', role: 'scientist' }, { name: '程序员' }],
  tasks: [{ id: 't1', subject: 'pin it', dependencies: [] }, { id: 't2', subject: 'build it', dependencies: ['t1'] }],
  ...extra,
})

test('the editor appears only where editing is meaningful', () => {
  // A running team's task list is the record of what is happening — the same
  // controls there would rewrite it underneath members holding attempts. And an
  // imported `.agent-teams/` team is somebody else's record to begin with.
  assert.notEqual(stagedPlanHtml(staged()), '')
  assert.equal(stagedPlanHtml(staged({ phase: 'running' })), '')
  assert.equal(stagedPlanHtml(staged({ writable: false })), '', 'a read-only source cannot be edited from here')
  assert.equal(stagedPlanHtml(undefined), '')
})

test('every control carries the request it makes', () => {
  // The buttons report *which one was pressed* through their own name/value, so
  // the panel never has to remember a pending intent across a re-render — which
  // matters because `render()` replaces the whole document every frame.
  const html = stagedPlanHtml(staged())
  assert.match(html, /data-form="plan-edit"/)
  assert.match(html, /data-team="T"/)
  assert.match(html, /name="removeMember" value="建模手"/)
  assert.match(html, /name="removeTask" value="t2"/)
  assert.match(html, /name="intent" value="addMember"/)
  assert.match(html, /name="intent" value="addTask"/)
  assert.match(html, /name="intent" value="approve"/)
})

test('the plan shows what will be started, including what it waits on', () => {
  const html = stagedPlanHtml(staged())
  assert.match(html, /建模手/)
  assert.match(html, /scientist/)
  assert.match(html, /pin it/)
  assert.match(html, /依赖 t1/, 'a dependency is visible before it is approved, not after')
})

test('an empty roster or task list says so rather than showing nothing', () => {
  // An approved plan with an empty roster starts nothing and would otherwise
  // look perfectly fine.
  const html = stagedPlanHtml(staged({ members: [], tasks: [] }))
  assert.match(html, /还没有成员/)
  assert.match(html, /还没有任务/)
})

test('the editor escapes names that came from a model', () => {
  const html = stagedPlanHtml(staged({ members: [{ name: '"><img src=x>' }], tasks: [] }))
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&quot;&gt;&lt;img/)
})

test('the three sections compose, and any of them may be absent', () => {
  const full = qualityPanelHtml({
    loop: { state: 'running', halted: false, summary: 'Work remains.' },
    delivery: { ok: true, blockers: [] },
    coverage: [{ goal_item: 'a', task_ids: [], status: 'missing' }],
  })
  assert.match(full, /质量循环/)
  assert.match(full, /交付闸门/)
  assert.match(full, /需求覆盖/)

  assert.equal(qualityPanelHtml({}), '')
  assert.equal(qualityPanelHtml(undefined), '')
  assert.equal(qualityPanelHtml({ loop: { state: 'running', halted: false, summary: 'x' } }), loopHtml({ state: 'running', halted: false, summary: 'x' }))
})
