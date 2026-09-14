// What work a member should be given, and what it is told.
//
// Ported from agent-teams' `scheduler.ts` (`ownedOpenTask`, `nextReadyTask`,
// `formatDependencyOutputs`, `assignmentPrompt`, `fallbackMailboxPrompt`).
// Separated from the scheduler that calls them because the selection order and
// the prompt text are the parts that decide what actually happens; the event
// wiring around them only decides *when* to ask.
import { unsatisfiedDependencies } from './dependencies.js'

/** Longest single dependency output carried into an assignment prompt. */
export const DEPENDENCY_OUTPUT_MAX_CHARS = 2_000
/** Longest combined dependency-output block; older entries drop first. */
export const DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12_000

/** Prompt lines the automatic assignment template names, in contract order. */
const STRUCTURED_KINDS = Object.freeze(['implementation', 'repair', 'verification', 'integration'])

/**
 * The task a member already owns and has not finished.
 *
 * Checked before anything new: a member that went idle mid-attempt must finish
 * that attempt before being handed different work, or the two interleave.
 */
export function ownedOpenTask(tasks, memberName) {
  return tasks.find(task => task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

/**
 * The next claimable task for a member.
 *
 * Claimable means pending, not mid-reassignment, and with every dependency
 * completed. Among those, the member's own assignments come first, then the
 * unassigned pool — a member picks up its own work before reaching for
 * something nobody owns.
 */
export function nextReadyTask(tasks, memberName) {
  const ready = tasks.filter(task => task.status === 'pending'
    && task.reassigning !== true
    && unsatisfiedDependencies(tasks, task.dependencies).length === 0)
  return ready.find(task => task.assignee === memberName)
    ?? ready.find(task => task.assignee === undefined)
}

/**
 * Render completed dependency results for the member that depends on them.
 *
 * Trimming drops the *oldest* entries first, and only then truncates a single
 * oversized one. A dependency list is ordered, so the most recent result is the
 * one most likely to still be relevant — discarding from the front keeps it.
 *
 * @param items - `{ id, subject, output?, profileSeedId? }` per completed task.
 * @returns the block of text, or `(none)`.
 */
export function formatDependencyOutputs(items) {
  if (items.length === 0) return '(none)'
  const formatted = items.map(item => {
    const seed = item.profileSeedId === undefined ? '' : ` [${item.profileSeedId}]`
    const raw = item.output === undefined || item.output === '' ? '(no output recorded)' : item.output
    const truncated = raw.length > DEPENDENCY_OUTPUT_MAX_CHARS
    const body = truncated ? `${raw.slice(0, DEPENDENCY_OUTPUT_MAX_CHARS)} [truncated]` : raw
    return `- ${item.id}${seed} ${item.subject}:\n  ${body}`
  })
  let selected = formatted
  while (selected.length > 1 && selected.join('\n').length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = selected.slice(1)
  }
  const last = selected[0]
  if (selected.length === 1 && last !== undefined && last.length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = [`${last.slice(0, DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS)} [truncated]`]
  }
  return selected.join('\n')
}

/** Messages persisted while live delivery was unavailable, for one turn. */
export function fallbackMailboxPrompt(messages) {
  return [
    'dsh-flow delivered messages that were persisted while live delivery was unavailable:',
    ...messages.map(message => `\nFrom ${message.from}:\n${message.content}`),
    '\nHandle these messages in this turn. Task assignments still require flow_claim_task and the current attempt_id.',
  ].join('\n')
}

/**
 * The prompt an automatically assigned member receives.
 *
 * This is the whole contract a member works from, so it states the completion
 * rules rather than pointing at them: which kinds need a verdict, which need
 * acceptance results and commands, and that the attempt id must accompany every
 * update. A member that has to infer those gets them wrong in ways that only
 * show up as a task that will not complete.
 *
 * @param ticket - the dispatch ticket.
 * @param stateDir - the state directory, named as read-only diagnostics.
 * @param teamId - the team id.
 * @returns the prompt text.
 */
export function assignmentPrompt(ticket, stateDir, teamId) {
  const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`
  const seed = ticket.profileSeedId === undefined ? '' : ` [${ticket.profileSeedId}]`
  const goal = ticket.teamDescription?.trim() || '(not provided)'
  const protocol = ticket.profileProtocol?.trim() || '(none)'
  const executionPrompt = ticket.executionPrompt?.trim()
  const kind = ticket.kind?.trim() || 'work'
  const contract = [
    `Kind: ${kind}${ticket.round === undefined ? '' : ` (round ${ticket.round})`}`,
    ticket.objective === undefined || ticket.objective === '' ? '' : `Objective: ${ticket.objective}`,
    ticket.inScope === undefined || ticket.inScope.length === 0 ? '' : `In scope: ${ticket.inScope.join(', ')}`,
    ticket.outOfScope === undefined || ticket.outOfScope.length === 0 ? '' : `Out of scope: ${ticket.outOfScope.join(', ')}`,
    ticket.acceptance === undefined || ticket.acceptance.length === 0 ? '' : `Acceptance: ${ticket.acceptance.join('; ')}`,
    ticket.verify === undefined || ticket.verify.length === 0 ? '' : `Verify: ${ticket.verify.join('; ')}`,
    ticket.reviewedTaskId === undefined ? '' : `Reviewed task: ${ticket.reviewedTaskId}`,
  ].filter(line => line !== '').join('\n')
  const structuredCompletion = STRUCTURED_KINDS.includes(kind)
    ? `
Structured completion payload (keep these arrays in contract order):
acceptanceResults: ${JSON.stringify((ticket.acceptance ?? []).map(criterion => ({ criterion, status: 'passed', evidence: '<what proved it>' })))}
commandsRun: ${JSON.stringify((ticket.verify ?? []).map(command => ({ command, status: 'passed', exitCode: 0, evidence: '<observed result>' })))}
${kind === 'implementation' || kind === 'repair' ? 'changedPaths: list the actual workspace-relative POSIX paths you changed.\n' : ''}`
    : ''
  return `dsh-flow automatic task assignment from the shared task list.

You are executing as configured member "${ticket.memberName}".
Do not start a teammate's assigned task.

Team goal:
${goal}

Profile protocol:
${protocol}
${executionPrompt === undefined || executionPrompt === '' ? '' : `
Execution guidance:
${executionPrompt}
`}
Completed dependency results:
${formatDependencyOutputs(ticket.dependencyOutputs)}

Task: ${ticket.taskId}${seed} — ${ticket.subject}${description}
${contract === '' ? '' : `\nContract:\n${contract}\n`}
${structuredCompletion}
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}

Call flow_claim_task for ${ticket.taskId}; it will return this same attempt_id. Include attempt_id=${ticket.attemptId} in every flow_update_task call. If it is rejected as stale, stop work because the task was reassigned. claimed cannot jump to completed. Mark in_progress first, then completed or failed. Include attempt_id on every update. Then send_message to captain and become idle.
When finishing: use status=completed only when the task's success criteria are satisfied; use status=failed when blocking findings or validation failures mean downstream work must not proceed; include a concise output in either case. Quality kinds must submit structured fields: review/requirements need verdict=pass to complete (needs_revision/reject must fail with findings); implementation/repair/verification/integration need acceptanceResults and commandsRun, while implementation/repair also need in-scope changedPaths. Use status values "passed" or "failed" inside those arrays. After the work and verification finish, call flow_update_task immediately; do not wait for captain confirmation and do not continue exploring. Do not approve your own implementation. Mail is not a formal next review. Treat the dependency results above as source material. Do not ignore them. Work only this task and only its in-scope paths in this turn.

State policy: ${stateDir}/${teamId}/ is read-only diagnostics; mutate team state only through flow_* tools.`
}
