// The kernel, mounted and driven the way a captain would drive it.
//
// Everything else in the suite tests one layer against a double. This test is
// where they meet: the real store on a real filesystem, the real profile
// registry, the real plan expander, the real scheduler and the real tool
// objects — mounted through `installFlowKernel` exactly as the plugin entry
// mounts them, and then called through the model-facing tools.
//
// The host is faked, because there is no harness in a unit test. What that
// means is that this proves every *decision* and every *write*; it cannot prove
// the host honours what it is asked for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFlowKernel } from '../kernel.js'
import { EVENTS_FILE } from '../src/store/team-store.js'
import { listProfiles } from '../src/config/profile-registry.js'
import { FLOW_TOOL_NAMES } from '../src/rules/index.js'

const CAPTAIN = 'sess-cap'

/**
 * A live agent, with the agent-scoped context the host gives every real one.
 *
 * The capability layer reaches agents through `agent.ctx` rather than through
 * the plugin's own `ctx` — a member's tool restrictions are installed on the
 * member, not on the plugin — so a fake without it is a fake the kernel cannot
 * run against at all.
 */
function fakeAgent(id, options = {}) {
  const restricted = []
  const listeners = new Map()
  return {
    id,
    status: options.status ?? 'idle',
    // The captain's own route, which a member inherits when its profile names
    // no provider or model. Without it there is nothing to inherit and no
    // member can be routed at all.
    session: {
      // The durable label the member was created with. It is what identifies a
      // member to the capability layer, which has to decide synchronously.
      header: { cwd: options.cwd ?? process.cwd(), ...options.label === undefined ? {} : { label: options.label } },
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }),
    },
    options: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    ctx: {
      tools: { restrict: request => { restricted.push(request); return () => {} } },
      effect: execute => execute(),
      // Agent-scoped events, which is where a member's own failure lands: the
      // host reports a turn that died to that member, not to the plugin.
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(handler)
        return () => listeners.get(event)?.delete(handler)
      },
    },
    restricted,
    /** Deliver an agent-scoped event, the way the host would. */
    async emit(event, payload) {
      for (const handler of [...(listeners.get(event) ?? [])]) await handler(payload)
    },
  }
}

/** A host that can execute: a subagent runtime that records what it is asked. */
function fakeHost(options = {}) {
  const agents = new Map([[CAPTAIN, fakeAgent(CAPTAIN, options)]])
  const calls = { spawned: [], delivered: [], interrupted: [], kicked: [], steered: [], restricted: [], warnings: [] }
  const listeners = new Map()
  const admissions = []
  let children = 0

  const provided = new Map()
  const ctx = {
    logger: { warn: message => { calls.warnings.push(message) }, info: () => {}, error: () => {} },
    /**
     * The host's service seam.
     *
     * Modelled rather than stubbed because the one thing it enforces is the
     * constraint both seams are shaped around: one provider per name. A second
     * `provide` under the same name is an error, which is why the sources seam
     * is a registry and the executor seam is a decision made at mount.
     */
    provide(name, value) {
      if (provided.has(name)) throw new Error(`service "${name}" has been registered`)
      provided.set(name, value)
    },
    agents: {
      get: id => agents.get(id),
      list: () => [...agents.values()],
    },
    llm: {
      async resolveCallConfig(route) {
        return { provider: route.provider ?? 'deepseek', model: route.model ?? 'deepseek-v4-pro' }
      },
    },
    subagents: {
      async startContinuable(spec) {
        children += 1
        const childId = `child-${children}`
        calls.spawned.push({ childId, label: spec.label })
        const child = fakeAgent(childId, { label: spec.label })
        agents.set(childId, child)
        // The host admits a continuable child, so the member has its own
        // runtime before its first request rather than after something notices
        // it is missing.
        for (const setup of admissions) setup(child.ctx, child)
        return { childId, messageId: `msg-${children}` }
      },
      registerContinuableSetup(setup) {
        admissions.push(setup)
        return () => { admissions.length = 0 }
      },
      // Delivery starts the member's turn, and a member that is in a turn is
      // not idle. Modelling that is what the scheduler's availability check
      // reads: without it every kick would treat a member that is mid-task as
      // free, recover its attempt, and mint a new capability underneath it.
      async followup(parent, childId, content) {
        calls.delivered.push({ childId, text: content[0].text })
        const child = agents.get(childId)
        if (child !== undefined) child.status = 'running'
        return `msg-${calls.delivered.length}`
      },
      interrupt(childId, authority) { calls.interrupted.push({ childId, authority }) },
    },
    systemPrompt: { section: definition => calls.sections?.push?.(definition) },
    tools: { register: definition => { calls.registered = [...(calls.registered ?? []), definition.name]; return () => {} } },
    on(event, handler) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(handler) },
    effect(execute) { const disposer = execute(); return disposer },
  }
  return {
    ctx,
    calls,
    agents,
    provided,
    /** Deliver a host event to every handler registered for it. */
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    /** The host's own idle report: a member that finished its turn. */
    goIdle(sessionId) {
      const agent = agents.get(sessionId)
      if (agent !== undefined) agent.status = 'idle'
    },
  }
}

