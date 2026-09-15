// Contract for the tools that shape and do the work.
//
// The store is faked and the events are recorded, so what these prove is the
// *decision*: what a call is allowed to do, what it refuses, and what it
// appends. Whether a real store derives the same state from those events is the
// store's contract, tested where the store lives — and the two meet in
// test/store-integration.test.js.
//
// The refusals are the interesting half. Each one exists because of a specific
// way the work can go wrong: a member claiming a task that is not theirs, a
// stale attempt overwriting a new owner's report, a plan edit that removes a
// task other tasks depend on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installFlowTools } from '../src/tools/index.js'
import { CAPTAIN_KEY } from '../src/rules/index.js'
import { createFakeHost } from './support/fake-host.js'

const CAPTAIN_SESSION = 'sess-cap'
const member = (name, extra = {}) => ({ id: `child-${name}`, name, joinedAt: 1, status: 'idle', ...extra })
const task = (id, extra = {}) => ({ id, subject: `s-${id}`, status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1, ...extra })

/** A recording set of tool dependencies, over one in-memory team. */
function buildTools(options = {}) {
  const events = []
  const teams = new Map()
  if (options.team !== undefined) teams.set(options.team.id, options.team)
  const seqs = new Map()
  const calls = { kicks: [], memberKicks: [], interrupts: [], waits: [], retired: [], archived: [], mail: [], warns: [] }
  let clock = 1000
  let uuid = 0

  const deps = {
    now: () => (clock += 1),
    randomId: () => `id-${++uuid}`,
    maxMembers: options.maxMembers ?? 8,
    stateDir: '.dsh-flow',
    listTeamIds: async () => new Set(teams.keys()),
    readTeam: async id => teams.get(id),
    async appendEvents(teamId, batch) { for (const event of batch) events.push({ teamId, ...event }) },
    async nextSeq(teamId) {
      const next = seqs.get(teamId) ?? 0
      seqs.set(teamId, next + 1)
      return next
    },
    async materialize(teamId) { return teams.get(teamId) ?? { id: teamId, members: [], tasks: [] } },
    async withTeamLock(_teamId, operation) { return operation() },
    captainSessionId: exec => String(exec?.agent?.id ?? ''),
    async findTeamByCaptain(sessionId) {
      for (const team of teams.values()) if (team.captainSessionId === sessionId) return team.id
      return undefined
    },
    async findTeamByParticipant(sessionId) {
      for (const team of teams.values()) {
        if (team.captainSessionId === sessionId) return team.id
        if (team.members.some(candidate => candidate.id === sessionId)) return team.id
      }
      return undefined
    },
    async appendMessage(teamId, to, message) { calls.mail.push({ teamId, to, message }) },
    async readUnreadMailbox() { return options.unread?.[arguments[1]] ?? [] },
    async claimDelivery() {},
    async acknowledgeDelivery(teamId, to, ids) { calls.mail.push({ teamId, to, acknowledged: ids }) },
    async releaseDelivery() {},
    kickTeam: async teamId => { calls.kicks.push(teamId) },
    kickMember: async (teamId, name) => { calls.memberKicks.push([teamId, name]) },
    spawnMember: async ({ teamId, memberName }) => ({ id: `child-${memberName}` }),
    interruptMember: entry => { calls.interrupts.push(entry) },
    waitForIdle: async entry => { calls.waits.push(entry) },
    retireMembers: async ids => { calls.retired.push(...ids) },
    archiveTeam: async teamId => { calls.archived.push(teamId) },
    onWarn: message => { calls.warns.push(message) },
    isExecuting: () => options.executing !== false,
    resolveMemberRoute: async ({ request }) => ({
      provider: request.provider ?? 'deepseek',
      model: request.model ?? 'deepseek-v4-pro',
      ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
    }),
    planEdits: (team, args) => options.planEdits?.(team, args) ?? [],
    buildTeam: async ({ teamId, name }) => ({ name, phase: 'staged', members: 0, tasks: 0, events: [] }),
    spawnMembers: async () => 0,
  }

  const host = createFakeHost()
  const registered = []
  host.ctx.tools = { register: definition => { registered.push(definition); return () => {} } }
  const names = installFlowTools(host.ctx, deps)
  return { host, deps, names, registered, events, teams, calls }
}

