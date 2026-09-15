// Contract for profile expansion and plan editing.
//
// Both are pure: a profile record and a request go in, events come out. That is
// what makes them testable without a store, and it is why the profile *registry*
// — which is deployment configuration — lives elsewhere.
//
// The property that matters most is stated once and checked throughout: the
// events an expansion produces must project to a team that passes every entity
// validator. Events that describe an unloadable team are worse than a refusal,
// because the refusal happens here and the unloadable team happens later.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTeamEvents, planTeamEdits, projectTeam, isTeamState } from '../src/rules/index.js'

const profile = extra => ({
  name: 'feature',
  description: 'ship a feature',
  members: [{ name: '建模手', role: 'scientist' }, { name: '程序员', role: 'engineer' }],
  ...extra,
})

const request = extra => ({
  teamId: 'feature',
  name: 'Feature',
  description: 'ship it',
  captainSessionId: 'sess-cap',
  now: 1000,
  profile: profile(),
  ...extra,
})

/** Expand, project, and insist the result is a team the validators accept. */
function expand(overrides) {
  const built = buildTeamEvents(request(overrides))
  assert.equal(built.error, undefined, `expansion failed: ${built.error}`)
  const projected = projectTeam(built.events)
  assert.ok(isTeamState(projected.state, projected.state.id), 'the events must describe a loadable team')
  return { built, state: projected.state }
}

test('a profile expands to a created team with its members', () => {
  const { state, built } = expand({})
  assert.equal(state.name, 'Feature')
  assert.equal(state.phase, 'staged')
  assert.equal(state.captainSessionId, 'sess-cap')
  assert.deepEqual(state.members.map(member => member.name), ['建模手', '程序员'])
  assert.equal(built.members, 2)
  assert.equal(state.members[0].role, 'scientist')
})

test('the profile is recorded as a snapshot, not as a reference', () => {
  // Editing the profile tomorrow must not change what this team was.
  const { state } = expand({})
  assert.equal(state.profile.name, 'feature')
  assert.equal(state.profile.description, 'ship a feature')
  assert.equal('members' in state.profile, false, 'the snapshot carries what a reader needs, not the template')
})

test('seed tasks are ordered by their dependencies and renumbered', () => {
  const { state } = expand({
    profile: profile({
      tasks: [
        { id: 'build', subject: 'build it', dependencies: ['spec'], assignee: '程序员' },
        { id: 'spec', subject: 'pin the spec', dependencies: [], assignee: '建模手' },
      ],
    }),
  })
  assert.deepEqual(state.tasks.map(task => task.id), ['t1', 't2'])
  assert.deepEqual(state.tasks.map(task => task.profileSeedId), ['spec', 'build'], 'the declared order is not the order')
  assert.deepEqual(state.tasks[1].dependencies, ['t1'], 'and the dependency follows the renumbering')
  assert.equal(state.tasks[0].assignee, '建模手')
})

test('a cyclic profile is refused rather than partially built', () => {
  const built = buildTeamEvents(request({
    profile: profile({
      tasks: [
        { id: 'a', subject: 'a', dependencies: ['b'] },
        { id: 'b', subject: 'b', dependencies: ['a'] },
      ],
    }),
  }))
  assert.match(built.error, /dependency cycle/)
})

test('a seed task assigned to somebody who is not on the profile is refused', () => {
  const built = buildTeamEvents(request({
    profile: profile({ tasks: [{ id: 'a', subject: 'a', dependencies: [], assignee: 'ghost' }] }),
  }))
  assert.match(built.error, /assigns "ghost", who is not a member/)
})

test('a member name colliding with the captain key is refused, not renamed', () => {
  // Renaming would make the team that was created differ from the one that was
  // described, which is a worse failure than refusing the profile.
  const built = buildTeamEvents(request({ profile: profile({ members: [{ name: 'Captain' }] }) }))
  assert.match(built.error, /collides with the captain's reserved key/)
})

test('two members that fold to the same key are refused', () => {
  const built = buildTeamEvents(request({ profile: profile({ members: [{ name: 'A B' }, { name: 'a-b' }] }) }))
  assert.match(built.error, /fold to the same key/)
})

test('a profile with no members still makes a team the captain can plan into', () => {
  // `taskPlanning: captain` means the graph is the captain's to design, and an
  // empty roster is how that starts.
  const { state } = expand({ profile: profile({ members: [], taskPlanning: 'captain' }) })
  assert.equal(state.members.length, 0)
  assert.equal(state.profile.taskPlanning, 'captain')
})

// --- plan editing ----------------------------------------------------------

const staged = extra => projectTeam(expand({
  profile: profile({ tasks: [{ id: 'one', subject: 'first', dependencies: [] }] }),
}).built.events).state

test('adding a member and a task is recorded as two events', () => {
  const events = planTeamEdits(staged(), {
    addMembers: [{ name: '审查员', role: 'reviewer' }],
    addTasks: [{ subject: 'second', kind: 'work' }],
  }, 2000)
  assert.deepEqual(events.map(event => event.type), ['member.added', 'task.created'])
})

test('a task added in the same call can depend on one added before it', () => {
  // Otherwise a captain could not describe a two-step plan in one call, which
  // is the ordinary way a plan is written.
  const events = planTeamEdits(staged(), {
    addTasks: [{ subject: 'second' }, { subject: 'third', dependencies: ['t2'] }],
  }, 2000)
  const created = events.filter(event => event.type === 'task.created')
  assert.deepEqual(created.map(event => event.task.id), ['t2', 't3'])
  assert.deepEqual(created[1].task.dependencies, ['t2'])
})

test('removing a task another task depends on is refused, by name', () => {
  const team = projectTeam([
    ...expand({ profile: profile({ tasks: [{ id: 'one', subject: 'first', dependencies: [] }] }) }).built.events,
    { type: 'task.created', at: 1001, seq: 99, task: { subject: 'second', dependencies: ['t1'] } },
  ]).state
  const result = planTeamEdits(team, { removeTasks: ['t1'] }, 2000)
  assert.match(result.error, /cannot be removed while "t2" depends on it/)
})

test('removing a task nothing depends on is recorded', () => {
  const events = planTeamEdits(staged(), { removeTasks: ['t1'] }, 2000)
  assert.deepEqual(events, [{ type: 'task.removed', at: 2000, seq: 0, id: 't1', reason: 'removed by plan edit' }])
})

test('a duplicate member is refused rather than added twice', () => {
  assert.match(planTeamEdits(staged(), { addMembers: [{ name: '建模手' }] }, 2000).error, /already on this team/)
})

test('removing somebody who is not on the team is refused', () => {
  assert.match(planTeamEdits(staged(), { removeMembers: ['ghost'] }, 2000).error, /is not on this team/)
})

test('an edit that would break the gate is refused here, not at approval', () => {
  // A staged plan is still a plan: letting a review task through without a
  // subject to review would move the failure to the moment work starts.
  const team = staged()
  const result = planTeamEdits(team, {
    addTasks: [{ subject: 'review it', kind: 'review', objective: 'check', acceptance: ['ok'] }],
  }, 2000)
  assert.match(result.error, /review tasks require reviewedTaskId/)
})