/** A team profile, as a deployment would configure one. */
const PROFILES = {
  feature: {
    description: 'ship a feature end to end',
    members: [{ name: '建模手', role: 'scientist' }, { name: '程序员', role: 'engineer' }],
    tasks: [
      { id: 'spec', subject: 'pin the spec', assignee: '建模手' },
      { id: 'build', subject: 'build it', dependencies: ['spec'], assignee: '程序员' },
    ],
    reviewPolicy: { requirementsMinRounds: 1, requirementsMaxRounds: 4, codeMaxRounds: 3, maxRepairAttempts: 2 },
  },
}

function mount(t, config = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-flow-kernel-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const host = fakeHost()
  const registered = []
  host.ctx.tools.register = definition => { registered.push(definition); return () => {} }
  const kernel = installFlowKernel(host.ctx, { stateDir, profiles: PROFILES, ...config })
  const tool = name => registered.find(definition => definition.name === name)
  const captain = { agent: { id: CAPTAIN } }
  return { ...host, kernel, registered, tool, captain, stateDir }
}

/** The team record as a fresh reader sees it, proving the log is the source. */
const readBack = (kernel, teamId) => kernel.store.service.readTeam(teamId)
const logOf = (kernel, teamId) => kernel.store.service.readTeamEvents(teamId)

test('mounting registers every declared tool and no others', async t => {
  const { registered } = mount(t)
  // The set the role rules deny a member and the set actually registered have
  // to be the same, or a member keeps a captain's tool with nothing refusing it.
  assert.deepEqual(registered.map(definition => definition.name), [...FLOW_TOOL_NAMES])
})

test('the team registry is provided whole, as the core the sources seam sits beside', async t => {
  const { ctx, kernel, provided } = mount(t)
  // Whole, not a curated face. A hand-picked subset would be a second
  // definition of "the team registry", and nothing would keep the two in step.
  assert.equal(provided.get('flowTeams'), kernel.store.service)
  assert.notEqual(provided.get('flowTeamSources'), undefined)

  // The host refuses a second provider under one name. That single rule is why
  // the sources seam is a registry — several sources genuinely coexist — while
  // the executor seam has to be decided at mount.
  assert.throws(() => ctx.provide('flowTeams', {}), /has been registered/)
})

test('the core and the seam answer different questions', async t => {
  // `flowTeams` is what this deployment has; `flowTeamSources` is every team any
  // registered source can see, tagged with where it came from. During a
  // migration the second is a superset of the first, which is the whole reason
  // they are not one thing.
  const { provided, tool, captain } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)

  assert.deepEqual(await provided.get('flowTeams').listTeamIds(), [created.teamId])
  assert.deepEqual(
    (await provided.get('flowTeamSources').enumerate()).map(entry => entry.teamId),
    [created.teamId],
  )
})