const tool = (built, name) => built.registered.find(definition => definition.name === name)
const asCaptain = { agent: { id: CAPTAIN_SESSION } }
const asMember = name => ({ agent: { id: `child-${name}` } })

/** A staged team, which most of these start from. */
const stagedTeam = extra => ({
  name: 'T', id: 'T', captainSessionId: CAPTAIN_SESSION, createdAt: 1, taskSeq: 0,
  members: [member('a'), member('b')], tasks: [], phase: 'staged', ...extra,
})

const rejection = async (promise, pattern) => {
  await assert.rejects(promise, error => {
    assert.match(error.message, pattern)
    assert.equal(error.name, 'FlowToolError', 'a refusal must read as an instruction, not as a crash')
    return true
  })
}

// --- adding and removing members ------------------------------------------

test('a member name already used is refused, even if that member was removed', async () => {
  // The name is an identity history still refers to by: reusing it would make
  // two different people's records read as one.
  const built = buildTools({ team: stagedTeam({ members: [member('a', { status: 'removed' })] }) })
  await rejection(tool(built, 'flow_add_member').execute({ teamId: 'T', name: 'a' }, asCaptain), /has already been used/)
})

test('a member name that folds to the captain key is refused', async () => {
  const built = buildTools({ team: stagedTeam({ members: [] }) })
  for (const name of ['captain', 'Captain']) {
    await rejection(tool(built, 'flow_add_member').execute({ teamId: 'T', name }, asCaptain), /reserved for the captain/)
  }
})

test('the member cap counts live members, not tombstones', async () => {
  const built = buildTools({
    maxMembers: 2,
    team: stagedTeam({ members: [member('a'), member('b'), member('gone', { status: 'removed' })] }),
  })
  await rejection(tool(built, 'flow_add_member').execute({ teamId: 'T', name: 'c' }, asCaptain), /member cap \(2\)/)
})

test('a staged team gets a plan row and no child', async () => {
  const built = buildTools({ team: stagedTeam({ members: [] }) })
  const value = await tool(built, 'flow_add_member').execute({ teamId: 'T', name: '新成员', role: 'engineer' }, asCaptain)
  assert.equal(value.member_id, '', 'nothing was spawned')
  assert.equal(value.phase, 'staged')
  assert.deepEqual(built.events.map(event => event.type), ['member.added'])
  assert.equal(built.events[0].member.name, '新成员')
  // The new member is kicked so it can pick up waiting work; on a staged team
  // that kick is a no-op, which is what makes it safe to always ask.
  assert.deepEqual(built.calls.memberKicks, [['T', '新成员']])
})

test('removing a member requeues its unfinished work and revokes the capability', async () => {
  const built = buildTools({
    team: stagedTeam({
      phase: 'running',
      members: [member('a', { status: 'working' }), member('b')],
      tasks: [task('t1', { status: 'in_progress', assignee: 'a', attempt: 2, attemptId: 'att-2' }), task('t2')],
    }),
  })
  const value = await tool(built, 'flow_remove_member').execute({ teamId: 'T', name: 'a' }, asCaptain)

  assert.deepEqual(value.requeued_tasks, ['t1'])
  assert.equal(value.status, 'removed')
  const types = built.events.map(event => event.type)
  assert.deepEqual(types, ['task.rolled_back', 'member.removed'], 'the revocation is recorded before the removal')
  const rolled = built.events[0]
  assert.equal(rolled.assignee, null, 'the task goes back to the pool unowned')
  assert.equal(rolled.attempt, 2)
  assert.equal(rolled.attemptId, 'att-2', 'and the log names the capability it revoked')
})

