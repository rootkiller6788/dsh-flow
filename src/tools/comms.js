// Talking to the team, and looking at it.
//
// Both tools here are less read-only than their names suggest, and both for the
// same reason: a durable mailbox only becomes a *conversation* when something
// moves the message out of it. `flow_send_message` writes the message and then
// tries to deliver it live; `flow_status` acknowledges what the caller has now
// read, because a status call is the moment the caller read it.
//
// Neither delivery path is allowed to fail the call. The message is already
// durable when delivery is attempted, so a captain that is not live, or a
// member that cannot be woken, downgrades the delivery rather than losing the
// message — and the result says which of the two happened.
import {
  CAPTAIN_KEY, buildCoverageMatrix, canDeclareDelivery, describeQualityLoop,
  openHighFindings, taskKindOf,
} from '../rules/index.js'
import { FlowToolError, defineFlowTool } from './define.js'
import { locateTeamByParticipant, requireFresh, requireMember } from './identity.js'

/** Text a member sees before a message, so it does not edit state by hand. */
const statePolicy = (stateDir, teamId) => (
  `dsh-flow state policy: inspect ${stateDir}/${teamId}/ read-only; never edit the event log or inbox files directly. `
  + 'Use the flow_* tools for team state.'
)

/** How many unread captain messages a status call shows. */
const INBOX_PREVIEW = 10
/** How much of a message the status preview keeps. */
const PREVIEW_CHARS = 200
/** How many malformed-line warnings a status call names before counting. */
const WARNING_CAP = 10

/**
 * The messaging tool.
 *
 * A member's report to the captain takes the steer path when the captain is
 * live, so the captain sees it at its next model step instead of at its next
 * turn; a message *to* a member takes the delivery path, which starts that
 * member's turn. The two are not interchangeable, which is why they are
 * separate branches rather than one call with a flag.
 */
export function sendMessageTool(deps, options = {}) {
  return defineFlowTool({
    name: 'flow_send_message',
    description: 'Send a message to the captain or to a teammate. Messages go straight into the recipient\'s mailbox; when the captain agent is online the plugin also schedules live delivery (member recipients get the message as their next turn; a running captain sees it at its nearest model step).',
    parameters: {
      teamId: { type: 'string', required: true },
      to: { type: 'string', required: true, description: 'Recipient: "captain" or a member name.' },
      content: { type: 'string', required: true, description: 'The message text.' },
      from: { type: 'string', description: 'Sender (defaults to the caller: the captain, or the calling member).' },
    },
    properties: {
      message_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      delivered: { type: 'string', description: 'live (accepted by the live captain), wake (member recipient woken), or mailbox (durable inbox only).' },
    },
    required: ['message_id', 'from', 'to', 'delivered'],
    async execute(args, exec) {
      const located = await locateTeamByParticipant(exec, deps)
      const identity = located.caller.name
      const to = String(args.to ?? '').trim()
      if (args.from !== undefined && args.from !== identity) {
        throw new FlowToolError(`flow_send_message: "from" must be your own identity ("${identity}"), not "${args.from}"`)
      }

      const sent = await deps.withTeamLock(located.team.id, async () => {
        const team = await requireFresh(located.team.id, located.caller, 'participant', deps)
        // Only *waking a member* is what a halt stops. Reporting to the captain
        // is how the halt gets explained, and a member that reported nothing
        // would leave the captain waiting on work that is not running.
        if (to === CAPTAIN_KEY) {
          const message = await record(team.id, CAPTAIN_KEY, deps, identity, args.content)
          return { teamId: team.id, to: CAPTAIN_KEY, recipient: undefined, message }
        }
        if (team.halted === true) {
          throw new FlowToolError(`team "${team.name}" is halted; call flow_resume before waking a member`)
        }
        const recipient = requireMember(team, to)
        const message = await record(team.id, recipient.name, deps, identity, args.content)
        return { teamId: team.id, to: recipient.name, recipient, message }
      })

      // Delivery is attempted after the message is durable, and a failure only
      // downgrades it. A captain that is not live is the ordinary case rather
      // than an error: that is what the mailbox is for.
      const captain = await options.liveCaptain?.(sent.teamId)
      let delivered = 'mailbox'
      if (sent.to === CAPTAIN_KEY) {
        if (captain !== undefined && located.caller.kind === 'member') {
          delivered = options.steerCaptain?.(captain, identity, sent.message.content) === true ? 'live' : 'mailbox'
        }
      } else if (captain !== undefined && sent.recipient.id !== '') {
        const body = identity === CAPTAIN_KEY
          ? sent.message.content
          : `Message from team member ${identity}:\n\n${sent.message.content}`
        const accepted = await options.wakeMember?.({
          parent: captain,
          childId: sent.recipient.id,
          text: `${statePolicy(deps.stateDir, sent.teamId)}\n\n${body}`,
          signal: exec?.signal,
        })
        delivered = accepted === true ? 'wake' : 'mailbox'
      }

      const ids = [sent.message.id]
      if (delivered === 'mailbox') await deps.releaseDelivery(sent.teamId, sent.to, ids)
      else await deps.acknowledgeDelivery(sent.teamId, sent.to, ids)

      return { message_id: sent.message.id, from: identity, to: sent.to, delivered }
    },
    render: (args, value) => [{
      type: 'text',
      text: `Message ${value.message_id} ${value.from} → ${value.to} delivered via ${value.delivered}.`,
    }],
  })
}

