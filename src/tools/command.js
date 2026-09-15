// The `/dsh-flow` slash command, and the gesture boundary behind it.
//
// Two mechanisms, covering the two halves of one act. Registering a command
// makes the gesture *discoverable* — it appears in the host's command list — but
// the host deliberately does not send a registered command to the model, so the
// handler has to put the text back. The `agent/pre-step` waterfall is what makes
// it *mean something*: it recognises the same text in a user message and appends
// the directive the captain needs to act on it.
//
// The boundary is the half that carries the feature. A gesture that was typed
// rather than picked arrives as ordinary text either way, and `ctx.commands` is
// a host service this build does not require — so the boundary is installed
// unconditionally and the palette entries only where the service exists.
//
// Recognition is pure and always available. Injection is the one thing neither
// half can supply for itself: a user message is minted by the host, and what
// this plugin can reach of the host is whatever `probeUserMessageFactory` finds.
import { parseProfileInvocation, profileCommandName, resolveProfileTaskPlanning } from '../rules/index.js'

/** The command this plugin registers. */
export const FLOW_COMMAND = 'dsh-flow'

/**
 * Profile commands share one namespace, which is what keeps a profile from
 * shadowing the generic command or another profile.
 */
export const FLOW_PROFILE_COMMAND_PREFIX = `${FLOW_COMMAND}-`

/** The gesture: the command at the start of a message, followed by a boundary. */
const GESTURE = /^\/dsh-flow(?=$|[\t\n\r ])/u

/** Where the closing whitespace of a command line is. */
const TOKEN_END = /[\t\n\r ]/u

/**
 * The cached result of looking for the host's message factory.
 *
 * Cached because a miss is a property of the deployment rather than of the
 * moment: retrying per keystroke would repeat the same resolution failure and
 * nothing about it would have changed.
 */
let messageFactory
let probed = false

/**
 * The host's user-message factory, when this deployment can reach it.
 *
 * `createUserMessage` lives in `@deepseek-ai/dsh-llm`, which is a host package
 * rather than a dependency of this plugin: the published shape for a DSH plugin
 * is to import it and let a build step inline it, and this plugin has no build
 * step. So it is *loaded*, not imported at the top of the file — a deployment
 * where the host resolves it gets the whole command, and one where it does not
 * still gets the gesture boundary.
 *
 * Nothing here fabricates a message to stand in for a missing factory. The
 * message shape is the host's to define, and a plausible object that the host
 * then rejects is worse than a feature that honestly reports itself unavailable.
 *
 * @returns the factory, or `undefined` when this deployment cannot supply one.
 */
export async function probeUserMessageFactory() {
  if (probed) return messageFactory
  probed = true
  try {
    const loaded = await import('@deepseek-ai/dsh-llm')
    messageFactory = typeof loaded?.createUserMessage === 'function' ? loaded.createUserMessage : undefined
  } catch {
    messageFactory = undefined
  }
  return messageFactory
}

/**
 * The profile a generated command name maps to, when exactly one does.
 *
 * `undefined` for an ambiguous match as well as for no match at all: two
 * profiles that would share a command name means neither is reachable under it,
 * and picking one would leave the other silently unaddressable.
 */
export function profileForCommand(commandName, profiles = {}) {
  const matches = Object.keys(profiles)
    .filter(name => profileCommandName(name, FLOW_PROFILE_COMMAND_PREFIX) === commandName)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Parse the invocation a piece of text asks for.
 *
 * Two spellings, and the generic one is tried first because its name is a prefix
 * of the other's: `parseProfileInvocation` owns what follows `--profile`, while a
 * generated alias carries the profile in its own name and takes the rest as the
 * goal.
 *
 * @param text - one message's text.
 * @param profiles - the configured profiles, by name.
 * @returns `{ goal }` or `{ goal, profile }`, or `undefined` when this is not a
 *   dsh-flow gesture at all. Throws when the generic form is malformed, because
 *   only the caller knows whether that should be a refusal or a directive.
 */
export function parseFlowCommandText(text, profiles = {}) {
  const trimmed = String(text ?? '').trimStart()
  if (GESTURE.test(trimmed)) return parseProfileInvocation(trimmed.slice(FLOW_COMMAND.length + 1).trim())
  if (!trimmed.startsWith(`/${FLOW_PROFILE_COMMAND_PREFIX}`)) return undefined
  const tokenEnd = trimmed.search(TOKEN_END)
  const commandName = trimmed.slice(1, tokenEnd === -1 ? undefined : tokenEnd)
  const profile = profileForCommand(commandName, profiles)
  if (profile === undefined) return undefined
  return { profile, goal: (tokenEnd === -1 ? '' : trimmed.slice(tokenEnd)).trim() }
}

/**
 * The invocation the conversation asks for, if there is one.
 *
 * Newest first. An older gesture may already have been acted on, and re-reading
 * it would re-issue something the captain has done — which is the difference
 * between a command that works and one that creates a second team on every turn.
 *
 * @param messages - the user messages entering this step.
 * @param getProfiles - `() => profiles`, read lazily so a deployment that
 *   reconfigures does not need this re-registered.
 * @returns the invocation, or `undefined`.
 */
export function invokedFlowCommand(messages, getProfiles = () => ({})) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.source?.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block?.type !== 'text') continue
      const invocation = parseFlowCommandText(block.text, getProfiles())
      if (invocation !== undefined) return invocation
    }
  }
  return undefined
}