test('removing a member interrupts and waits before returning', async () => {
  // An interrupt is a request. Waiting is how the handoff becomes an effect
  // rather than an intention.
  const built = buildTools({
    team: stagedTeam({ phase: 'running', members: [member('a'), member('b')] }),
  })
  await tool(built, 'flow_remove_member').execute({ teamId: 'T', name: 'a' }, asCaptain)
  assert.deepEqual(built.calls.retired, ['child-a'])
  assert.equal(built.calls.interrupts.length, 1)
  assert.deepEqual(built.calls.waits, [{ memberId: 'child-a', signal: undefined }])
})

test('a member that was never spawned is removed without an interrupt', async () => {
  const built = buildTools({
    team: stagedTeam({ phase: 'running', members: [member('a', { id: '' }), member('b')] }),
  })
  await tool(built, 'flow_remove_member').execute({ teamId: 'T', name: 'a' }, asCaptain)
  assert.deepEqual(built.calls.interrupts, [])
  assert.deepEqual(built.calls.retired, [])
})

// --- creating work ---------------------------------------------------------

test('a task is created with the next id and the gate is applied', async () => {
  const built = buildTools({ team: stagedTeam({ tasks: [task('t1')], taskSeq: 1 }) })
  const value = await tool(built, 'flow_create_task').execute({ teamId: 'T', subject: 'two' }, asCaptain)
  assert.equal(value.task_id, 't2')
  assert.equal(value.status, 'pending')
  assert.equal(built.events.at(-1).task.id, 't2')
  assert.deepEqual(built.calls.kicks, ['T'], 'creating work is also a dispatch pass')
})

test('a quality task without its contract is refused by the gate, in the gate\'s order', async () => {
  // The order is part of the behaviour: a bare review call is told what a
  // review needs first, not what it is missing last.
  const built = buildTools({ team: stagedTeam({ tasks: [], phase: 'running' }) })
  const create = tool(built, 'flow_create_task')
  await rejection(create.execute({ teamId: 'T', subject: 'review it', kind: 'review' }, asCaptain), /review tasks require a non-empty objective/)
  await rejection(create.execute({ teamId: 'T', subject: 'review it', kind: 'review', objective: 'check it' }, asCaptain), /at least one acceptance criterion/)
  await rejection(
    create.execute({ teamId: 'T', subject: 'review it', kind: 'review', objective: 'check it', acceptance: ['covered'] }, asCaptain),
    /review tasks require reviewedTaskId/,
  )
  assert.deepEqual(built.events, [], 'a refused task records nothing')
})

test('a blank optional field is dropped, not stored as empty', async () => {
  // A durable record with an empty `objective` fails validation on the next
  // load, and a load that fails takes the whole team with it.
  const built = buildTools({ team: stagedTeam({ tasks: [] }) })
  const value = await tool(built, 'flow_create_task').execute({ teamId: 'T', subject: 'one', objective: '   ' }, asCaptain)
  assert.equal(value.task_id, 't1')
  assert.equal('objective' in built.events.at(-1).task, false)
})

test('an assignee that is not a member is refused by name', async () => {
  const built = buildTools({ team: stagedTeam({ tasks: [] }) })
  await rejection(
    tool(built, 'flow_create_task').execute({ teamId: 'T', subject: 'one', assignee: 'ghost' }, asCaptain),
    /no active member named "ghost"/,
  )
})

// --- claiming --------------------------------------------------------------

test('a member cannot claim a task assigned to somebody else', async () => {
  const built = buildTools({ team: stagedTeam({ phase: 'running', tasks: [task('t1', { assignee: 'b' })] }) })
  await rejection(tool(built, 'flow_claim_task').execute({ teamId: 'T', task_id: 't1' }, asMember('a')), /assigned to "b", not you/)
})

test('a member can claim an unassigned ready task, and gets a capability', async () => {
  const built = buildTools({ team: stagedTeam({ phase: 'running', tasks: [task('t1')] }) })
  const value = await tool(built, 'flow_claim_task').execute({ teamId: 'T', task_id: 't1' }, asMember('a'))
  assert.equal(value.assignee, 'a')
  assert.equal(value.attempt, 1)
  assert.equal(value.attempt_id, 'id-1')
  assert.equal(built.events.at(-1).type, 'task.attempt_started')
})