/**
 * Write one message to an inbox and record that it was sent.
 *
 * The lease is taken at the same moment. A message that is durable but
 * unclaimed would be picked up by the next kick as unread *and* delivered by
 * this call's own path, which is two deliveries of one message.
 */
async function record(teamId, recipientName, deps, from, content) {
  const now = deps.now()
  const message = {
    id: deps.randomId(),
    from,
    to: recipientName,
    content: String(content ?? ''),
    ts: now,
    deliveryClaimedAt: now,
  }
  await deps.appendMessage(teamId, recipientName, message)
  await deps.appendEvents(teamId, [{
    type: 'message.sent',
    at: now,
    seq: await deps.nextSeq(teamId),
    id: message.id,
    from,
    to: recipientName,
    content: message.content,
  }])
  return message
}

/**
 * The status tool.
 *
 * It reads the team, and then does two things that write. A captain's call is
 * also a dispatch pass, because a captain asking "where are we" is often the
 * only event that moves a stalled team. And the call acknowledges whatever it
 * just reported, because showing a message and leaving it unread would deliver
 * it again on the next kick.
 */
export function statusTool(deps, options = {}) {
  return defineFlowTool({
    name: 'flow_status',
    description: 'Team snapshot: members with live activity and tasks with status/assignee/dependencies/output. Captains also see every team mailbox; members see only their own inbox. Use after mailbox progress deliveries or for an explicit status request. After dispatch, end your turn while members work; do not repeatedly poll.',
    parameters: { teamId: { type: 'string', required: true } },
    // The snapshot's shape is long and its renderer is the contract; naming
    // every field here would be a second copy of a list nobody reads.
    properties: {},
    async execute(args, exec) {
      const located = await locateTeamByParticipant(exec, deps)
      if (located.caller.kind === 'captain') await deps.kickTeam(located.team.id)

      const warnings = []
      let warningCount = 0
      const onMalformedLine = (teamId, memberName, line) => {
        warningCount += 1
        if (warnings.length < WARNING_CAP) warnings.push(`${memberName} mailbox line ${line}`)
      }

      const team = await deps.withTeamLock(located.team.id, () => (
        requireFresh(located.team.id, located.caller, 'participant', deps)
      ))

      // A member sees its own inbox only; the captain sees every member's.
      // Showing a member another's mail would make the mailbox a shared board
      // rather than a set of private conversations.
      const visible = team.members
        .filter(member => member.status !== 'removed')
        .filter(member => located.caller.kind === 'captain' || member.name === located.caller.name)

      const captainInbox = located.caller.kind === 'captain'
        ? await deps.readUnreadMailbox(team.id, CAPTAIN_KEY, onMalformedLine)
        : []
      const memberInboxes = {}
      const acknowledged = captainInbox.map(message => message.id)
      for (const member of visible) {
        const unread = await deps.readUnreadMailbox(team.id, member.name, onMalformedLine)
        if (unread.length === 0) continue
        memberInboxes[member.name] = {
          count: unread.length,
          latest: String(unread.at(-1).content).slice(0, PREVIEW_CHARS),
        }
        if (located.caller.kind === 'member') acknowledged.push(...unread.map(message => message.id))
      }

      if (acknowledged.length > 0) {
        await deps.acknowledgeDelivery(
          team.id,
          located.caller.kind === 'captain' ? CAPTAIN_KEY : located.caller.name,
          acknowledged,
        )
      }

      const loop = describeQualityLoop(team)
      return {
        team_id: team.id,
        team_name: team.name,
        description: team.description ?? '',
        phase: team.phase ?? 'running',
        halted: loop.halted,
        escalated: loop.escalated,
        loop_state: loop.state,
        loop_summary: loop.summary,
        deliverable: loop.deliverable,
        // Coverage is asked of the goal items the tasks themselves claim to
        // cover: a separate goal list would be a second record of the request,
        // and the two could disagree about what was actually asked for.
        coverage: buildCoverageMatrix(goalItemsOf(team.tasks), team.tasks),
        delivery: canDeclareDelivery(team),
        ...team.profile === undefined ? {} : {
          profile: {
            name: team.profile.name,
            ...team.profile.protocol === undefined ? {} : { protocol: String(team.profile.protocol).slice(0, 240) },
            ...team.profile.taskPlanning === undefined ? {} : { task_planning: team.profile.taskPlanning },
          },
        },
        viewer: located.caller.name,
        members: visible.map(member => ({
          name: member.name,
          role: member.role ?? '',
          provider: member.provider ?? '',
          model: member.model ?? '',
          reasoning_effort: member.reasoningEffort ?? '',
          status: member.status,
          activity: member.id === '' ? 'unspawned' : options.activity?.(member.id) ?? 'unknown',
        })),
        tasks: team.tasks.map(task => ({
          id: task.id,
          subject: task.subject,
          status: task.status,
          assignee: task.assignee ?? '',
          dependencies: task.dependencies,
          attempt: task.attempt ?? 0,
          attempt_id: task.attemptId ?? '',
          reassigning: task.reassigning === true,
          kind: taskKindOf(task),
          ...task.round === undefined ? {} : { round: task.round },
          ...task.verdict === undefined ? {} : { verdict: task.verdict },
          findings_open: openHighFindings(task.findings).length,
          ...task.profileSeedId === undefined ? {} : { seed_id: task.profileSeedId },
          ...task.output === undefined ? {} : { output: task.output },
        })),
        captain_inbox: captainInbox.slice(-INBOX_PREVIEW).map(message => ({
          from: message.from, content: message.content, ts: message.ts,
        })),
        member_inboxes: memberInboxes,
        mailbox_warnings: warnings,
        mailbox_warning_count: warningCount,
      }
    },
    render: (args, value) => [{ type: 'text', text: renderStatus(value) }],
  })
}