test('the executor seam is provided, and which one it is was decided at mount', async t => {
  // The seam's shape: exactly one executor, chosen when the plugin is composed.
  // A registry here would make "which one runs" a runtime question, and the
  // wrong answer to it is two live schedulers claiming the same task.
  const executing = mount(t)
  assert.equal(executing.provided.get('flowRunner'), executing.kernel.runner)
  assert.equal(executing.provided.get('flowRunner').name, 'subagents')

  // The other mount is a different implementation of the same seam, not an
  // absent service. That is what makes "show me teams, run nothing" a
  // configuration rather than a second build.
  const manual = mount(t, { runner: 'manual' })
  assert.equal(manual.provided.get('flowRunner').name, 'manual')
  assert.notEqual(manual.provided.get('flowRunner'), executing.provided.get('flowRunner'))
})

test('the profiles a deployment offers are readable as data', async t => {
  // What the canvas picker reads. Only the addressable ones: a profile whose
  // name cannot be spelled as a slash command would be an option that fails
  // after the reader had already typed a goal.
  const { kernel } = mount(t, {
    profiles: {
      feature: PROFILES.feature,
      'bug fix': { description: 'not addressable as a command', members: [], tasks: [] },
    },
  })
  const offered = listProfiles(kernel.profiles)
  assert.deepEqual(offered.map(profile => profile.name), ['feature'])
  assert.equal(offered[0].description, 'ship a feature end to end')
  assert.equal(offered[0].members, 2)
  assert.equal(offered[0].tasks, 2)
})

test('a manual mount still serves every tool, and simply never executes', async t => {
  const { tool, captain, calls, kernel } = mount(t, { runner: 'manual' })
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  await tool('flow_approve').execute({ teamId: created.teamId }, captain)
  // No error, no members, and the plan is still there to read.
  assert.deepEqual(calls.spawned, [])
  assert.equal((await readBack(kernel, created.teamId)).phase, 'running')
})

test('an unknown runner is refused at mount, not at first use', async t => {
  // A plugin that loads and then fails the first time a model calls a tool is
  // a plugin whose failure gets attributed to the model.
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-flow-kernel-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const { ctx } = fakeHost()
  assert.throws(() => installFlowKernel(ctx, { stateDir, runner: 'whatever' }), /unknown dsh-flow runner/)
})

test('an unknown profile names the profiles that do exist', async t => {
  // A captain that asked for the wrong one needs to see the right ones.
  const { tool, captain } = mount(t)
  await assert.rejects(
    tool('flow_create').execute({ goal: 'x', profile: 'nope' }, captain),
    /unknown dsh-flow profile "nope" — configured profiles: feature/,
  )
})

test('a profile becomes a team, and its plan is what the profile described', async t => {
  const { tool, captain, kernel } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)

  assert.equal(created.phase, 'staged', 'nothing runs until the plan is approved')
  assert.equal(created.members, 2)
  assert.equal(created.tasks, 2)
  const team = await readBack(kernel, created.teamId)
  assert.deepEqual(team.members.map(member => member.name), ['建模手', '程序员'])
  assert.equal(team.members.every(member => member.id === ''), true, 'a staged plan has no children yet')
  assert.deepEqual(team.tasks.map(task => task.id), ['t1', 't2'])
  assert.deepEqual(team.tasks[1].dependencies, ['t1'], 'the seed order is the dependency order')
})

test('approving spawns the roster and dispatches the first task', async t => {
  const { tool, captain, calls, kernel } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  const approved = await tool('flow_approve').execute({ teamId: created.teamId }, captain)

  assert.equal(approved.phase, 'running')
  assert.equal(approved.spawned, 2)
  assert.deepEqual(calls.spawned.map(entry => entry.label), [
    `dsh-flow:${created.teamId}/建模手`, `dsh-flow:${created.teamId}/程序员`,
  ])

  const team = await readBack(kernel, created.teamId)
  assert.deepEqual(team.members.map(member => member.id), ['child-1', 'child-2'], 'the ids are in the record')

  // t2 depends on t1, so exactly one task can start, and it went to the member
  // the plan named.
  assert.equal(team.tasks[0].status, 'claimed')
  assert.equal(team.tasks[0].assignee, '建模手')
  assert.equal(team.tasks[1].status, 'pending')
  assert.equal(calls.delivered.length, 1)
  assert.match(calls.delivered[0].text, /Task: t1/)
  assert.match(calls.delivered[0].text, new RegExp(`attempt_id=${team.tasks[0].attemptId}`))
})