test('re-claiming an already claimed task returns the same capability', async () => {
  // The member is asking "what is my attempt id", which is the ordinary case
  // after a turn boundary. Refusing it would make the tool unusable.
  const built = buildTools({
    team: stagedTeam({ phase: 'running', tasks: [task('t1', { status: 'claimed', assignee: 'a', attempt: 1, attemptId: 'live' })] }),
  })
  const value = await tool(built, 'flow_claim_task').execute({ teamId: 'T', task_id: 't1' }, asMember('a'))
  assert.equal(value.attempt_id, 'live')
  assert.deepEqual(built.events, [], 'and nothing is recorded, because nothing changed')
})

test('a captain cannot use the claim tool to hand out work', async () => {
  // A captain claiming on a member's behalf would take the work without waking
  // anyone: the task would look assigned and nothing would ever happen.
  const built = buildTools({ team: stagedTeam({ phase: 'running', tasks: [task('t1', { assignee: 'a' })] }) })
  await rejection(
    tool(built, 'flow_claim_task').execute({ teamId: 'T', task_id: 't1' }, asCaptain),
    /captains must use flow_reassign_task/,
  )
})

test('a blocked task cannot be claimed', async () => {
  const built = buildTools({
    team: stagedTeam({ phase: 'running', tasks: [task('t1'), task('t2', { dependencies: ['t1'] })] }),
  })
  await rejection(tool(built, 'flow_claim_task').execute({ teamId: 'T', task_id: 't2' }, asMember('a')), /blocked by unfinished dependencies: t1/)
})

// --- updating --------------------------------------------------------------

test('a stale attempt is refused before the terminal state is considered', async () => {
  // The reason that matters is the stale capability. Reporting "immutable"
  // instead would send the member looking for the wrong problem.
  const built = buildTools({
    team: stagedTeam({
      phase: 'running',
      tasks: [task('t1', { status: 'completed', assignee: 'a', attempt: 1, attemptId: 'current' })],
    }),
  })
  await rejection(
    tool(built, 'flow_update_task').execute({ teamId: 'T', task_id: 't1', status: 'failed', attempt_id: 'stale' }, asMember('a')),
    /stale attempt/,
  )
})

test('a terminal task is immutable, and saying so changes nothing', async () => {
  const built = buildTools({
    team: stagedTeam({ phase: 'running', tasks: [task('t1', { status: 'completed', assignee: 'a', attempt: 1, output: 'done' })] }),
  })
  const update = tool(built, 'flow_update_task')
  await rejection(update.execute({ teamId: 'T', task_id: 't1', status: 'failed' }, asMember('a')), /immutable/)
  const same = await update.execute({ teamId: 'T', task_id: 't1', status: 'completed', output: 'done' }, asMember('a'))
  assert.equal(same.status, 'completed')
  assert.deepEqual(built.events, [])
})

test('a quality task cannot complete without its evidence', async () => {
  const built = buildTools({
    team: stagedTeam({
      phase: 'running',
      tasks: [task('t1', {
        kind: 'implementation', status: 'in_progress', assignee: 'a', attempt: 1, attemptId: 'att-1',
        inScope: ['src/'], verify: ['npm test'], acceptance: ['it works'],
      })],
    }),
  })
  await rejection(
    tool(built, 'flow_update_task').execute({ teamId: 'T', task_id: 't1', status: 'completed', attempt_id: 'att-1' }, asMember('a')),
    /requires passed acceptanceResults/,
  )
})

