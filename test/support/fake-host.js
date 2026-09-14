// A fake host, for testing the runner without a Harness process.
//
// The runner's job is to call the right host operations with the right
// arguments and to undo everything it installs. Neither can be checked against
// a live harness from a unit test, so this models the parts of `ctx` the runner
// touches — recording every call, and letting a test fail a specific operation
// on demand.
//
// It is a model, not a simulator: it enforces nothing the real host enforces.
// What it can prove is that the runner asks for what it says it asks for and
// cleans up what it installed. What it cannot prove is that the real host
// honours those asks.

/** A recording host context. */
export function createFakeHost(options = {}) {
  const calls = {
    restrict: [],
    effects: [],
    sections: [],
    listeners: [],
    logger: [],
    subagents: [],
    llm: [],
  }
  const disposers = []
  const listeners = new Map()

  const record = (bucket, entry) => { calls[bucket].push(entry); return entry }

  const ctx = {
    logger: {
      warn: message => record('logger', message),
      info: () => {},
      error: () => {},
    },

    on(event, handler) {
      record('listeners', { event, handler })
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      const remove = () => listeners.get(event)?.delete(handler)
      // Cordis owns this registration: unloading the plugin removes the
      // listener. Modelling that here matters, because "the listener is gone"
      // is the mechanism that stops new agents being attached — not a flag.
      disposers.push({ name: `on:${event}`, disposer: remove })
      return remove
    },

    effect(execute, name) {
      record('effects', { name })
      const disposer = execute()
      if (typeof disposer === 'function') disposers.push({ name, disposer })
      return disposer
    },

    systemPrompt: {
      section(definition) {
        record('sections', definition)
      },
    },

    agents: {
      list: () => options.agents?.list?.() ?? [],
      get: options.agents?.get ?? (() => undefined),
    },

    subagents: options.subagents ?? {},
    llm: options.llm ?? {},
  }

  return {
    ctx,
    calls,

    /**
     * Deliver an event to every listener registered for it.
     *
     * `next` is forwarded so a waterfall event can be modelled: a listener
     * that must delegate is only testable if it is handed something to call.
     */
    emit(event, payload, next) {
      for (const handler of listeners.get(event) ?? []) handler(payload, next)
    },

    /** How many listeners are currently registered for an event. */
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    },

    /** Run every disposer registered through `ctx.effect`, newest first. */
    async disposeAll() {
      const pending = [...disposers].reverse()
      disposers.length = 0
      for (const { disposer } of pending) await disposer()
    },
  }
}

/**
 * A fake live agent.
 *
 * `tools.restrict` records the deny list and returns a revoke function whose
 * invocation is observable, because "did we hand the capability back" is the
 * difference between a clean reload and a member that keeps a captain's tools
 * after its plugin is gone.
 */
export function createFakeAgent(id, options = {}) {
  const restricted = []
  const revoked = []
  const effects = []

  const agent = {
    id,
    session: options.session ?? { header: { cwd: options.cwd ?? process.cwd() } },
    ctx: {
      tools: {
        restrict(request) {
          restricted.push(request)
          return () => revoked.push(request)
        },
      },
      effect(execute, name) {
        const disposer = execute()
        effects.push({ name, disposer })
        return disposer
      },
    },
  }

  return {
    agent,
    restricted,
    revoked,
    get revokedCount() { return revoked.length },
    async disposeEffects() {
      for (const { disposer } of [...effects].reverse()) {
        if (typeof disposer === 'function') await disposer()
      }
      effects.length = 0
    },
  }
}
