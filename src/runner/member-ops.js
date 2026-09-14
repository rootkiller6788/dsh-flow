// Starting, talking to, and stopping team members.
//
// `members.ts` carries four ways to deliver a prompt, because it ships to an
// unknown harness version: `followup`, a `Symbol.for('dsh.subagent.deliverPrompt')`
// variant, a `Symbol.for('dsh.subagent.queuePrompt')` FIFO, and `sendMessage`.
// Only the first is the documented API of the version this targets, so only the
// first is here. The others are private symbols whose behaviour a unit test
// cannot reach; carrying them would add three untestable paths to buy
// compatibility dsh-flow has not promised.
//
// The one rule worth stating outright: a member is never driven through
// `Agent.followup` or `Agent.steer`. Those are the *parent's own* conversational
// handles, and work routed through them lands in the captain's turn instead of
// the member's — which looks like it worked.

/** Prefix a member's durable creation label carries, for attribution. */
export const MEMBER_LABEL_PREFIX = 'dsh-flow:'

/** A prompt is a list of content blocks, not a string. */
export function textBlocks(text) {
  return [{ type: 'text', text: String(text) }]
}

/** The durable creation label for one member of one team. */
export function memberLabel(teamId, memberName) {
  return `${MEMBER_LABEL_PREFIX}${teamId}/${memberName}`
}

/**
 * Recover the team and member a durable label names.
 *
 * This is how a cold-resumed child is recognised as a member: its session
 * carries the label it was created with, and nothing else in a restarted
 * process knows the relationship. The separator is `/` rather than `:`, which
 * matters because the prefix itself ends in a colon — with `:` on both sides,
 * a team id containing one would be unparseable.
 *
 * @param label - the durable label, or undefined.
 * @returns `{ teamId, memberName }`, or undefined when this is not our child.
 */
export function parseMemberLabel(label) {
  if (typeof label !== 'string' || !label.startsWith(MEMBER_LABEL_PREFIX)) return undefined
  const identity = label.slice(MEMBER_LABEL_PREFIX.length)
  const separator = identity.indexOf('/')
  if (separator < 1 || separator === identity.length - 1) return undefined
  return { teamId: identity.slice(0, separator), memberName: identity.slice(separator + 1) }
}

/**
 * Start one continuable member.
 *
 * Resolves when the child's inbox has accepted the initial prompt — not when
 * the turn starts, and not when the message reaches the session log. A rejection
 * means nothing was published, so the caller can treat a failed spawn as no
 * spawn at all.
 *
 * @param ctx - the plugin context.
 * @param options.provider - the subagent provider name.
 * @param options.teamId - for the durable label.
 * @param options.memberName - for the durable label.
 * @param options.parent - the live captain agent.
 * @param options.prompt - the member's initial prompt text.
 * @param options.persona - the member's execution persona, if any.
 * @param options.agentOptions - provider/model selection, if resolved.
 * @param options.signal - cancellation, until the inbox accepts.
 * @returns `{ childId, messageId }`.
 */
export async function spawnMember(ctx, options) {
  const { provider, teamId, memberName, parent, prompt, persona, agentOptions, signal } = options
  return ctx.subagents.startContinuable({
    provider,
    label: memberLabel(teamId, memberName),
    request: {
      prompt: textBlocks(prompt),
      parent,
      ...agentOptions === undefined ? {} : { agentOptions },
      ...persona === undefined ? {} : { persona },
    },
    signal,
  })
}

/**
 * Deliver one later message to a member as its next turn.
 *
 * The source records who supplied the message. It grants no authority — the
 * service checks the durable parent recorded in the child's header — but it is
 * what a reader later sees, so it names this plugin rather than the captain.
 *
 * @param ctx - the plugin context.
 * @param options.parent - the exact live direct parent agent.
 * @param options.childId - the member's session id.
 * @param options.text - the message body.
 * @param options.signal - cancellation.
 * @returns the accepted message id.
 */
export async function deliverToMember(ctx, options) {
  const { parent, childId, text, signal } = options
  return ctx.subagents.followup(parent, childId, textBlocks(text), {
    source: { kind: 'plugin', plugin: 'dsh-flow' },
    signal,
  })
}

/**
 * Interrupt one member's current turn.
 *
 * Authority comes from the human-facing parent address, not from being an
 * agent: the service accepts `{ kind: 'user', parentSessionId }` or an exact
 * live ancestor. Admission is synchronous and the effect is not — the call
 * returns without waiting for the member to observe the signal, and work already
 * claimed into the interrupted turn is not requeued. An absent target is an
 * accepted no-op.
 *
 * @param ctx - the plugin context.
 * @param options.targetSessionId - the member to interrupt.
 * @param options.parentSessionId - the captain's session, as the authority.
 * @param options.ancestor - alternatively, the live ancestor agent.
 */
export function interruptMember(ctx, options) {
  const authority = options.ancestor !== undefined
    ? { kind: 'ancestor', agent: options.ancestor }
    : { kind: 'user', parentSessionId: options.parentSessionId }
  ctx.subagents.interrupt(options.targetSessionId, authority)
}

/**
 * Hand a member's report to the live captain at its next model step.
 *
 * `steer` submits one later turn; a failure means the captain is not live, and
 * the durable mailbox still holds the message, so the caller's fallback is the
 * store rather than a retry here.
 *
 * @param captain - the live captain agent.
 * @param from - the reporting member's name.
 * @param content - the report body.
 * @returns whether the steer was accepted.
 */
export function steerCaptainReport(captain, from, content) {
  try {
    captain.steer({
      content: textBlocks(`dsh-flow message from member ${from}:\n\n${content}`),
      source: { kind: 'plugin', plugin: 'dsh-flow' },
    })
    return true
  } catch {
    return false
  }
}