test('a completed quality task records its result as one fact', async () => {
  const built = buildTools({
    team: stagedTeam({
      phase: 'running',
      tasks: [task('t1', {
        kind: 'implementation', status: 'in_progress', assignee: 'a', attempt: 1, attemptId: 'att-1',
        inScope: ['src/'], verify: ['npm test'], acceptance: ['it works'],
      })],
    }),
  })
  const value = await tool(built, 'flow_update_task').execute({
    teamId: 'T', task_id: 't1', status: 'completed', attempt_id: 'att-1', output: 'shipped',
    acceptanceResults: [{ criterion: 'it works', status: 'passed' }],
    commandsRun: [{ command: 'npm test', status: 'passed' }],
    changedPaths: ['src/a.js'],
  }, asMember('a'))
  assert.equal(value.status, 'completed')
  assert.equal(built.events.at(-1).type, 'task.completed')
  assert.equal(built.events.at(-1).verdict, undefined, 'a plain implementation has no verdict to give')
})

test('a needs_revision review derives the next round rather than ending', async () => {
  // This is the loop the whole quality model exists for: the captain does not
  // notice the failure and plan a repair, the policy plans it.
  const built = buildTools({
    team: stagedTeam({
      phase: 'running', taskSeq: 2,
      members: [member('a'), member('b')],
      tasks: [
        task('t1', { kind: 'implementation', status: 'completed', assignee: 'b', inScope: ['src/'], verify: ['npm test'], acceptance: ['ok'] }),
        task('t2', { kind: 'review', status: 'in_progress', assignee: 'a', attempt: 1, attemptId: 'att-1', reviewedTaskId: 't1', round: 1, objective: 'review it', acceptance: ['covered'] }),
      ],
    }),
  })
  await tool(built, 'flow_update_task').execute({
    teamId: 'T', task_id: 't2', status: 'failed', attempt_id: 'att-1', verdict: 'needs_revision',
    findings: [{ id: 'f1', severity: 'high', problem: 'missing case', requiredFix: 'add the case', file: 'src/a.js' }],
  }, asMember('a'))

  // The policy plans the whole round — the repair, and the review that will
  // judge it. The captain does not notice the failure and schedule anything.
  const created = built.events.filter(event => event.type === 'task.created')
  assert.deepEqual(created.map(event => event.task.kind), ['repair', 'review'])
  assert.equal(created[0].task.sourceTaskId, 't1')
  assert.deepEqual(created[0].task.sourceFindingIds, ['f1'])
  assert.equal(created[0].task.assignee, 'b', 'the implementer who wrote it fixes it')
  assert.equal(created[1].task.reviewedTaskId, created[0].task.id, 'and the new review judges the new repair')
  assert.equal(created[1].task.assignee, 'a', 'by somebody other than the implementer')
  assert.deepEqual(created.map(event => event.task.id), ['t3', 't4'], 'the ids come from the team counter, not the findings')
})

// --- ending ----------------------------------------------------------------

test('resuming an already-running team is an answer, not an event', async () => {
  const built = buildTools({ team: stagedTeam({ phase: 'running' }) })
  const value = await tool(built, 'flow_resume').execute({ teamId: 'T', reason: 'carry on' }, asCaptain)
  assert.equal(value.status, 'already_running')
  assert.deepEqual(built.events, [], 'a resume event on a team that was never halted would be a fact that never happened')
  assert.deepEqual(built.calls.kicks, [], 'and there is nothing to wake')
})

test('resuming a halted team requires a reason and records it', async () => {
  const built = buildTools({ team: stagedTeam({ phase: 'running', halted: true }) })
  await rejection(tool(built, 'flow_resume').execute({ teamId: 'T', reason: '   ' }, asCaptain), /non-empty reason/)
  const value = await tool(built, 'flow_resume').execute({ teamId: 'T', reason: 'user said go' }, asCaptain)
  assert.equal(value.status, 'resumed')
  assert.equal(built.events.at(-1).type, 'team.resumed')
  assert.equal(built.events.at(-1).reason, 'user said go')
  assert.deepEqual(built.calls.kicks, ['T'])
})

