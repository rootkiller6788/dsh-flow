// Creating, assigning, claiming and updating work.
//
// These four are where the quality gates live, and the order of their checks is
// load-bearing rather than incidental.
//
// `flow_claim_task` authorizes *before* it returns an existing attempt, so a
// member cannot receive a confident success for somebody else's task.
//
// `flow_update_task` checks the capability before it checks the terminal state,
// so a stale attempt is refused with the reason that matters instead of being
// told the task is finished.
//
// `flow_reassign_task` takes the team lock twice with the interrupt in between,
// and the second lock re-validates the handoff id. That is not defensiveness:
// between the two locks the old member is being interrupted, which is exactly
// the window in which the record can move.
import {
  CAPTAIN_KEY, FINDING_SEVERITIES, TERMINAL_TASK_STATUSES, TASK_KINDS,
  normalizeBlankOptionalTaskFields, transitionError, unsatisfiedDependencies,
  validateCreateTask, evaluateQualityCompletion, planQualityFollowUp,
} from '../rules/index.js'
import { FlowToolError, defineFlowTool } from './define.js'
import {
  locateTeamByCaptain, locateTeamByParticipant, requireFresh, requireMember, requireTask,
  memberOpenTask, captainOpenTask, trimmed,
} from './identity.js'

/** The gate helpers answer with `{ ok: false, error }`; tools refuse by throwing. */
const gate = (result, fallback) => {
  if (!result.ok) throw new FlowToolError(result.error ?? fallback)
  return result
}

/** A trimmed non-blank string, or undefined. */
const text = value => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

/**
 * Parse a review finding list.
 *
 * Every field a finding needs is named, and a malformed one is refused with its
 * index: a finding is what a repair task is derived from, so a finding that
 * silently lost its `requiredFix` would produce a repair with nothing to fix.
 */
function readFindings(raw) {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new FlowToolError('findings must be an array')
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new FlowToolError(`findings[${index}] must be an object`)
    }
    if (text(entry.id) === undefined) throw new FlowToolError(`findings[${index}].id is required`)
    if (!FINDING_SEVERITIES.includes(entry.severity)) throw new FlowToolError(`findings[${index}].severity is invalid`)
    if (text(entry.problem) === undefined) throw new FlowToolError(`findings[${index}].problem is required`)
    if (text(entry.requiredFix) === undefined) throw new FlowToolError(`findings[${index}].requiredFix is required`)
    return {
      id: entry.id,
      severity: entry.severity,
      problem: entry.problem,
      requiredFix: entry.requiredFix,
      ...text(entry.file) === undefined ? {} : { file: entry.file },
      ...Number.isSafeInteger(entry.line) ? { line: entry.line } : {},
      ...typeof entry.resolved === 'boolean' ? { resolved: entry.resolved } : {},
    }
  })
}

/** Parse one evidence list — acceptance results and commands run share a shape. */
function readEvidence(raw, label, field) {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new FlowToolError(`${label} must be an array`)
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new FlowToolError(`${label}[${index}] must be an object`)
    }
    if (text(entry[field]) === undefined) throw new FlowToolError(`${label}[${index}].${field} is required`)
    if (entry.status !== 'passed' && entry.status !== 'failed') {
      throw new FlowToolError(`${label}[${index}].status must be passed or failed`)
    }
    return {
      [field]: entry[field],
      status: entry.status,
      ...field === 'command' && Number.isSafeInteger(entry.exitCode) ? { exitCode: entry.exitCode } : {},
      ...text(entry.evidence) === undefined ? {} : { evidence: entry.evidence },
    }
  })
}

/**
 * Read one update call into the object the completion gate reads.
 *
 * Blank scalars are dropped rather than persisted: a durable record with an
 * empty `objective` or `verdict` fails validation on the next load, which takes
 * the whole team with it. That is why the rule is applied on the way in rather
 * than checked on the way out.
 */