/** The distinct goal items the tasks say they cover, in first-seen order. */
function goalItemsOf(tasks) {
  const seen = new Set()
  for (const task of tasks) {
    for (const item of task.coverageOf ?? []) if (!seen.has(item)) seen.add(item)
  }
  return [...seen]
}

/** One line per fact, grouped so a reader can scan for the section it wants. */
function renderStatus(value) {
  const lines = []
  const flags = [value.halted ? 'halted' : undefined, value.escalated ? 'escalated' : undefined].filter(Boolean)
  lines.push(`Team "${value.team_name}" — ${value.description}${flags.length === 0 ? '' : ` [${flags.join(', ')}]`}`)
  if (value.profile !== undefined) lines.push(`Profile: ${value.profile.name}`)
  lines.push(`Loop: ${value.loop_state} — ${value.loop_summary}`)
  lines.push(`Viewing as: ${value.viewer}`)

  lines.push(`Members (${value.members.length}):`)
  for (const member of value.members) {
    const route = member.provider === '' && member.model === '' ? '' : ` · ${member.provider}/${member.model}`
    const effort = member.reasoning_effort === '' ? '' : ` · reasoning ${member.reasoning_effort}`
    lines.push(`  - ${member.name} [${member.role}] ${member.status}/${member.activity}${route}${effort}`)
  }

  lines.push(`Tasks (${value.tasks.length}):`)
  for (const task of value.tasks) {
    const kind = task.kind === 'work' ? '' : ` ${task.kind}`
    const round = task.round === undefined ? '' : ` r${task.round}`
    const verdict = task.verdict === undefined ? '' : ` verdict ${task.verdict}`
    const reassigning = task.reassigning ? ' (reassigning)' : ''
    const seed = task.seed_id === undefined ? '' : ` seed ${task.seed_id}`
    const deps = task.dependencies.length === 0 ? '' : ` (deps: ${task.dependencies.join(',')})`
    lines.push(`  - ${task.id} [${task.status}]${kind}${round}${verdict} attempt ${task.attempt}${reassigning}${seed} ${task.subject} → ${task.assignee || 'unassigned'}${deps}`)
  }

  if (value.coverage.length > 0) {
    lines.push(`Coverage (${value.coverage.length}):`)
    for (const row of value.coverage) {
      lines.push(`  - ${row.goal_item} → ${row.task_ids.join(',') || 'uncovered'} [${row.status}]`)
    }
  }
  lines.push(value.delivery.ok
    ? 'Delivery: ready.'
    : `Delivery: blocked — ${value.delivery.blockers.join('; ') || 'unresolved quality gates'}.`)

  lines.push(`Captain inbox (${value.captain_inbox.length}):`)
  for (const message of value.captain_inbox) lines.push(`  - ${message.from}: ${message.content}`)
  for (const [name, inbox] of Object.entries(value.member_inboxes)) {
    lines.push(`Member inbox ${name} (${inbox.count}): ${inbox.latest}`)
  }
  if (value.mailbox_warning_count > 0) {
    lines.push(`Mailbox warnings (${value.mailbox_warning_count}): ${value.mailbox_warnings.join(', ')}`)
  }
  return lines.join('\n')
}
