// Probing the host's subagent contract, and refusing clearly when it is absent.
//
// The technique is borrowed from agent-teams' `harness-compat.ts`: probe the
// live service for the operations you need, and throw a message naming the
// missing piece rather than degrading into something that half-works. Its
// warning is worth repeating — *API presence alone is not a promise of support
// for future versions* — so the probe checks callable shape, not just that a
// property exists.
//
// What is deliberately NOT borrowed is the four-channel fallback. agent-teams
// handles `followup`, a `Symbol.for('dsh.subagent.deliverPrompt')` variant, a
// `Symbol.for('dsh.subagent.queuePrompt')` FIFO, and `sendMessage`, because it
// ships to an unknown harness version. dsh-flow targets the version it is
// installed against, and the documented `followup` is that version's API. We
// therefore read the documented surface and fail loudly when it is missing,
// rather than carrying four private-symbol paths that cannot be tested here.
//
// If dsh-flow is ever published for a range of harness versions, this is the
// file that grows — and the fallbacks should be added with the same "probe the
// shape, do not assume the version" discipline the originals use.

/** The one error type this module raises, so callers can tell it apart. */
export class UnsupportedHarnessError extends Error {
  constructor(detail) {
    super(
      `dsh-flow: unsupported Harness subagent contract (${detail}); `
      + 'use an explicitly tested Harness version with a coherent dependency installation',
    )
    this.name = 'UnsupportedHarnessError'
  }
}

const isFunction = value => typeof value === 'function'

/**
 * The operations a runner needs, read off the live service.
 *
 * Each is optional in the probe result so a caller can require exactly what it
 * uses: the manual runner needs none of them, a dispatcher needs all of them.
 */
export function probeSubagentRuntime(ctx) {
  const subagents = ctx?.subagents
  return {
    present: subagents !== undefined && subagents !== null,
    startContinuable: isFunction(subagents?.startContinuable) ? subagents.startContinuable.bind(subagents) : undefined,
    followup: isFunction(subagents?.followup) ? subagents.followup.bind(subagents) : undefined,
    interrupt: isFunction(subagents?.interrupt) ? subagents.interrupt.bind(subagents) : undefined,
    drainDescendants: isFunction(subagents?.drainContinuableDescendants)
      ? subagents.drainContinuableDescendants.bind(subagents)
      : undefined,
    listChildren: isFunction(subagents?.listChildren) ? subagents.listChildren.bind(subagents) : undefined,
    registerContinuableSetup: isFunction(subagents?.registerContinuableSetup)
      ? subagents.registerContinuableSetup.bind(subagents)
      : undefined,
  }
}

/** The operations a runner needs from the agent registry. */
export function probeAgentRuntime(ctx) {
  const agents = ctx?.agents
  return {
    present: agents !== undefined && agents !== null,
    get: isFunction(agents?.get) ? agents.get.bind(agents) : undefined,
  }
}

/**
 * Require a set of probed operations, naming every missing one at once.
 *
 * Reporting all gaps together matters when the cause is a single wrong install:
 * fixing four names one error message at a time is four restarts.
 *
 * @param probe - a probe result.
 * @param required - operation names the caller uses.
 * @param subject - what the operations belong to, for the message.
 * @returns the probe, narrowed by the caller's own knowledge.
 */
export function requireOperations(probe, required, subject) {
  const missing = required.filter(name => !isFunction(probe[name]))
  if (missing.length > 0) {
    throw new UnsupportedHarnessError(`${subject} is missing ${missing.join(', ')}`)
  }
  return probe
}

/**
 * Everything a spawning runner needs, or a thrown error naming what is absent.
 *
 * @param ctx - the plugin context.
 * @returns the probed operations.
 */
export function requireExecutorContracts(ctx) {
  const subagents = requireOperations(
    probeSubagentRuntime(ctx),
    ['startContinuable', 'followup', 'interrupt'],
    'ctx.subagents',
  )
  const agents = requireOperations(probeAgentRuntime(ctx), ['get'], 'ctx.agents')
  return { ...subagents, agentGet: agents.get }
}

/** A non-throwing report, for logging and for showing why execution is off. */
export function describeContracts(ctx) {
  const subagents = probeSubagentRuntime(ctx)
  const agents = probeAgentRuntime(ctx)
  const present = name => (isFunction(subagents[name]) ? 'yes' : 'no')
  return {
    subagentsPresent: subagents.present,
    agentsPresent: agents.present,
    canDispatch: isFunction(subagents.startContinuable) && isFunction(agents.get),
    canDeliver: isFunction(subagents.followup),
    canInterrupt: isFunction(subagents.interrupt),
    canDrain: isFunction(subagents.drainDescendants),
    operations: {
      startContinuable: present('startContinuable'),
      followup: present('followup'),
      interrupt: present('interrupt'),
      drainContinuableDescendants: present('drainDescendants'),
      listChildren: present('listChildren'),
      registerContinuableSetup: present('registerContinuableSetup'),
    },
  }
}