function readTaskUpdate(args) {
  const fields = normalizeBlankOptionalTaskFields(args)
  const findings = readFindings(args.findings)
  const acceptanceResults = readEvidence(args.acceptanceResults, 'acceptanceResults', 'criterion')
  const commandsRun = readEvidence(args.commandsRun, 'commandsRun', 'command')
  return {
    ...args.status === undefined ? {} : { status: args.status },
    ...text(args.output) === undefined ? {} : { output: args.output },
    ...text(args.verdict) === undefined ? {} : { verdict: args.verdict },
    ...findings === undefined ? {} : { findings },
    ...fields.changedPaths === undefined ? {} : { changedPaths: fields.changedPaths },
    ...acceptanceResults === undefined ? {} : { acceptanceResults },
    ...commandsRun === undefined ? {} : { commandsRun },
  }
}

const taskSummary = task => ({
  task_id: task.id,
  status: task.status,
  attempt: task.attempt ?? 0,
  ...task.assignee === undefined ? {} : { assignee: task.assignee },
  ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
  ...task.output === undefined ? {} : { output: task.output },
})

/**
 * The task-creation tool.
 *
 * The plan's gate order is reproduced exactly, including the two checks that
 * look redundant: `validateCreateTask` already rejects a missing dependency,
 * and the per-dependency loop after it rejects the same thing against the
 * *raw* argument list. They differ when a blank entry is normalised away, and
 * which of the two messages a caller sees is part of the port.
 */
export function createTaskTool(deps) {
  return defineFlowTool({
    name: 'flow_create_task',
    description: 'Create a task in your team\'s task list. Every call must include a non-empty subject, including verification and review tasks. Tasks can depend on other tasks (dependencies): a task is only claimable once every dependency is completed. Optionally assign it to a member, who still claims it before working.',
    parameters: {
      teamId: { type: 'string', required: true },
      subject: { type: 'string', required: true, description: 'Required non-empty title for this task. Never omit it, including for verification or review tasks.' },
      description: { type: 'string', description: 'What needs to be done, in detail.' },
      dependencies: { type: 'array', description: 'Task ids this task depends on (must be completed before this task can be claimed).' },
      assignee: { type: 'string', description: 'Optional member name this task is intended for.' },
      kind: { type: 'string', enum: [...TASK_KINDS], description: 'Task kind. Defaults to work (legacy, no quality gates). Quality kinds require a contract.' },
      round: { type: 'number', description: '1-based review / requirements / repair round.' },
      objective: { type: 'string', description: 'Required non-empty objective for quality kinds.' },
      inScope: { type: 'array', description: 'Workspace-relative POSIX paths this task may change.' },
      outOfScope: { type: 'array', description: 'Workspace-relative POSIX paths this task must not change.' },
      acceptance: { type: 'array', description: 'Acceptance criteria. Required for quality kinds.' },
      verify: { type: 'array', description: 'Verification commands. Required for implementation/repair.' },
      deliverables: { type: 'array', description: 'Expected deliverable paths or names.' },
      nonGoals: { type: 'array', description: 'Explicit non-goals.' },
      reviewedTaskId: { type: 'string', description: 'Task being reviewed. Required for kind=review.' },
      sourceTaskId: { type: 'string', description: 'Source implementation/artifact. Required for kind=repair.' },
      sourceFindingIds: { type: 'array', description: 'Finding ids this repair must close.' },
      coverageOf: { type: 'array', description: 'User-constraint / goal items this task covers.' },
      resume: { type: 'boolean', description: 'If true, clear halted in the same lock before creating the task.' },
      resumeReason: { type: 'string', description: 'Required non-empty reason when resume=true.' },
    },
    properties: { task_id: { type: 'string' }, subject: { type: 'string' }, status: { type: 'string' }, assignee: { type: 'string' } },
    required: ['task_id', 'subject', 'status'],
    async execute(args, exec) {
      const located = await locateTeamByCaptain(exec, deps)
      const created = await deps.withTeamLock(located.team.id, async () => {
        const team = await requireFresh(located.team.id, located.caller, 'captain', deps)
        // Blank optional fields are dropped before the gate sees them: an empty
        // `objective` is *absent*, not present-and-empty, and the gate rejects
        // the second while the durable record cannot hold it at all.
        const decision = gate(
          validateCreateTask(team, { ...normalizeBlankOptionalTaskFields(args), resume: args.resume, resumeReason: args.resumeReason }),
          'flow_create_task rejected by the quality gates',
        )

        const now = deps.now()
        const events = []
        // Creating a task by un-halting the team did two things, and the log
        // says both: the resume is a fact the next captain turn reads.
        if (decision.team !== team && team.halted === true) {
          events.push({ type: 'team.resumed', at: now, seq: await deps.nextSeq(team.id), reason: String(args.resumeReason ?? '') })
        }
        // Re-checked against the raw argument list, as the reference does: the
        // two checks differ when normalization dropped a blank entry, and which
        // message a caller sees is part of the behaviour being ported.
        for (const dependency of args.dependencies ?? []) {
          if (!team.tasks.some(task => task.id === dependency)) {
            throw new FlowToolError(`dependency "${dependency}" does not exist in team "${team.name}"`)
          }
        }
        if (args.assignee !== undefined) requireMember(team, args.assignee)

        const task = { ...decision.task, id: `t${team.taskSeq + 1}` }
        events.push({ type: 'task.created', at: now, seq: await deps.nextSeq(team.id), task })
        await deps.appendEvents(team.id, events)
        await deps.materialize(team.id)
        return task
      })

      await deps.kickTeam(located.team.id)
      return {
        task_id: created.id,
        subject: created.subject,
        status: created.status ?? 'pending',
        ...created.assignee === undefined ? {} : { assignee: created.assignee },
      }
    },
    render: (args, value) => [{
      type: 'text',
      text: `Task "${value.subject}" created as ${value.task_id} (status ${value.status}${value.assignee === undefined ? '' : `, assigned to ${value.assignee}`}).`,
    }],
  })
}

