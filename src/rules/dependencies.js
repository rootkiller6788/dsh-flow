// Dependency graph rules. Ported from `dsh-agent-teams/src/state.ts`
// (`unsatisfiedDependencies`, `taskDepthsById`, `taskVisualState`).

/**
 * Whether `dependencies` are all satisfied for the given task list.
 *
 * A dependency counts as satisfied only when the named task **exists and
 * completed**. A dangling id — one naming a task that is not in the list —
 * therefore counts as *unsatisfied*, which permanently blocks the claim. That
 * is deliberate: a dependency on a deleted task is a broken record, and
 * silently ignoring it would let work start against a plan nobody can see.
 *
 * @param tasks - the team's tasks.
 * @param dependencies - task ids the candidate depends on.
 * @returns the ids that are still unsatisfied, empty when claimable.
 */
export function unsatisfiedDependencies(tasks, dependencies) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  return dependencies.filter(id => byId.get(id)?.status !== 'completed')
}

/**
 * Longest dependency path depth per task id (each depth = one lane column).
 *
 * Cycle-safe rather than cycle-rejecting: a back edge contributes 0, so every
 * member of a cycle still gets a finite depth instead of recursing forever or
 * throwing. The first-encountered member of a cycle ends up one deeper than the
 * others, which is an artefact of traversal order rather than a meaningful
 * rank — the data is simply wrong at that point, and `isTeamState` does not
 * reject it.
 *
 * @param tasks - the team's tasks.
 * @returns a map from task id to depth.
 */
export function taskDepthsById(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const depths = new Map()
  const visiting = new Set()
  const depthOf = taskId => {
    const cached = depths.get(taskId)
    if (cached !== undefined) return cached
    if (visiting.has(taskId)) return 0
    const task = byId.get(taskId)
    if (task === undefined) return 0
    visiting.add(taskId)
    // Sorted so evaluation order — and therefore which member of a cycle is
    // visited first — does not depend on the order of the dependency list.
    const dependencies = task.dependencies.filter(id => byId.has(id)).sort()
    const depth = dependencies.length === 0 ? 0 : 1 + Math.max(...dependencies.map(depthOf))
    visiting.delete(taskId)
    depths.set(taskId, depth)
    return depth
  }
  for (const task of tasks) depthOf(task.id)
  return depths
}

/**
 * The visual state of one task: `running` while in_progress, `completed` when
 * done, `failed`/`cancelled` when terminal without success, `blocked` while any
 * dependency is unfinished, else `open`.
 *
 * Note the asymmetry with `unsatisfiedDependencies`: a dependency naming a
 * missing task is **not** blocking here, because there is nothing to wait for.
 * The two disagree on exactly the broken records, so a caller that shows one
 * and enforces the other is showing "open" for a task that can never be
 * claimed. Surface the dangling id separately rather than picking a side.
 *
 * @param status - the task's status.
 * @param dependencies - task ids the task depends on.
 * @param tasks - the team's tasks.
 * @returns the display state.
 */
export function taskVisualState(status, dependencies, tasks) {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'in_progress') return 'running'
  const byId = new Map(tasks.map(task => [task.id, task]))
  const openDependency = dependencies.some(id => {
    const dependency = byId.get(id)
    return dependency !== undefined && dependency.status !== 'completed'
  })
  return openDependency ? 'blocked' : 'open'
}

/**
 * Dependencies that name a task which does not exist. `taskVisualState` treats
 * these as non-blocking and `unsatisfiedDependencies` treats them as blocking;
 * exposing them lets a view say which of the two it is looking at.
 *
 * @param tasks - the team's tasks.
 * @param dependencies - task ids the task depends on.
 * @returns the dangling ids.
 */
export function danglingDependencies(tasks, dependencies) {
  const byId = new Set(tasks.map(task => task.id))
  return dependencies.filter(id => !byId.has(id))
}
