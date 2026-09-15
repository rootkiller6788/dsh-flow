// Mounting the kernel: the composition root.
//
// Everything in `src/` was written to take its dependencies as arguments, which
// is what let each layer be tested without a host. This is the one module that
// supplies them, and it is deliberately the only place where the store, the
// runner and the tools are named together — so "which runner is mounted" is a
// line here rather than a branch inside any of them.
//
// It sits beside `index.js` rather than under `src/` because `src/` is served
// to the browser: a module that imports `node:fs` and the whole host-side
// kernel has no business being reachable from a canvas. The build gate asserts
// that boundary, and it caught this file when it was in `src/`.
//
// The two seams have deliberately different shapes, and the difference is
// forced rather than chosen. A registry-shaped seam is right when several
// providers coexist and the caller picks by name; a composition-time choice is
// right when exactly one may be live, because then "which one" cannot be decided
// wrongly at runtime. Sources are the first kind — native teams and an imported
// `.agent-teams/` directory genuinely coexist during a migration, and they
// differ in capability (one writes, one does not). The executor is the second:
// two live schedulers would both claim the same task, so the mount decides, and
// there is no runtime decision left to get wrong.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createSubagentsRunner } from './src/runner/index.js'
import { createManualRunner } from './src/runner/manual.js'
import { installTeamCapabilities } from './src/runner/capabilities.js'
import { deliverToMember, interruptMember, parseMemberLabel, spawnMember, steerCaptainReport, waitForMemberIdle } from './src/runner/member-ops.js'
import { captainRoute, resolveMemberLlmSelection } from './src/runner/member-llm.js'
import { installRetiredMemberGuard } from './src/runner/retired-guard.js'
import { createFlowStore } from './src/store/index.js'
import { createPlanHooks } from './src/config/hooks.js'
import { createProfileRegistry, describeProfiles } from './src/config/profile-registry.js'
import { createSourceRegistry } from './src/sources/sources.js'
import { installFlowTools } from './src/tools/index.js'
import { RETIRED_MEMBERS_FILE, mergeRetiredMemberIds, parseRetiredMemberIds, serializeRetiredMemberIds } from './src/rules/index.js'

/** The runner names a deployment may mount. */
export const RUNNERS = Object.freeze(['manual', 'subagents'])

/**
 * Mount the team kernel onto a plugin context.
 *
 * @param ctx - the plugin context.
 * @param config - the plugin's config.
 * @param config.stateDir - where teams live; relative paths resolve against the
 *   process working directory, which is what makes one deployment's teams
 *   invisible to another's.
 * @param config.profiles - the configured team profiles, by name.
 * @param config.maxMembers - the per-profile member cap.
 * @param config.runner - `'subagents'` (the default) or `'manual'`.
 * @param config.captainPrompt - deployment-level captain instructions.
 * @param config.memberProvider - the subagent provider members are started with.
 * @param config.agentTeamsStateDir - an existing  directory to
 *   read teams from, for a deployment migrating off that plugin. Absent leaves
 *   the source unregistered, which is different from registering it over a
 *   missing directory.
 * @returns the mounted pieces, so a caller can inspect what it got.
 */