test('the whole run survives being read by a second kernel over the same directory', async t => {
  // The point of the log: what happened is on disk, not in this process.
  const { tool, captain, kernel, stateDir } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  await tool('flow_approve').execute({ teamId: created.teamId }, captain)

  const { ctx, calls } = fakeHost()
  const reopened = installFlowKernel(ctx, { stateDir, profiles: PROFILES, runner: 'manual' })
  assert.deepEqual(await reopened.store.service.readTeam(created.teamId), await readBack(kernel, created.teamId))
  assert.deepEqual(calls.spawned ?? [], [])
  assert.match(readFileSync(join(stateDir, created.teamId, EVENTS_FILE), 'utf8'), /"type":"task\.attempt_started"/)
})

test('a member completes its work, and the dependency unblocks the next task', async t => {
  const { tool, captain, calls, kernel, stateDir } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  await tool('flow_approve').execute({ teamId: created.teamId }, captain)

  const member = { agent: { id: 'child-1' } }
  const claimed = await tool('flow_claim_task').execute({ teamId: created.teamId, task_id: 't1' }, member)
  // Claimed → in_progress → completed. The middle step is the state machine's,
  // not a formality: a task that is finished without ever being reported as
  // started is a task whose completion nobody could have observed coming.
  const started = await tool('flow_update_task').execute({
    teamId: created.teamId, task_id: 't1', status: 'in_progress', attempt_id: claimed.attempt_id,
  }, member)
  assert.equal(started.status, 'in_progress')
  const done = await tool('flow_update_task').execute({
    teamId: created.teamId, task_id: 't1', status: 'completed',
    attempt_id: claimed.attempt_id, output: 'spec pinned',
  }, member)
  assert.equal(done.status, 'completed')

  // Completing t1 unblocks t2, and the kick that follows the update is what
  // hands it out — the captain does not have to notice.
  const team = await readBack(kernel, created.teamId)
  assert.equal(team.tasks[1].status, 'claimed')
  assert.equal(team.tasks[1].assignee, '程序员')
  assert.equal(calls.delivered.length, 2, 'and the second member was woken with it')

  // A third reader sees the same thing, which is what makes the log the record.
  const { ctx } = fakeHost()
  const reopened = installFlowKernel(ctx, { stateDir, profiles: PROFILES, runner: 'manual' })
  assert.deepEqual((await reopened.store.service.readTeam(created.teamId)).tasks[1].status, 'claimed')
})

test('a member whose turn died has its work given back, and handed out again', async t => {
  // The whole loop, through the real kernel. A turn that ends in a terminal
  // failure leaves an attempt nobody holds; the scheduler's other recovery path
  // waits for an idle edge, and a turn that errored out may never produce one
  // on its own — so the failure is recorded by the member's own runtime, and the
  // idle edge is what actually picks the work back up.
  const { tool, captain, agents, emit, goIdle, kernel } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  await tool('flow_approve').execute({ teamId: created.teamId }, captain)

  const before = await readBack(kernel, created.teamId)
  assert.equal(before.tasks[0].status, 'claimed')

  // The turn ran and died.
  const member = agents.get('child-1')
  await member.emit('agent/error', { error: { code: 'SERVER_ERROR' } })

  const rolled = await readBack(kernel, created.teamId)
  assert.equal(rolled.tasks[0].status, 'pending', 'the lost attempt is given back to the pool')
  assert.equal(rolled.tasks[0].attemptId, undefined)

  // The host reports the member idle, which is the edge work comes back on.
  goIdle('child-1')
  emit('agent/status', { agent: member, status: 'idle' })
  await new Promise(resolve => setTimeout(resolve, 20))

  const after = await readBack(kernel, created.teamId)
  assert.equal(after.tasks[0].status, 'claimed')
  assert.equal(after.tasks[0].attempt, before.tasks[0].attempt + 1, 'on a new generation')
  assert.notEqual(after.tasks[0].attemptId, before.tasks[0].attemptId)

  // And the log says why. This is the part agent-teams' snapshot cannot hold:
  // there, a recovered attempt is indistinguishable from one that never ran.
  const events = await logOf(kernel, created.teamId)
  assert.equal(
    events.some(event => event.type === 'task.rolled_back' && event.code === 'SERVER_ERROR'),
    true,
  )
})

