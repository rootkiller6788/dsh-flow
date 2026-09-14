// Completion gate. Ported from `dsh-agent-teams/src/quality-gates.ts`
// (`evaluateQualityCompletion`, `openHighFindings`, `acceptanceCovered`,
// `verifyCovered`).
//
// This is where "done" stops meaning "the worker said so". A quality task may
// not complete without the evidence its kind requires: a verdict for a review,
// a passed result for every acceptance criterion, a passed command for every
// verify entry, and — for the kinds that touch files — a changed-path list that
// stays inside the declared scope.
import { TASK_TRANSITIONS } from './constants.js'
import { taskKindOf } from './gates.js'
import { classifyChangedPath } from './paths.js'

/** Unresolved findings severe enough to block a pass. */
export function openHighFindings(findings) {
  return (findings ?? []).filter(finding => (
    finding.resolved !== true && (finding.severity === 'high' || finding.severity === 'blocker')
  ))
}

/**
 * Whether every required acceptance criterion is covered by a passed result.
 *
 * Two ways to qualify: an exact criterion match with `passed`, or a
 * same-length all-pass report. The second exists because a model may paraphrase
 * punctuation or whitespace in `criterion`, and rejecting on display text would
 * turn a label into an opaque id — verification evidence is required
 * independently, so loosening the label match does not loosen the gate.
 */
export function acceptanceCovered(required, results) {
  if (results === undefined) return false
  const byCriterion = new Map(results.map(item => [item.criterion, item]))
  if ((required ?? []).every(criterion => byCriterion.get(criterion)?.status === 'passed')) return true
  return results.length === (required ?? []).length && results.every(item => item.status === 'passed')
}

/** Whether every required verification command is covered by a passed result. */
export function verifyCovered(required, results) {
  if (results === undefined) return false
  const byCommand = new Map(results.map(item => [item.command, item]))
  if ((required ?? []).every(command => byCommand.get(command)?.status === 'passed')) return true
  return results.length === (required ?? []).length && results.every(item => item.status === 'passed')
}

/**
 * Validate a proposed update to one task.
 *
 * @param task - the task's current record.
 * @param update - the proposed fields, all optional.
 * @returns `{ ok: true }`, or `{ ok: false, error, requiredStatus? }` where
 *   `requiredStatus` names the status the caller should use instead.
 */
export function evaluateQualityCompletion(task, update) {
  const nextStatus = update.status
  if (nextStatus !== undefined && nextStatus !== task.status) {
    // The original declares its own copy of this table; it is identical to the
    // one in `constants.js`, so the two uses share one definition here rather
    // than being able to drift apart.
    if (!TASK_TRANSITIONS[task.status].includes(nextStatus)) {
      return { ok: false, error: `task status cannot move from "${task.status}" to "${nextStatus}"` }
    }
  }

  const kind = taskKindOf(task)
  if (kind === 'work') return { ok: true }

  const verdict = update.verdict ?? task.verdict
  const findings = update.findings ?? task.findings
  if (kind === 'review' || kind === 'requirements') {
    if (nextStatus === 'completed') {
      if (verdict === undefined) return { ok: false, error: `${kind} cannot complete without verdict=pass` }
      if (verdict !== 'pass') return { ok: false, error: `${kind} with verdict=${verdict} cannot complete` }
      if (openHighFindings(findings).length > 0) {
        return { ok: false, error: `${kind} pass cannot leave unresolved high/blocker findings` }
      }
    }
    if (nextStatus === 'failed' && (verdict === 'needs_revision' || verdict === 'reject')) {
      if ((findings ?? []).length < 1) {
        return { ok: false, error: `${kind} ${verdict} requires at least one finding` }
      }
    }
    return { ok: true }
  }

  if (kind === 'implementation' || kind === 'repair' || kind === 'verification' || kind === 'integration') {
    const commands = update.commandsRun ?? task.commandsRun
    // A failed command cannot be reported as success. The task is still allowed
    // to *fail* normally; what is rejected is completing while a command that
    // ran reported failure.
    if (commands?.some(item => item.status === 'failed') === true) {
      if (nextStatus === 'completed') {
        return { ok: false, error: 'verify failure must fail the task', requiredStatus: 'failed' }
      }
    }
    if (nextStatus !== 'completed') return { ok: true }
    const acceptanceResults = update.acceptanceResults ?? task.acceptanceResults
    if (acceptanceResults === undefined || !acceptanceCovered(task.acceptance, acceptanceResults)) {
      return { ok: false, error: `${kind} completion requires passed acceptanceResults for every acceptance item` }
    }
    if (commands === undefined || !verifyCovered(task.verify, commands)) {
      return { ok: false, error: `${kind} completion requires a passed commandsRun entry for every verify command` }
    }
    if (kind === 'implementation' || kind === 'repair') {
      const changed = update.changedPaths ?? task.changedPaths
      if (changed === undefined) {
        return { ok: false, error: `${kind} completion requires changedPaths` }
      }
      for (const path of changed) {
        const classification = classifyChangedPath(path, task.inScope ?? [], task.outOfScope ?? [])
        if (classification !== 'in_scope') {
          return { ok: false, error: `${kind} cannot complete: ${path} is ${classification}` }
        }
      }
    }
  }
  return { ok: true }
}
