// Contract for the role vocabulary: who is what, and what they may not reach.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLOW_TOOL_NAMES, FLOW_MEMBER_TOOL_NAMES, FLOW_CAPTAIN_TOOL_NAMES, FLOW_ROLES,
  roleInTeam, deniedToolsFor, isMemberRole, promptForRole,
  FLOW_ACTIVATION_PROMPT, FLOW_MEMBER_PROMPT,
} from '../src/rules/index.js'

const team = {
  captainSessionId: 'sess-cap',
  members: [{ id: 'child-1', name: '建模手' }, { id: '', name: '未派生' }],
}

test('the member set is a strict subset of the whole vocabulary', () => {
  for (const name of FLOW_MEMBER_TOOL_NAMES) {
    assert.ok(FLOW_TOOL_NAMES.includes(name), `${name} is not in the vocabulary`)
  }
  assert.equal(FLOW_MEMBER_TOOL_NAMES.length, 4)
  assert.equal(FLOW_CAPTAIN_TOOL_NAMES.length, FLOW_TOOL_NAMES.length - FLOW_MEMBER_TOOL_NAMES.length)
})

test('the two sets partition the vocabulary', () => {
  const union = [...FLOW_MEMBER_TOOL_NAMES, ...FLOW_CAPTAIN_TOOL_NAMES].sort()
  assert.deepEqual(union, [...FLOW_TOOL_NAMES].sort())
  for (const name of FLOW_CAPTAIN_TOOL_NAMES) {
    assert.ok(!FLOW_MEMBER_TOOL_NAMES.includes(name), `${name} cannot be in both`)
  }
})

test('a role is decided by session id, not by name', () => {
  assert.equal(roleInTeam(team, 'sess-cap'), 'captain')
  assert.equal(roleInTeam(team, 'child-1'), 'member')
  assert.equal(roleInTeam(team, '建模手'), 'unrelated', 'a display name is not an identity')
  assert.equal(roleInTeam(team, 'child-9'), 'unrelated')
})

test('an unspawned member is not a member yet', () => {
  // A staged member has no durable session id, so nothing is routing to it.
  assert.equal(roleInTeam(team, ''), 'unrelated')
})

test('a missing team makes every session unrelated, not an error', () => {
  // Most sessions on a machine have nothing to do with any given team.
  assert.equal(roleInTeam(undefined, 'sess-cap'), 'unrelated')
  assert.equal(roleInTeam(null, 'x'), 'unrelated')
  assert.equal(roleInTeam({ captainSessionId: 'a' }, 'b'), 'unrelated', 'a team with no members array is readable')
})

test('only members are denied anything', () => {
  assert.deepEqual(deniedToolsFor('member'), [...FLOW_CAPTAIN_TOOL_NAMES])
  assert.deepEqual(deniedToolsFor('captain'), [])
  assert.deepEqual(deniedToolsFor('unrelated'), [], 'an unrelated session must not be constrained')
  assert.equal(isMemberRole('member'), true)
  assert.equal(isMemberRole('captain'), false)
})

test('the role vocabulary is closed', () => {
  assert.deepEqual([...FLOW_ROLES], ['captain', 'member', 'unrelated'])
})

test('a member is told the member contract, never the captain activation text', () => {
  const member = promptForRole('member', 'deployment specifics')
  assert.equal(member, FLOW_MEMBER_PROMPT)
  assert.doesNotMatch(member, /deployment specifics/)

  const captain = promptForRole('captain', 'deployment specifics')
  assert.match(captain, /deployment specifics/)
  assert.ok(captain.startsWith(FLOW_ACTIVATION_PROMPT))
  assert.doesNotMatch(captain, /You are a dsh-flow member/)
})

test('an unrelated session is given the captain text, not the member text', () => {
  // It is not a member; treating every unrecognized session as one would
  // restrict tools on conversations that have nothing to do with a team.
  assert.match(promptForRole('unrelated', 'x'), /x/)
})

test('the member contract names the tools it may use and forbids the rest', () => {
  for (const name of FLOW_MEMBER_TOOL_NAMES) assert.match(FLOW_MEMBER_PROMPT, new RegExp(name))
  assert.match(FLOW_MEMBER_PROMPT, /Do not create, approve, edit or resume a team/)
  assert.match(FLOW_MEMBER_PROMPT, /attempt_id/)
})

test('the activation text says what is not a request', () => {
  // Mentioning the capability is not asking for it; without this line a model
  // reads the prompt itself as an instruction to start work.
  assert.match(FLOW_ACTIVATION_PROMPT, /alone is not a request to start work/)
})