export function installFlowKernel(ctx, config = {}) {
  const onWarn = message => ctx.logger?.warn(`dsh-flow: ${message}`)
  const stateDir = resolve(config.stateDir ?? '.dsh-flow')
  const profiles = createProfileRegistry(config.profiles, config.maxMembers)
  const listed = describeProfiles(profiles)
  const runnerName = config.runner ?? 'subagents'
  if (!RUNNERS.includes(runnerName)) {
    // Fail at mount. A plugin that loads and then cannot execute reports its
    // configuration error to whichever model happened to call first.
    throw new Error(`unknown dsh-flow runner "${String(runnerName)}"; choose one of ${RUNNERS.join(', ')}`)
  }

  /**
   * The mounted executor, or undefined for a manual deployment.
   *
   * Held in a variable rather than passed in because the store's hooks need it
   * and the runner needs the store. One of the two has to come second, and the
   * hooks are the side that can wait: they are only reached by a tool call,
   * long after both exist.
   */
  let runner

  const retired = createRetiredLedger(stateDir)
  const planHooks = createPlanHooks(profiles)
  const store = createFlowStore({
    root: stateDir,
    ...config.maxMembers === undefined ? {} : { maxMembers: config.maxMembers },
    ...config.onMalformedLine === undefined ? {} : { onMalformedLine: config.onMalformedLine },
    hooks: {
      ...planHooks,
      spawnMembers: teamId => spawnTeamMembers(ctx, {
        service: store.service,
        provider: config.memberProvider ?? 'spawn',
        teamId,
        onWarn,
        executes: () => runnerName === 'subagents',
      }),
      kickTeam: teamId => runner?.scheduler?.kickTeam(teamId),
    },
  })

  if (runnerName === 'subagents') {
    runner = createSubagentsRunner(ctx, {
      deps: store.runnerDeps,
      stateDir: config.stateDir ?? '.dsh-flow',
      executionPrompt: config.executionPrompt,
      ownedParents: () => store.service.captainSessionIds(),
    })
    // A retired member must not be resumable: its session still exists in the
    // host, and a stale reference would bring it back into a team that let it
    // go. The guard sits on the one path every resumable delivery uses.
    installRetiredMemberGuard(ctx, {
      isRetired: (_sender, sessionId) => retired.has(sessionId),
      errorType: Error,
    })
  } else {
    runner = createManualRunner()
  }

  const tools = installFlowTools(ctx, {
    ...store.toolDeps,
    ...config.maxMembers === undefined ? {} : { maxMembers: config.maxMembers },
    onWarn,
    retireMembers: ids => retired.add(ids),
    waitForIdle: entry => waitForMemberIdle(ctx, entry),
    interruptMember: entry => interruptMember(ctx, entry),
    resolveMemberRoute: request => resolveMemberRoute(ctx, request),
    isExecuting: () => runnerName === 'subagents',
  }, {
    liveCaptain: teamId => liveCaptainOf(ctx, store.service, teamId),
    steerCaptain: (captain, from, content) => steerCaptainReport(captain, from, content),
    wakeMember: entry => deliverToMember(ctx, entry).then(() => true, () => false),
    activity: sessionId => ctx.agents?.get?.(sessionId)?.status ?? 'ready',
  })

  // The prompt a session starts from, and the tools a member must not reach,
  // are the runner's business: without an executor there is no member to
  // restrict and no team to belong to.
  //
  // The role is decided from the durable label the member was created with,
  // not from the store. Two reasons, and the second is the one that matters:
  // the store is asynchronous and this decision has to be made synchronously,
  // before the member's first request; and it cannot be *stale*, whereas a role
  // read from a record that a removal has already changed would grant a captain
  // tool to somebody who is no longer on the team.
  //
  // Nothing is lost by it. The only distinction this layer draws is member
  // versus not — a captain and an unrelated session are given the same prompt —
  // and the label answers exactly that.
  if (runnerName === 'subagents') {
    installTeamCapabilities(ctx, {
      captainPrompt: listed === '' ? config.captainPrompt : `${config.captainPrompt ?? ''}\n\n${listed}`.trim(),
      roleOf: agent => (parseMemberLabel(agent?.session?.header?.label) === undefined ? 'unrelated' : 'member'),
    })
  }

  // Where teams come from. The native source is this store; the agent-teams one
  // is registered only when a deployment points at an existing `.agent-teams`
  // directory, because "not migrating" and "migrating from an empty directory"
  // are different states and only the first should leave the source absent.
  const sources = createSourceRegistry({
    native: store.service,
    ...config.agentTeamsStateDir === undefined
      ? {}
      : { agentTeamsRoot: resolve(config.agentTeamsStateDir) },
    onMalformedLine: (teamId, memberName, line, error) => onWarn(
      `${teamId}/${memberName} mailbox line ${line}: ${error.message}`,
    ),
  })

  // The team registry itself: this deployment's teams and their append-only
  // log, which is what a team *is* here. It corresponds to the host's own
  // `ctx.sessions` — the thing that owns the record — and it is deliberately
  // exposed whole rather than as a curated face. A hand-picked subset would be a
  // second definition of "the team registry" that nothing keeps in step with
  // the first, and the store's own methods already carry the two disciplines
  // that matter: sequence numbers belong to the log, and `writeTeam` requires
  // the team lock its caller is already holding.
  //
  // Read it beside `flowTeamSources` and the difference is the point: `flowTeams`
  // answers "what does this deployment have", while the sources registry answers
  // "every team any registered source can see" — a superset during a migration,
  // and the reason one is a core and the other is a registry.
  //
  // Named for the host's own seam convention. A deployment that wants to read
  // agent-teams' teams without its executor mounted gets: the canvas shows both
  // sets of teams, the tools act on ours, and nothing runs the other one.
  //
  // `provide` is itself an effect — it registers the service inside the
  // calling fiber and releases it when that fiber is disposed — so this needs
  // no matching teardown of its own. Optional-called because a test context
  // has no services to provide to.
  ctx.provide?.('flowTeams', store.service)
  ctx.provide?.('flowTeamSources', sources)

  return { store, profiles, runner, tools, retired, sources, stateDir, runnerName }
}

/**
 * The live captain of a team, if there is one.
 *
 * Deliberately not "the session that created it": a team outlives the session
 * that started it, and a captain that is not currently *running* is exactly the
 * case the durable mailbox exists for — so a captain that is merely absent is
 * not an error, and `undefined` is the ordinary answer.
 */
async function liveCaptainOf(ctx, service, teamId) {
  const team = await service.readTeam(teamId)
  if (team === undefined) return undefined
  const agent = ctx.agents?.get?.(team.captainSessionId)
  return agent === undefined || agent.status === 'running' ? undefined : agent
}