test('a dispatch that never landed gives the task back to the plan, not to the pool', async t => {
  // `nextReadyTask` reads an owner as "this member's work first" and only then
  // reaches for the unassigned pool. A rollback that dropped the owner would
  // therefore let any member pick up a task the profile named for somebody else,
  // and a seeded plan is exactly where that matters.
  //
  // The assertion is also the reconcile's: the log and the record have to say
  // the same thing, or `writeTeam` refuses the write rather than recording a
  // change that contradicts itself.
  const { tool, captain, ctx, kernel } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)

  ctx.subagents.followup = async () => { throw new Error('transport down') }
  await tool('flow_approve').execute({ teamId: created.teamId }, captain)

  const team = await readBack(kernel, created.teamId)
  assert.equal(team.tasks[0].status, 'pending', 'the work went back')
  assert.equal(team.tasks[0].assignee, '建模手', 'to the member the plan named, not to the pool')
  assert.equal(team.tasks[0].attemptId, undefined)

  const events = await logOf(kernel, created.teamId)
  const rollback = events.find(event => event.type === 'task.rolled_back')
  assert.equal(rollback.assignee, '建模手', 'and the log states the same holder as the record')
  assert.match(rollback.reason, /dispatch failed/)
})

test('the same progress delivered twice is not recorded twice', async t => {
  // A member that re-sends after a turn boundary must not append a second
  // completion, or the log would say the work finished twice.
  const { tool, captain, kernel } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  await tool('flow_approve').execute({ teamId: created.teamId }, captain)

  const member = { agent: { id: 'child-1' } }
  const claimed = await tool('flow_claim_task').execute({ teamId: created.teamId, task_id: 't1' }, member)
  const attempt_id = claimed.attempt_id
  await tool('flow_update_task').execute({ teamId: created.teamId, task_id: 't1', status: 'in_progress', attempt_id }, member)
  await tool('flow_update_task').execute({ teamId: created.teamId, task_id: 't1', status: 'completed', attempt_id, output: 'done' }, member)
  const settled = (await logOf(kernel, created.teamId)).length
  await tool('flow_update_task').execute({ teamId: created.teamId, task_id: 't1', status: 'completed', attempt_id, output: 'done' }, member)
  assert.equal((await logOf(kernel, created.teamId)).length, settled, 'a terminal task is immutable')
})

test('status reports the team, and a captain\'s call is also a dispatch pass', async t => {
  const { tool, captain, kernel } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  await tool('flow_approve').execute({ teamId: created.teamId }, captain)

  const statusTool = tool('flow_status')
  const snapshot = await statusTool.execute({ teamId: created.teamId }, captain)
  const text = statusTool.output.render({}, snapshot)[0].text
  // The display name is the goal as given; the *id* is the sanitized form, and
  // the two are deliberately different things.
  assert.match(text, /Team "ship a feature" — ship a feature/)
  assert.match(text, /建模手 \[scientist\]/)
  assert.match(text, /t1 \[claimed\]/)
  assert.match(text, /→ 建模手/)
  assert.match(text, /t2 \[pending\].*deps: t1/)
  assert.equal((await readBack(kernel, created.teamId)).tasks[0].status, 'claimed', 'and it did not disturb the run')
})

test('a damaged event log leaves a record rather than vanishing', async t => {
  // It *was* dropped. The store takes an `onMalformedLine` handler and this mount
  // only supplied one when a deployment happened to configure it, so by default a
  // line that could not be read disappeared without a word — the silent skip
  // `AGENTS.md:113` refuses. It is also the worse of the two readers: a damaged
  // mailbox loses mail, a damaged log loses what the team did.
  const { tool, captain, kernel, stateDir } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  await appendFile(join(stateDir, created.teamId, EVENTS_FILE), '{ not json\n', 'utf8')

  // Reading the team is what parses the log; the report is what the canvas reads.
  await readBack(kernel, created.teamId)
  const warnings = kernel.diagnostics.forTeam(created.teamId)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].kind, 'log')
  assert.match(warnings[0].reason, /invalid JSON/)

  // And reading it again does not add a second copy — the canvas polls.
  await readBack(kernel, created.teamId)
  assert.equal(kernel.diagnostics.forTeam(created.teamId).length, 1)
  assert.deepEqual(kernel.diagnostics.summary().teams, [{ teamId: created.teamId, count: 1 }])
})

