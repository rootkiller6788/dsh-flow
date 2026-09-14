// Task-creation gate. Ported from `dsh-agent-teams/src/quality-gates.ts`
// (`validateCreateTask`, `taskKindOf`, `isQualityKind`, `dependentOn`,
// `resolveReviewPolicy`).
//
// The gate is what makes a task list mean something: a quality task without an
// objective, an implementation with no scope, a review of a task that does not
// exist — all are rejected before the record is written, so the durable file
// never contains work nobody could execute or verify.
import {
  DEFAULT_REVIEW_POLICY, OPEN_STATUSES, QUALITY_KINDS, TASK_KINDS, WRITE_KINDS,
} from './constants.js'
import { inScopeOverlap } from './paths.js'

/** The kind a task is treated as having; absent or unknown reads as `work`. */
export function taskKindOf(task) {
  return task?.kind ?? 'work'
}

/** Whether a kind carries the structured quality contract. */
export function isQualityKind(kind) {
  return kind !== undefined && kind !== 'work' && QUALITY_KINDS.includes(kind)
}

/** Fill a review policy's unset limits from the defaults. */
export function resolveReviewPolicy(policy) {
  return {
    ...DEFAULT_REVIEW_POLICY,
    ...policy,
    requirementsMinRounds: policy?.requirementsMinRounds ?? DEFAULT_REVIEW_POLICY.requirementsMinRounds,
    requirementsMaxRounds: policy?.requirementsMaxRounds ?? DEFAULT_REVIEW_POLICY.requirementsMaxRounds,
    codeMaxRounds: policy?.codeMaxRounds ?? DEFAULT_REVIEW_POLICY.codeMaxRounds,
    maxRepairAttempts: policy?.maxRepairAttempts ?? DEFAULT_REVIEW_POLICY.maxRepairAttempts,
  }
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function nonemptyStringList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonemptyString)
}

/**
 * Whether `targetId` is reachable by following `dependencies` transitively.
 * Iterative rather than recursive, and visited-guarded, so a cycle in the
 * existing task graph cannot make this loop.
 */
export function dependencyClosureContains(tasks, dependencies, targetId) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const pending = [...dependencies]
  const visited = new Set()
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined || visited.has(id)) continue
    if (id === targetId) return true
    visited.add(id)
    pending.push(...(byId.get(id)?.dependencies ?? []))
  }
  return false
}

/**
 * Validate a proposed task against the team it is being added to.
 *
 * @param team - the team the task would join.
 * @param input - the proposed task.
 * @returns `{ ok: false, error }`, or `{ ok: true, kind, team, task }` where
 *   `team` is the post-resume state when the input also unhalts the team.
 */
