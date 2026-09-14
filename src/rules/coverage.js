// Goal coverage. Ported from `dsh-agent-teams/src/quality-gates.ts`
// (`buildCoverageMatrix`).
//
// Answers "which of the things the user asked for are actually covered", which
// is a different question from "are the tasks done": every task may be complete
// while an entire goal item has no task pointing at it at all.

/**
 * One row per goal item.
 *
 * A goal is `blocked` as soon as *any* covering task failed or was cancelled,
 * even if others completed — partial coverage of a requirement is not coverage,
 * and the row records every covering task so the gap is visible.
 *
 * @param goalItems - the user's requirement / goal items.
 * @param tasks - the team's tasks.
 * @returns `{ goal_item, task_ids, status }` per item, where status is
 *   `missing`, `blocked`, `passed` or `in_progress`.
 */
export function buildCoverageMatrix(goalItems, tasks) {
  return goalItems.map(goalItem => {
    const covering = tasks.filter(item => item.coverageOf?.includes(goalItem))
    const taskIds = covering.map(item => item.id)
    if (covering.length === 0) return { goal_item: goalItem, task_ids: taskIds, status: 'missing' }
    if (covering.some(item => item.status === 'failed' || item.status === 'cancelled')) {
      return { goal_item: goalItem, task_ids: taskIds, status: 'blocked' }
    }
    if (covering.every(item => item.status === 'completed')) {
      return { goal_item: goalItem, task_ids: taskIds, status: 'passed' }
    }
    return { goal_item: goalItem, task_ids: taskIds, status: 'in_progress' }
  })
}
