// Contract for where a coverage matrix gets its goal items.
//
// The property under test is that the question "what did the user ask for" is
// answered *by the tasks* rather than by a list kept beside them. A separate
// list would be a second record of the request, and the moment the two
// disagreed the matrix would be measuring something nobody asked for — with no
// way to tell which of the two was right.
//
// `buildCoverageMatrix` itself is compared against the original by
// `scripts/diff-agent-teams.mjs`; what is asserted here is the derivation that
// the original had inlined in its tool layer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCoverageMatrix, goalItemsOf } from '../src/rules/index.js'

const task = (id, coverageOf) => ({ id, coverageOf })

test('a goal item is listed once, in the order it was first claimed', () => {
  // Order is first-seen, not sorted and not by task id: the matrix reads in the
  // order the requirements were claimed, which is the order they were asked in.
  const items = goalItemsOf([
    task('t1', ['稳定性', '精度']),
    task('t2', ['精度', '可读性']),
    task('t3', []),
    task('t4', ['稳定性']),
  ])
  assert.deepEqual(items, ['稳定性', '精度', '可读性'])
})

test('a task that claims nothing contributes nothing', () => {
  assert.deepEqual(goalItemsOf([]), [])
  assert.deepEqual(goalItemsOf([task('t1', []), { id: 't2' }, task('t3', undefined)]), [])
})

test('the matrix answers per item, and a failed cover is not a pass', () => {
  const tasks = [
    { ...task('t1', ['A', 'B']), status: 'completed' },
    { ...task('t2', ['B']), status: 'failed' },
    { ...task('t3', ['C']), status: 'pending' },
  ]
  assert.deepEqual(buildCoverageMatrix(goalItemsOf(tasks), tasks), [
    { goal_item: 'A', task_ids: ['t1'], status: 'passed' },
    // Partial coverage is not coverage: one covering task failed, so the item
    // is blocked even though another one completed.
    { goal_item: 'B', task_ids: ['t1', 't2'], status: 'blocked' },
    { goal_item: 'C', task_ids: ['t3'], status: 'in_progress' },
  ])
})

test('a goal item nobody claimed is missing, and is still a row', () => {
  // The row is the point: an unclaimed requirement that produced no row would
  // be invisible, which is exactly the failure coverage exists to surface.
  const withClaim = { ...task('t1', ['A']), status: 'completed' }
  const rows = buildCoverageMatrix(['A', 'B'], [withClaim])
  assert.deepEqual(rows, [
    { goal_item: 'A', task_ids: ['t1'], status: 'passed' },
    { goal_item: 'B', task_ids: [], status: 'missing' },
  ])
})