/**
 * What the captain is told when the gesture is used.
 *
 * Written for a model that already carries the dsh-flow rules in its system
 * prompt: this is the in-turn nudge, so it says what to do *now* rather than
 * restating the protocol. The one thing it must never leave implicit is that
 * creating a team stages a plan and stops — approving it in the same turn throws
 * away the review that staging exists for.
 *
 * @param invocation - `{ goal, profile }`.
 * @param profiles - the configured profiles, by name.
 * @returns the directive text.
 */
export function flowActivationDirective(invocation, profiles = {}) {
  const { goal = '', profile } = invocation
  const names = Object.keys(profiles)
  const matched = profile === undefined ? undefined : names.find(name => name.trim() === profile)
  if (profile !== undefined && matched === undefined) {
    // A named profile that does not exist is answered, not ignored: the captain
    // must not fall back to "some team" when the user asked for a specific one.
    return `The dsh-flow profile "${profile}" does not exist. Available profiles: ${names.join(', ') || '(none)'}. Do not create a team.`
  }

  const lines = [
    'The user invoked the dsh-flow slash command. Apply the dsh-flow rules already in your instructions.',
    'Respect the current team state: continue an existing team rather than starting a second one, and check with flow_status when you are unsure.',
    'Only when no team exists, call flow_create with the goal. That stages a plan and nothing runs yet.',
    'Stop after creating it and ask the user to review the plan. Do not approve or start it in the same turn.',
  ]
  if (profile !== undefined) {
    lines.push(`Use profile="${profile}" when creating the team.`)
    lines.push(resolveProfileTaskPlanning(profiles[matched]) === 'captain'
      // `captain`-planned profiles declare a roster and guardrails, not a task
      // graph — the captain derives it. Saying so here is what keeps the model
      // from asking the user to do the planning it was just asked to do.
      ? 'This profile supplies the roster and the guardrails; derive the task graph from the goal yourself while the team is staged, and do not ask the user whether to split, merge, serialize or parallelize the work. Independent work becomes separate ready tasks so idle members can run in parallel; add a dependency only for a genuine prerequisite.'
      : 'Do not recreate the same members or seed tasks by hand — this profile already declares them.')
  }
  lines.push(goal === '' ? 'The goal was not given — ask the user what the team should accomplish.' : `Goal: ${goal}`)
  return lines.join('\n')
}

/**
 * Register the command, its profile aliases, and the gesture boundary.
 *
 * @param ctx - the plugin context.
 * @param options.profiles - the configured profiles, by name.
 * @param options.onWarn - `(message) => void`, for the one diagnostic this can
 *   raise: a deployment whose host cannot mint a user message.
 * @param options.createUserMessage - supplied by a caller that already resolved
 *   one; absent means the host is asked (see `probeUserMessageFactory`). This is
 *   the seam a test stands in for the host with, and the reason the probe is not
 *   read directly here.
 * @returns nothing; every registration is an effect on `ctx`.
 */