test('ending the team archives it and stops it being reachable', async t => {
  const { tool, captain, kernel, stateDir } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  await tool('flow_approve').execute({ teamId: created.teamId }, captain)

  assert.deepEqual(
    await tool('flow_delete').execute({ teamId: created.teamId }, captain),
    { deleted: true, team_name: 'ship a feature' },
  )
  assert.equal(await readBack(kernel, created.teamId), undefined, 'an ended team is not one you can keep acting in')
  assert.equal(existsSync(join(stateDir, 'archive', created.teamId, EVENTS_FILE)), true, 'but its history is kept')

  // And the retired member cannot be resumed: its session still exists in the
  // host, so the deny-list is the only thing that still knows.
  assert.equal(await kernel.retired.has('child-1'), true)
  await assert.rejects(
    tool('flow_status').execute({ teamId: created.teamId }, { agent: { id: 'child-1' } }),
    /do not lead or belong to any active team/,
  )
})

test('a member is refused the tools that shape the team', async t => {
  // Two mechanisms, and they cover different things. The identity check inside
  // a tool needs a team to check against, so it protects everything that acts
  // *on* a team; `flow_create` makes a new one and so has nothing to check,
  // which is exactly why the capability restriction exists as well.
  const { tool, captain, agents, emit } = mount(t)
  const created = await tool('flow_create').execute({ goal: 'ship a feature', profile: 'feature' }, captain)
  await tool('flow_approve').execute({ teamId: created.teamId }, captain)

  const member = { agent: { id: 'child-1' } }
  await assert.rejects(tool('flow_delete').execute({ teamId: created.teamId }, member), /not leading any team/)
  await assert.rejects(tool('flow_add_member').execute({ teamId: created.teamId, name: 'x' }, member), /not leading any team/)
  await assert.rejects(
    tool('flow_reassign_task').execute({ teamId: created.teamId, task_id: 't1', assignee: 'captain' }, member),
    /not leading any team/,
  )

  // A member is also refused the tools that shape *somebody else's* team, and
  // so is a stranger — which is the case the capability layer cannot cover,
  // because a session in no team has nothing for it to deny.
  const stranger = { agent: { id: 'nobody' } }
  await assert.rejects(
    tool('flow_edit_plan').execute({ teamId: created.teamId, addTasks: [{ subject: 'sneak' }] }, stranger),
    /not leading any team/,
  )
  await assert.rejects(tool('flow_approve').execute({ teamId: created.teamId }, stranger), /not leading any team/)

  // And a stranger sees nothing at all.
  await assert.rejects(tool('flow_status').execute({ teamId: created.teamId }, { agent: { id: 'nobody' } }), /do not lead or belong/)

  // The capability path, which is what covers `flow_create` — a tool that
  // cannot check a team because it makes one. The member is handed its deny
  // list when its session starts, so the tool is not refused; it is absent.
  const started = agents.get('child-1')
  started.restricted.length = 0
  emit('agent/session-start', { agent: started })
  assert.equal(started.restricted.length, 1, 'the member was restricted at session start')
  assert.equal(started.restricted[0].deny.includes('flow_create'), true)
  assert.equal(started.restricted[0].deny.includes('flow_delete'), true)
  assert.equal(started.restricted[0].deny.includes('flow_claim_task'), false, 'a member keeps its own work')
  assert.equal(started.restricted[0].deny.includes('flow_status'), false)

  // And the captain is not restricted at all.
  const captainAgent = agents.get(CAPTAIN)
  captainAgent.restricted.length = 0
  emit('agent/session-start', { agent: captainAgent })
  assert.deepEqual(captainAgent.restricted, [])
})