export function validateCreateTask(team, input) {
  const kind = input.kind ?? 'work'
  if (!TASK_KINDS.includes(kind)) {
    return { ok: false, error: `unknown task kind "${String(kind)}"` }
  }

  if (team.halted === true) {
    const reason = input.resumeReason?.trim() ?? ''
    if (input.resume !== true || reason === '') {
      return { ok: false, error: 'team is halted; resume with a non-empty reason before create_task' }
    }
  }

  if (isQualityKind(kind)) {
    if (!nonemptyString(input.objective)) {
      return { ok: false, error: `${kind} tasks require a non-empty objective` }
    }
    if (!nonemptyStringList(input.acceptance)) {
      return { ok: false, error: `${kind} tasks require at least one acceptance criterion` }
    }
  }
  if (WRITE_KINDS.includes(kind)) {
    if (!nonemptyStringList(input.inScope)) {
      return { ok: false, error: `${kind} tasks require a non-empty inScope` }
    }
    if (!nonemptyStringList(input.verify)) {
      return { ok: false, error: `${kind} tasks require a non-empty verify list` }
    }
  }
  if (kind === 'review') {
    if (!nonemptyString(input.reviewedTaskId)) {
      return { ok: false, error: 'review tasks require reviewedTaskId' }
    }
    if (!team.tasks.some(item => item.id === input.reviewedTaskId)) {
      return { ok: false, error: `reviewed task "${input.reviewedTaskId}" does not exist` }
    }
  }
  if (kind === 'repair') {
    if (!nonemptyString(input.sourceTaskId) || !nonemptyStringList(input.sourceFindingIds)) {
      return { ok: false, error: 'repair tasks require sourceTaskId and at least one sourceFindingId' }
    }
    if (!team.tasks.some(item => item.id === input.sourceTaskId)) {
      return { ok: false, error: `source task "${input.sourceTaskId}" does not exist` }
    }
  }

  const dependencies = input.dependencies ?? []
  for (const dependency of dependencies) {
    const upstream = team.tasks.find(item => item.id === dependency)
    if (upstream === undefined) {
      return { ok: false, error: `dependency "${dependency}" does not exist` }
    }
    if ((kind === 'repair' || kind === 'review') && (upstream.status === 'failed' || upstream.status === 'cancelled')) {
      return { ok: false, error: `${kind} must not depend on ${upstream.status} task "${dependency}"` }
    }
  }

  if (WRITE_KINDS.includes(kind) && nonemptyStringList(input.inScope)) {
    for (const other of team.tasks) {
      if (!WRITE_KINDS.includes(taskKindOf(other))) continue
      if (!OPEN_STATUSES.includes(other.status)) continue
      // Two concurrent writers may not declare overlapping scope. The original
      // guards this twice: the second test is dead for every id the first one
      // can match, because it can only be reached when `dependencies` does not
      // contain `other.id`. It is kept verbatim — a hand-written team.json
      // could name a task `pending-new`, and only the original's behaviour on
      // that input is the reference we are matching.
      if (dependencies.includes(other.id) || other.dependencies.includes('pending-new')) continue
      if (dependencies.includes(other.id)) continue
      const overlap = inScopeOverlap(input.inScope, other.inScope)
      if (overlap.length > 0) {
        return {
          ok: false,
          error: `inScope overlaps ${other.id} at ${overlap.join(', ')}; serialize these tasks or split the paths`,
        }
      }
    }
  }

  if (kind === 'implementation') {
    const requirements = team.tasks.filter(item => taskKindOf(item) === 'requirements')
    const passed = requirements.some(item => item.status === 'completed' && item.verdict === 'pass')
    // Staged plans are written before anything runs, so an implementation may
    // sit behind a requirements task that has not completed yet — provided it
    // actually depends on it, which is what makes the ordering real.
    const stagedBehindRequirements = team.phase === 'staged' && requirements.some(item => (
      dependencyClosureContains(team.tasks, dependencies, item.id)
    ))
    if (requirements.length > 0 && !passed && !stagedBehindRequirements) {
      return {
        ok: false,
        error: team.phase === 'staged'
          ? 'implementation must depend on the staged requirements task; it will run only after requirements passes'
          : 'implementation is blocked until a requirements task completes with verdict=pass',
      }
    }
  }

  const nextTeam = team.halted === true && input.resume === true
    ? { ...team, halted: false, haltedAt: undefined }
    : team
  return {
    ok: true,
    kind,
    team: nextTeam,
    task: {
      subject: input.subject,
      kind,
      ...input.description === undefined ? {} : { description: input.description },
      ...input.assignee === undefined ? {} : { assignee: input.assignee },
      dependencies,
      ...input.round === undefined ? {} : { round: input.round },
      ...input.objective === undefined ? {} : { objective: input.objective },
      ...input.inScope === undefined ? {} : { inScope: input.inScope },
      ...input.outOfScope === undefined ? {} : { outOfScope: input.outOfScope },
      ...input.acceptance === undefined ? {} : { acceptance: input.acceptance },
      ...input.verify === undefined ? {} : { verify: input.verify },
      ...input.deliverables === undefined ? {} : { deliverables: input.deliverables },
      ...input.nonGoals === undefined ? {} : { nonGoals: input.nonGoals },
      ...input.reviewedTaskId === undefined ? {} : { reviewedTaskId: input.reviewedTaskId },
      ...input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId },
      ...input.sourceFindingIds === undefined ? {} : { sourceFindingIds: input.sourceFindingIds },
      ...input.coverageOf === undefined ? {} : { coverageOf: input.coverageOf },
    },
  }
}