/** Resolve one member's provider, model and effort against the live registry. */
async function resolveMemberRoute(ctx, request) {
  const team = request.team
  const captain = ctx.agents?.get?.(team.captainSessionId) ?? request.exec?.agent
  if (captain === undefined) throw new Error('cannot resolve the member LLM route from the current captain session')
  return resolveMemberLlmSelection(ctx, captain, {
    provider: request.request.provider,
    model: request.request.model,
    reasoningEffort: request.request.reasoningEffort,
    fallback: request.request.fallback,
  }, request.exec?.signal ?? new AbortController().signal)
}

/**
 * Spawn the members a plan declares that have no session yet.
 *
 * Called at approval and whenever a team is resumed, so it has to be
 * idempotent: a member that already has an id is skipped, because a second
 * spawn would give one member two durable child sessions with no way to tell
 * which is the real one.
 *
 * The routes are resolved for the whole roster *before* anything is started,
 * and a roster where nothing can be routed refuses the call. That distinction
 * is the difference between a team that is running and a team that merely looks
 * approved: a member with no resolvable model is not a member that will do work
 * later, so approving one is a failure the captain needs to see now rather than
 * an empty roster it discovers on the next status call.
 *
 * A partial failure stays a warning. Three of four members working is more
 * useful than none, and the one that did not start is visible as unspawned.
 *
 * @returns how many members were started.
 */
async function spawnTeamMembers(ctx, options) {
  const { service, provider, teamId, onWarn, executes } = options
  // A manual deployment mounts no executor, so the two hooks that would start
  // one are inert rather than absent. Absent would make every approval throw;
  // inert means the team is created and approved and nothing runs, which is
  // exactly what "no execution kernel" is supposed to mean.
  if (!executes()) return 0
  const team = await service.readTeam(teamId)
  if (team === undefined || team.phase === 'staged') return 0
  const captain = ctx.agents?.get?.(team.captainSessionId)
  if (captain === undefined) return 0

  const pending = team.members.filter(member => member.status !== 'removed' && member.id === '')
  if (pending.length === 0) return 0

  const resolved = []
  for (const member of pending) {
    try {
      resolved.push({ member, route: await resolveMemberRoute(ctx, { team, request: member }) })
    } catch (error) {
      resolved.push({ member, error })
    }
  }
  const startable = resolved.filter(entry => entry.error === undefined)
  if (startable.length === 0) {
    throw new Error(`no member of team "${team.name}" could be routed: ${String(resolved[0].error)}`)
  }
  for (const entry of resolved) {
    if (entry.error !== undefined) onWarn(`member "${entry.member.name}" could not be routed: ${String(entry.error)}`)
  }

  let spawned = 0
  for (const { member, route } of startable) {
    try {
      const child = await spawnMember(ctx, {
        provider,
        teamId,
        memberName: member.name,
        parent: captain,
        prompt: memberWelcome(team, member),
        persona: member.executionPrompt,
        agentOptions: route,
        signal: new AbortController().signal,
      })
      // The id is written through the reconcile, under the lock, and only if
      // the member is still unspawned: an approval that raced a second approval
      // must not overwrite the first one's child.
      await service.withTeamLock(teamId, async () => {
        const fresh = await service.readTeam(teamId)
        const target = fresh?.members.find(candidate => candidate.name === member.name)
        if (target === undefined || target.id !== '') return
        target.id = child.childId
        await service.writeTeam(fresh)
      })
      spawned += 1
    } catch (error) {
      onWarn(`member "${member.name}" could not be started: ${String(error)}`)
    }
  }
  return spawned
}

/** What a member is told when it starts, before it has any work. */
function memberWelcome(team, member) {
  return `You are ${member.name} on the dsh-flow team "${team.name}". `
    + `The team's goal is: ${team.description ?? team.name}. `
    + 'Wait for an assignment; use flow_claim_task to take work and flow_send_message to report.'
}

/**
 * The durable list of members that must not be resumed.
 *
 * A file rather than team state, because retirement outlives the team.
 * Archiving moves a team's record away while the member's session stays in the
 * host, so the deny-list is the only thing left that knows the relationship
 * ended.
 */
function createRetiredLedger(stateDir) {
  const path = join(stateDir, RETIRED_MEMBERS_FILE)
  const read = async () => {
    try {
      return parseRetiredMemberIds(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }
  return {
    async has(sessionId) {
      return (await read()).has(sessionId)
    },
    async add(sessionIds) {
      const merged = mergeRetiredMemberIds(await read(), sessionIds)
      // Nothing new means nothing to write: rewriting the file would move its
      // mtime for no reason, and an mtime is what a reader watching for changes
      // would see as a change.
      if (!merged.changed) return
      await mkdir(stateDir, { recursive: true })
      await writeFile(path, serializeRetiredMemberIds(merged.ids), 'utf8')
    },
  }
}