/** The captain's assign-and-wake tool. */
export function reassignTaskTool(deps) {
  return defineFlowTool({
    name: 'flow_reassign_task',
    description: 'Atomically retry, reassign, or let the captain take over one ready unfinished/failed task. The old attempt is revoked before its member is interrupted, so late updates cannot overwrite the new owner. Use assignee="captain" only when you will finish that task in this turn; a captain can own only one unfinished takeover at a time, and an unfinished takeover returns to the member pool when the captain becomes idle.',
    parameters: {
      teamId: { type: 'string', required: true },
      task_id: { type: 'string', required: true, description: 'Task to retry/reassign.' },
      assignee: { type: 'string', required: true, description: 'Active member name, or "captain" for captain takeover.' },
      reason: { type: 'string', description: 'Why the task is being retried or reassigned.' },
    },
    properties: {
      task_id: { type: 'string' }, previous_assignee: { type: 'string' }, assignee: { type: 'string' },
      status: { type: 'string' }, attempt: { type: 'number' }, attempt_id: { type: 'string' },
    },
    required: ['task_id', 'previous_assignee', 'assignee', 'status', 'attempt'],
    async execute(args, exec) {
      const located = await locateTeamByCaptain(exec, deps)
      const target = String(args.assignee ?? '').trim()
      if (target === '') throw new FlowToolError('reassignment assignee must not be empty')

      // Lock one: revoke, and make the revocation durable, before anything is
      // interrupted. A member that is interrupted first can still write one
      // more update against a capability that is still valid.
      const revoked = await deps.withTeamLock(located.team.id, async () => {
        const team = await requireFresh(located.team.id, located.caller, 'captain', deps)
        const task = requireTask(team, args.task_id)
        if (task.status === 'completed') {
          throw new FlowToolError(`completed task ${task.id} is immutable and cannot be reassigned`)
        }
        if (task.reassigning === true) throw new FlowToolError(`task ${task.id} is already being reassigned`)

        const targetMember = target === CAPTAIN_KEY ? undefined : requireMember(team, target)
        if (target === CAPTAIN_KEY) {
          const busy = captainOpenTask(team, task.id)
          if (busy !== undefined) {
            throw new FlowToolError(`captain is busy with ${busy.id}; complete or reassign it before taking over ${task.id}`)
          }
          const pending = unsatisfiedDependencies(team.tasks, task.dependencies)
          if (pending.length > 0) {
            throw new FlowToolError(`task ${task.id} is blocked by unfinished dependencies: ${pending.join(', ')} — complete them before captain takeover`)
          }
        } else {
          const busy = memberOpenTask(team, targetMember.name, task.id)
          if (busy !== undefined) {
            throw new FlowToolError(`member "${targetMember.name}" is busy with ${busy.id}; finish or reassign it first`)
          }
        }

        const previousAssignee = task.assignee
        const previousMember = task.status === 'claimed' || task.status === 'in_progress'
          ? team.members.find(candidate => candidate.name === task.assignee && candidate.status !== 'removed')
          : undefined
        const handoffId = deps.randomId()
        const now = deps.now()
        const revokedAttemptId = task.attemptId

        task.attemptId = undefined
        task.handoffId = handoffId
        task.status = 'pending'
        task.assignee = target
        task.reassigning = true
        task.output = undefined
        task.updatedAt = now

        await deps.appendEvents(team.id, [{
          type: 'task.rolled_back',
          at: now,
          seq: await deps.nextSeq(team.id),
          id: task.id,
          toStatus: 'pending',
          reason: trimmed(args.reason) ?? `reassigned to ${target}`,
          assignee: target,
          attempt: task.attempt ?? 0,
          ...revokedAttemptId === undefined ? {} : { attemptId: revokedAttemptId },
        }])
        await deps.materialize(team.id)
        return { teamId: team.id, taskId: task.id, previousAssignee, previousMember, handoffId, target }
      })

      // Outside the lock: interrupt and wait. An interrupt is a request, and
      // the wait is how the handoff becomes an effect rather than an intention.
      let quiescenceError
      if (revoked.previousMember?.id !== undefined && revoked.previousMember.id !== '') {
        deps.interruptMember({ targetSessionId: revoked.previousMember.id, parentSessionId: located.caller.id })
        try {
          await deps.waitForIdle({ memberId: revoked.previousMember.id, signal: exec?.signal })
        } catch (error) {
          // Deferred rather than thrown here: the revocation is already
          // durable, and leaving the handoff half-applied would be worse than
          // completing it and reporting the failure.
          quiescenceError = error
        }
      }

      await deps.withTeamLock(revoked.teamId, async () => {
        const team = await requireFresh(revoked.teamId, located.caller, 'captain', deps)
        const task = requireTask(team, revoked.taskId)
        if (task.handoffId !== revoked.handoffId || task.assignee !== revoked.target || task.reassigning !== true) {
          throw new FlowToolError(`task ${task.id} changed during reassignment; refusing to overwrite the newer state`)
        }
        const now = deps.now()
        task.reassigning = false
        const events = []
        if (quiescenceError === undefined && revoked.target === CAPTAIN_KEY) {
          task.attempt = (task.attempt ?? 0) + 1
          task.attemptId = deps.randomId()
          task.status = 'in_progress'
          task.updatedAt = now
          events.push({
            type: 'task.attempt_started',
            at: now,
            seq: await deps.nextSeq(team.id),
            id: task.id,
            attemptId: task.attemptId,
            attempt: task.attempt,
            assignee: CAPTAIN_KEY,
          })
        } else {
          task.updatedAt = now
          events.push({
            type: 'task.transitioned',
            at: now,
            seq: await deps.nextSeq(team.id),
            id: task.id,
            from: 'pending',
            to: task.status,
          })
        }
        await deps.appendEvents(team.id, events)
        await deps.materialize(team.id)
      })
      if (quiescenceError !== undefined) throw quiescenceError

      const team = await deps.readTeam(revoked.teamId)
      if (team === undefined) throw new FlowToolError(`team "${located.team.name}" ended during reassignment`)
      const task = requireTask(team, revoked.taskId)
      if (revoked.target !== CAPTAIN_KEY) await deps.kickMember(revoked.teamId, revoked.target)

      return {
        task_id: task.id,
        previous_assignee: revoked.previousAssignee ?? '',
        assignee: task.assignee ?? '',
        status: task.status,
        attempt: task.attempt ?? 0,
        ...task.attemptId === undefined ? {} : { attempt_id: task.attemptId },
      }
    },
    render: (args, value) => [{
      type: 'text',
      text: `Task ${value.task_id} reassigned ${value.previous_assignee || 'unassigned'} → ${value.assignee} (attempt ${value.attempt}, status ${value.status}${value.attempt_id === undefined ? '' : `, attempt_id ${value.attempt_id}`}).`,
    }],
  })
}