test('ending a team archives it and retires every member it ever had', async () => {
  const built = buildTools({
    team: stagedTeam({
      phase: 'running',
      members: [member('a', { status: 'working' }), member('b'), member('old', { status: 'removed' })],
      tasks: [task('t1', { status: 'in_progress', assignee: 'a', attempt: 1, attemptId: 'att-1' }), task('t2')],
    }),
  })
  const value = await tool(built, 'flow_delete').execute({ teamId: 'T' }, asCaptain)

  assert.deepEqual(value, { deleted: true, team_name: 'T' })
  const types = built.events.map(event => event.type)
  assert.equal(types.at(-1), 'team.archived', 'the archive marker is last, so the record reads as ended')
  assert.equal(types.filter(type => type === 'member.removed').length, 2, 'the live members are removed')

  // Including the one removed earlier: it is still a session carrying this
  // team's label, and the deny-list is the only thing that would refuse it.
  assert.deepEqual(built.calls.retired, ['child-a', 'child-b', 'child-old'])
  assert.deepEqual(built.calls.archived, ['T'])
})

test('a member that will not quiesce does not stop the archive', async () => {
  const built = buildTools({
    team: stagedTeam({ phase: 'running', members: [member('a')] }),
  })
  built.deps.waitForIdle = async () => { throw new Error('still working') }
  const value = await tool(built, 'flow_delete').execute({ teamId: 'T' }, asCaptain)
  assert.equal(value.deleted, true, 'refusing to archive would leave the plugin unable to end a stuck team')
  assert.deepEqual(built.calls.archived, ['T'])
})

// --- messaging -------------------------------------------------------------

test('a message is durable before delivery is attempted', async () => {
  const built = buildTools({ team: stagedTeam({ phase: 'running' }) })
  const value = await tool(built, 'flow_send_message').execute({ teamId: 'T', to: 'a', content: 'status?' }, asCaptain)
  assert.equal(value.delivered, 'mailbox', 'no live captain was supplied, so it stays in the inbox')
  assert.equal(built.calls.mail[0].message.content, 'status?')
  assert.equal(built.events.at(-1).type, 'message.sent')
})

test('a member cannot speak in the captain\'s name', async () => {
  const built = buildTools({ team: stagedTeam({ phase: 'running' }) })
  await rejection(
    tool(built, 'flow_send_message').execute({ teamId: 'T', to: CAPTAIN_KEY, content: 'go', from: CAPTAIN_KEY }, asMember('a')),
    /must be your own identity \("a"\)/,
  )
})

test('waking a member of a halted team is refused, but reporting is not', async () => {
  const built = buildTools({ team: stagedTeam({ phase: 'running', halted: true }) })
  await rejection(
    tool(built, 'flow_send_message').execute({ teamId: 'T', to: 'a', content: 'wake up' }, asCaptain),
    /is halted; call flow_resume/,
  )
  const value = await tool(built, 'flow_send_message').execute({ teamId: 'T', to: CAPTAIN_KEY, content: 'we stopped' }, asMember('a'))
  assert.equal(value.message_id, 'id-1', 'a member can still report why it stopped')
})

test('the caller must be a participant, not a stranger', async () => {
  const built = buildTools({ team: stagedTeam({ phase: 'running' }) })
  await rejection(
    tool(built, 'flow_status').execute({ teamId: 'T' }, { agent: { id: 'someone-else' } }),
    /do not lead or belong to any active team/,
  )
})

test('status acknowledges what it just reported', async () => {
  // Showing a message and leaving it unread would deliver it again next kick.
  const built = buildTools({
    team: stagedTeam({ phase: 'running' }),
    unread: { a: [{ id: 'm1', from: CAPTAIN_KEY, to: 'a', content: 'work?', ts: 1 }] },
  })
  const value = await tool(built, 'flow_status').execute({ teamId: 'T' }, asMember('a'))
  assert.equal(value.viewer, 'a')
  assert.deepEqual(value.member_inboxes.a, { count: 1, latest: 'work?' })
  assert.equal(value.captain_inbox.length, 0, 'a member does not see the captain\'s mail')
  assert.deepEqual(built.calls.mail.at(-1), { teamId: 'T', to: 'a', acknowledged: ['m1'] })
})
