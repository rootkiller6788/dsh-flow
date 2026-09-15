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
  coverageHtml, deliveryHtml, loopHtml, qualityPanelHtml, taskStateLabel,
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