/**
 * The member's claim tool.
 *
 * A member claims its own work; a captain does not use this to hand work out.
 * The distinction is not etiquette — a captain claiming on a member's behalf
 * would take the work without waking anyone, which is the failure mode where a
 * task looks assigned and nothing ever happens.
 */
export function claimTaskTool(deps) {
  return defineFlowTool({
    name: 'flow_claim_task',
    description: 'Members claim their own ready task or read their existing attempt_id. Captains must use flow_reassign_task to assign and wake a member; flow_claim_task does not dispatch work. A member cannot own a second unfinished task. The returned attempt_id is required for updates and becomes stale after retry/reassignment.',
    parameters: {
      teamId: { type: 'string', required: true },
      task_id: { type: 'string', required: true, description: 'The task id to claim.' },
      assignee: { type: 'string', description: 'Deprecated: flow_claim_task only supports a member claiming its own task. Captains must use flow_reassign_task.' },
    },
    properties: {
      task_id: { type: 'string' }, status: { type: 'string' }, assignee: { type: 'string' },
      attempt: { type: 'number' }, attempt_id: { type: 'string' },
    },
    required: ['task_id', 'status', 'assignee', 'attempt'],
    async execute(args, exec) {
      const located = await locateTeamByParticipant(exec, deps)
      const claimed = await deps.withTeamLock(located.team.id, async () => {
        const team = await requireFresh(located.team.id, located.caller, 'participant', deps)
        const task = requireTask(team, args.task_id)
        if (task.reassigning === true) {
          throw new FlowToolError(`task ${task.id} is being reassigned; wait for the handoff to finish`)
        }

        const isCaptain = located.caller.kind === 'captain'
        if (isCaptain) {
          if (args.assignee !== undefined || task.assignee !== CAPTAIN_KEY
            || (task.status !== 'claimed' && task.status !== 'in_progress')) {
            throw new FlowToolError('flow_claim_task is for members claiming their own task; captains must use flow_reassign_task to assign and wake a member')
          }
        } else {
          if (args.assignee !== undefined) throw new FlowToolError('members cannot set assignee when claiming a task')
          if (task.assignee !== undefined && task.assignee !== located.caller.name) {
            throw new FlowToolError(`task ${task.id} is assigned to "${task.assignee}", not you`)
          }
        }
        const assignee = isCaptain ? task.assignee : located.caller.name

        // Authorization happens before the idempotent return, deliberately:
        // another member must not receive a confident success for a task that
        // is not theirs.
        if (task.status === 'claimed' || task.status === 'in_progress') {
          if (assignee === undefined || task.assignee !== assignee) {
            throw new FlowToolError(`task ${task.id} is already claimed by "${task.assignee ?? 'nobody'}"`)
          }
          return { ...taskSummary(task), assignee }
        }

        const pending = unsatisfiedDependencies(team.tasks, task.dependencies)
        if (pending.length > 0) {
          throw new FlowToolError(`task ${task.id} is blocked by unfinished dependencies: ${pending.join(', ')} — complete them first`)
        }
        const transition = transitionError(task.status, 'claimed')
        if (transition !== undefined) throw new FlowToolError(transition)
        if (assignee === undefined) {
          throw new FlowToolError('claiming an unassigned task needs an assignee (claim on behalf of a member)')
        }
        const busy = memberOpenTask(team, assignee, task.id)
        if (busy !== undefined) {
          throw new FlowToolError(`member "${assignee}" is busy with ${busy.id}; finish or reassign it first`)
        }

        const now = deps.now()
        task.attempt = (task.attempt ?? 0) + 1
        task.status = 'claimed'
        task.assignee = assignee
        task.attemptId = deps.randomId()
        task.handoffId = undefined
        task.reassigning = false
        task.output = undefined
        task.updatedAt = now

        await deps.appendEvents(team.id, [{
          type: 'task.attempt_started',
          at: now,
          seq: await deps.nextSeq(team.id),
          id: task.id,
          attemptId: task.attemptId,
          attempt: task.attempt,
          assignee,
        }])
        await deps.materialize(team.id)
        return { ...taskSummary(task), assignee }
      })

      return {
        task_id: claimed.task_id,
        status: claimed.status,
        assignee: claimed.assignee,
        attempt: claimed.attempt,
        ...claimed.attempt_id === undefined ? {} : { attempt_id: claimed.attempt_id },
      }
    },
    render: (args, value) => [{
      type: 'text',
      text: `Task ${value.task_id} claimed by ${value.assignee} (attempt ${value.attempt}${value.attempt_id === undefined ? '' : `, attempt_id ${value.attempt_id}`}, status ${value.status}).`,
    }],
  })
}

