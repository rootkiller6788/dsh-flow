// Contract for the append-only event log.
//
// There is no TypeScript original to diff against — this layer exists precisely
// because agent-teams' snapshot model cannot express it. So the tests state the
// properties the log must have rather than comparing against a reference: an
// event either carries what its reducer reads, or it is rejected at the
// boundary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEAM_EVENT_TYPES, isTeamEvent, teamEvent, parseEventLog, serializeEventLog,
  requiredEventFields, optionalEventFields,
} from '../src/rules/index.js'

test('every declared type has a payload schema', () => {
  for (const type of TEAM_EVENT_TYPES) {
    assert.ok(Array.isArray(requiredEventFields(type)), `${type} has no schema`)
    assert.ok(Array.isArray(optionalEventFields(type)), `${type} has no optional list`)
  }
})

test('teamEvent fills the envelope and round-trips through the log', () => {
  const event = teamEvent('task.transitioned', { id: 't1', from: 'pending', to: 'claimed' }, 1000, 0)
  assert.deepEqual(event, { type: 'task.transitioned', at: 1000, seq: 0, id: 't1', from: 'pending', to: 'claimed' })
  const parsed = parseEventLog(serializeEventLog([event]))
  assert.deepEqual(parsed, [event])
})

test('teamEvent rejects a type outside the vocabulary', () => {
  assert.throws(() => teamEvent('task.exploded', {}, 0, 0), /unknown team event type/)
})

test('teamEvent rejects a payload missing what its reducer reads', () => {
  assert.throws(() => teamEvent('task.rolled_back', { id: 't1' }, 0, 0), /incomplete payload/)
  assert.throws(() => teamEvent('message.sent', { from: 'a', to: 'b' }, 0, 0), /incomplete payload/)
})

test('a rollback must name a real status', () => {
  assert.ok(isTeamEvent({ type: 'task.rolled_back', at: 1, seq: 0, id: 't1', toStatus: 'pending', reason: 'r' }))
  assert.ok(!isTeamEvent({ type: 'task.rolled_back', at: 1, seq: 0, id: 't1', toStatus: 'nonsense', reason: 'r' }))
})

test('an empty message body is a valid event', () => {
  // `content` may be blank — a member can be told to stop with no text.
  assert.ok(isTeamEvent({ type: 'message.sent', at: 1, seq: 0, from: 'a', to: 'b', content: '' }))
})

test('the envelope is required', () => {
  assert.ok(!isTeamEvent({ type: 'team.archived' }))
  assert.ok(!isTeamEvent({ type: 'team.archived', at: Number.NaN, seq: 0 }))
  assert.ok(!isTeamEvent({ type: 'team.archived', at: 1, seq: -1 }))
  assert.ok(!isTeamEvent({ type: 'team.archived', at: 1, seq: 1.5 }))
  assert.ok(!isTeamEvent(null))
  assert.ok(!isTeamEvent([]))
})

test('a torn line is reported and skipped, not fatal', () => {
  const body = [
    JSON.stringify({ type: 'team.archived', at: 1, seq: 0 }),
    'not json',
    JSON.stringify({ type: 'team.halted', at: 2, seq: 1, reason: 'stop' }),
  ].join('\n')
  const reported = []
  const events = parseEventLog(body, (line, error) => reported.push([line, error.message]))
  assert.equal(events.length, 2)
  assert.deepEqual(reported, [[2, 'invalid JSON']])
})

test('a well-formed line out of sequence is reported rather than reordered', () => {
  // Position in the log is the log's own business: a file whose seq numbers do
  // not match its line order is damaged, and guessing at the intent would
  // silently reorder history.
  const body = [
    JSON.stringify({ type: 'team.archived', at: 1, seq: 5 }),
  ].join('\n')
  const reported = []
  const events = parseEventLog(body, (line, error) => reported.push([line, error.message]))
  assert.equal(events.length, 0)
  assert.deepEqual(reported, [[1, 'expected seq 0, found 5']])
})

test('blank lines and a leading BOM are tolerated', () => {
  const body = `﻿${JSON.stringify({ type: 'team.archived', at: 1, seq: 0 })}\n\n`
  assert.equal(parseEventLog(body).length, 1)
})

test('an empty log parses to no events', () => {
  assert.deepEqual(parseEventLog(''), [])
  assert.equal(serializeEventLog([]), '')
})