export function registerFlowCommand(ctx, options = {}) {
  const profiles = options.profiles ?? {}
  const onWarn = options.onWarn ?? (() => {})
  let warned = false

  /** Load the factory, complaining once if this deployment has none. */
  const factory = async () => {
    const createUserMessage = options.createUserMessage ?? await probeUserMessageFactory()
    if (typeof createUserMessage !== 'function') {
      if (!warned) {
        warned = true
        onWarn(`the host's user-message factory is unavailable, so /${FLOW_COMMAND} can recognise a goal but cannot hand it to the captain`)
      }
      return undefined
    }
    return createUserMessage
  }

  const boundary = async (payload, next) => {
    const decision = typeof next === 'function' ? await next() : undefined
    // No decision means no `next` to delegate through, and a reject is final:
    // neither is a place to add anything.
    if (decision === undefined || decision.kind === 'reject') return decision

    let invocation
    try {
      invocation = invokedFlowCommand(payload?.messages, () => profiles)
    } catch (error) {
      // Answered rather than thrown. A listener that throws is logged and the
      // turn proceeds, so the user would watch their command do nothing and be
      // told nothing about why.
      invocation = { goal: '', parseError: String(error instanceof Error ? error.message : error) }
    }
    if (invocation === undefined) return decision

    const createUserMessage = await factory()
    if (createUserMessage === undefined) return decision

    const text = invocation.parseError === undefined
      ? flowActivationDirective(invocation, profiles)
      : `The /${FLOW_COMMAND} command could not be parsed: ${invocation.parseError}`
    return {
      kind: 'enter',
      messages: [
        ...(decision.messages ?? []),
        // The source names this plugin rather than `user`: the human typed a
        // command, not this directive, and a transcript that attributed the
        // directive to them would be a transcript of something that never
        // happened.
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-flow-command' } }),
      ],
    }
  }

  const disposeBoundary = ctx.on?.('agent/pre-step', boundary)
  const disposeCommands = registerCommands(ctx, { profiles, factory })
  ctx.effect?.(() => () => {
    disposeBoundary?.()
    disposeCommands?.()
  }, 'dsh-flow: slash command')
}

/**
 * Put the command and one alias per representable profile into the palette.
 *
 * Returns `undefined` when the host has no command service, which is not a
 * failure: the boundary still recognises the gesture, and this is the half that
 * only makes it discoverable.
 */
function registerCommands(ctx, options) {
  const register = ctx.commands?.register
  if (typeof register !== 'function') return undefined

  const { profiles, factory } = options
  const disposers = []

  const handlerFor = commandName => async invocation => {
    const raw = String(invocation?.rawInput ?? '')
    let parsed
    try {
      parsed = parseProfileInvocation(raw.trim())
    } catch (error) {
      return { kind: 'error', text: String(error instanceof Error ? error.message : error) }
    }
    if (parsed.profile !== undefined && !Object.keys(profiles).some(key => key.trim() === parsed.profile)) {
      return { kind: 'error', text: `unknown dsh-flow profile "${parsed.profile}"` }
    }
    if (parsed.profile === undefined && parsed.goal === '') {
      return { kind: 'error', text: `Usage: /${commandName} [--profile <name>] <goal>` }
    }
    const createUserMessage = await factory()
    if (createUserMessage === undefined) {
      return { kind: 'error', text: `/${commandName} cannot start a team here: this host does not expose a user-message factory` }
    }
    // The text goes back in verbatim, with `user` as its source, because that is
    // exactly what it is: the line the human typed. The boundary turns it into
    // the directive, so the two paths — typed and picked — end up identical.
    invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text: `/${commandName}${raw}` }],
      source: { kind: 'user' },
    }))
    return { kind: 'success', text: `dsh-flow activated${parsed.profile === undefined ? '' : ` with profile ${parsed.profile}`} — the captain will assemble the team.` }
  }

  const add = definition => {
    const off = register.call(ctx.commands, definition)
    if (typeof off === 'function') disposers.push(off)
  }

  add({
    name: FLOW_COMMAND,
    description: 'run a goal with a multi-agent team (you become the captain)',
    input: { hint: '[--profile <name>] <goal>' },
    handler: handlerFor(FLOW_COMMAND),
  })
  for (const profileName of Object.keys(profiles)) {
    const commandName = profileCommandName(profileName, FLOW_PROFILE_COMMAND_PREFIX)
    // Not representable as a command name. Skipped rather than normalised,
    // because a normalisation could collide two profiles onto one command.
    if (commandName === undefined) continue
    add({
      name: commandName,
      description: `run a goal with the dsh-flow ${profileName} profile`,
      input: { hint: '<goal>' },
      handler: handlerFor(commandName),
    })
  }

  return () => {
    for (const off of disposers.reverse()) off()
  }
}