/**
 * The work-reporting tool.
 *
 * This is where "done" stops meaning "the worker said so". Everything a quality
 * task must prove — a verdict, acceptance evidence, verification commands, a
 * changed-path list inside the declared scope — is required before the status
 * may move to completed, and a failed review or requirements round *derives*
 * the next round's tasks rather than leaving the captain to notice.
 */
export function updateTaskTool(deps) {
  return defineFlowTool({
    name: 'flow_update_task',
    description: 'Update a task status/output. Members must supply the current attempt_id returned by flow_claim_task; stale attempts are rejected after takeover/reassignment. Terminal results are immutable. A captain must use flow_reassign_task(assignee="captain") before updating member-owned work.',
    parameters: {
      teamId: { type: 'string', required: true },
      task_id: { type: 'string', required: true, description: 'The task id to update.' },
      status: { type: 'string', enum: ['in_progress', 'completed', 'failed', 'cancelled'], description: 'New status (in_progress, completed, failed, cancelled).' },
      output: { type: 'string', description: 'Result summary; set when completing or failing.' },
      attempt_id: { type: 'string', description: 'Current execution capability returned by flow_claim_task (required for members when present on the task).' },
      verdict: { type: 'string', enum: ['pass', 'needs_revision', 'reject'], description: 'Required for completing requirements/review. needs_revision and reject must fail the task.' },
      findings: { type: 'array', description: 'Structured review findings. Required when verdict is needs_revision or reject; each item needs id, severity, problem, and requiredFix.' },
      changedPaths: { type: 'array', description: 'Workspace-relative POSIX paths changed by this implementation/repair.' },
      acceptanceResults: { type: 'array', description: 'Acceptance evidence in contract order: {criterion, status:"passed"|"failed", evidence?}. Supply one item per acceptance criterion.' },
      commandsRun: { type: 'array', description: 'Verification evidence in contract order: {command, status:"passed"|"failed", exitCode?, evidence?}. Supply one item per verify command.' },
    },
    properties: {
      task_id: { type: 'string' }, status: { type: 'string' }, output: { type: 'string' },
      attempt: { type: 'number' }, attempt_id: { type: 'string' },
    },
    required: ['task_id', 'status', 'attempt'],
    async execute(args, exec) {
      const located = await locateTeamByParticipant(exec, deps)
      const updated = await deps.withTeamLock(located.team.id, async () => {
        const team = await requireFresh(located.team.id, located.caller, 'participant', deps)
        const task = requireTask(team, args.task_id)

        if (located.caller.kind === 'captain' && task.assignee !== undefined && task.assignee !== CAPTAIN_KEY) {
          throw new FlowToolError(`task ${task.id} is owned by member "${task.assignee}"; call flow_reassign_task with assignee="captain" before takeover`)
        }
        if (located.caller.kind === 'member') {
          if (task.assignee !== located.caller.name) {
            throw new FlowToolError(`task ${task.id} is assigned to "${task.assignee ?? 'nobody'}", not you`)
          }
          // The capability is checked before the terminal state: a stale
          // attempt is the reason that matters, and reporting "immutable"
          // instead would send the member looking for the wrong problem.
          if (task.attemptId !== undefined && args.attempt_id !== task.attemptId) {
            throw new FlowToolError(`stale attempt for task ${task.id}: expected the current attempt_id; stop work and request fresh assignment`)
          }
        }
        if (TERMINAL_TASK_STATUSES.includes(task.status)) {
          const sameStatus = args.status === undefined || args.status === task.status
          const sameOutput = args.output === undefined || args.output === task.output
          if (!sameStatus || !sameOutput) {
            throw new FlowToolError(`terminal task ${task.id} is immutable; use flow_reassign_task to retry failed/cancelled work`)
          }
          return { teamId: team.id, ...taskSummary(task) }
        }

        const previousStatus = task.status
        const update = readTaskUpdate(args)
        gate(evaluateQualityCompletion(task, update), 'flow_update_task rejected by the quality gates')
        // Re-checked after the gate, as the reference does: the gate's own
        // transition test only fires when the status actually moves, and the
        // second check is what rejects a "move" to the status it is already in.
        if (args.status !== undefined) {
          const transition = transitionError(previousStatus, args.status)
          if (transition !== undefined) throw new FlowToolError(transition)
        }

        const now = deps.now()
        const events = []
        if (update.status !== undefined) task.status = update.status
        if (update.output !== undefined) task.output = update.output
        if (update.verdict !== undefined) task.verdict = update.verdict
        if (update.findings !== undefined) task.findings = update.findings
        if (update.changedPaths !== undefined) task.changedPaths = update.changedPaths
        if (update.acceptanceResults !== undefined) task.acceptanceResults = update.acceptanceResults
        if (update.commandsRun !== undefined) task.commandsRun = update.commandsRun
        task.updatedAt = now

        if (task.status === 'completed') {
          events.push({
            type: 'task.completed',
            at: now,
            seq: await deps.nextSeq(team.id),
            id: task.id,
            ...task.verdict === undefined ? {} : { verdict: task.verdict },
            ...task.acceptanceResults === undefined ? {} : { acceptanceResults: task.acceptanceResults },
            ...task.changedPaths === undefined ? {} : { changedPaths: task.changedPaths },
            ...task.output === undefined ? {} : { output: task.output },
          })
        } else {
          events.push({
            type: 'task.transitioned',
            at: now,
            seq: await deps.nextSeq(team.id),
            id: task.id,
            from: previousStatus,
            to: task.status,
          })
        }

        // A failed review or requirements round is not the end of the loop: the
        // policy decides whether another round is planned, and when the ceiling
        // is reached the loop escalates instead of the captain inventing
        // another cycle by hand.
        const followUp = task.status === 'failed'
          && (task.verdict === 'needs_revision' || task.verdict === 'reject')
          ? planQualityFollowUp(team, task)
          : undefined
        // The planner names its drafts by what they are (`repair-round-2`),
        // because it cannot know what the team's counter will say. Every
        // reference *between* them is remapped here — not just the dependency
        // list: a review left pointing at a draft name would name a task that
        // does not exist, and the gate would reject the team on its next load.
        // A reference to a task that already exists is not in the map and is
        // left alone.
        const planned = followUp?.created ?? []
        const assigned = new Map(planned.map((draft, index) => [draft.id ?? draft.subject, `t${team.taskSeq + index + 1}`]))
        const remap = id => assigned.get(id) ?? id
        for (const draft of planned) {
          team.taskSeq += 1
          events.push({
            type: 'task.created',
            at: now,
            seq: await deps.nextSeq(team.id),
            task: {
              ...draft,
              id: remap(draft.id ?? draft.subject),
              dependencies: draft.dependencies.map(remap),
              ...draft.reviewedTaskId === undefined ? {} : { reviewedTaskId: remap(draft.reviewedTaskId) },
              ...draft.sourceTaskId === undefined ? {} : { sourceTaskId: remap(draft.sourceTaskId) },
            },
          })
        }
        if (followUp?.escalated === true) {
          await deps.appendMessage(team.id, CAPTAIN_KEY, {
            id: deps.randomId(),
            from: CAPTAIN_KEY,
            to: CAPTAIN_KEY,
            content: `Quality-gate loop escalated after ${task.id} (${task.kind ?? 'review'} verdict=${task.verdict}). Automatic repair/review stopped.`,
            ts: now,
          })
        }

        await deps.appendEvents(team.id, events)
        await deps.materialize(team.id)
        return { teamId: team.id, ...taskSummary(task), escalated: followUp?.escalated === true }
      })

      await deps.kickTeam(updated.teamId)
      return {
        task_id: updated.task_id,
        status: updated.status,
        ...updated.output === undefined ? {} : { output: updated.output },
        attempt: updated.attempt,
        ...updated.attempt_id === undefined ? {} : { attempt_id: updated.attempt_id },
      }
    },
    render: (args, value) => [{
      type: 'text',
      text: `Task ${value.task_id} attempt ${value.attempt} → ${value.status}${value.output === undefined ? '' : `\nOutput: ${value.output}`}`,
    }],
  })
}

