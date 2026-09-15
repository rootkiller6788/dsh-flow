// Contract for the import report.
//
// The rule this serves is `AGENTS.md:113` — never silently skip a missing
// referent — applied at the one boundary where skipping is the tolerant
// behaviour. Parsing a log must not stop at a bad line, and nothing about the
// bad line may be quiet either. So the two properties under test are:
//
//   a damaged file leaves a record, from either reader (the event log and the
//   mailboxes are read by different layers and fail differently);
//
//   the record does not grow with the number of times it is re-read — the canvas
//   polls once a second, and a report that grew per poll would bury the one
//   damaged line under its own repetitions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAIL_DIRECTORY } from '../src/store/mailbox.js'
import { canvasSnapshot } from '../src/store/snapshot.js'
import { createFlowDiagnostics } from '../src/store/diagnostics.js'
import { createFlowStore } from '../src/store/index.js'
import { createSourceRegistry } from '../src/sources/sources.js'
import { teamEvent } from '../src/rules/index.js'
import { warningsHtml } from '../src/canvas/team-panels.js'

const inert = { buildTeam: async () => {}, planEdits: () => [], spawnMembers: async () => 0, kickTeam: async () => {} }

test('a damaged line is recorded once, however many times it is re-read', () => {
  // The poll re-reads the same files every second. Recording each sighting would
  // turn one damaged line into a wall of identical entries — the opposite of
  // making it visible.
  const report = createFlowDiagnostics()
  for (let poll = 0; poll < 50; poll++) {
    report.record({ kind: 'mailbox', teamId: 'T', member: 'a', line: 7, reason: 'invalid JSON' })
  }
  assert.equal(report.count(), 1)
})

test('the two readers are told apart, and both are kept', () => {
  // They mean different things to a reader: a damaged mailbox loses messages, a
  // damaged log loses what happened. Collapsing them would hide which.
  const report = createFlowDiagnostics()
  report.record({ kind: 'log', teamId: 'T', line: 3, reason: 'expected seq 3, found 5' })
  report.record({ kind: 'mailbox', teamId: 'T', member: 'a', line: 7, reason: 'invalid JSON' })
  const warnings = report.forTeam('T')
  assert.deepEqual(warnings.map(entry => entry.kind), ['log', 'mailbox'])
  assert.equal(warnings[0].member, undefined)
  assert.equal(warnings[1].member, 'a')
})

test('the same line number in two members is two findings', () => {
  // Line 7 of one inbox has nothing to do with line 7 of another.
  const report = createFlowDiagnostics()
  report.record({ kind: 'mailbox', teamId: 'T', member: 'a', line: 7, reason: 'invalid JSON' })
  report.record({ kind: 'mailbox', teamId: 'T', member: 'b', line: 7, reason: 'invalid JSON' })
  assert.equal(report.count(), 2)
})

test('the report is grouped by team, because that is the first question', () => {
  const report = createFlowDiagnostics()
  report.record({ kind: 'log', teamId: 'T', line: 1, reason: 'x' })
  report.record({ kind: 'log', teamId: 'T', line: 2, reason: 'x' })
  report.record({ kind: 'log', teamId: 'U', line: 1, reason: 'x' })
  assert.deepEqual(report.summary(), {
    total: 3,
    teams: [{ teamId: 'T', count: 2 }, { teamId: 'U', count: 1 }],
  })
  assert.equal(report.forTeam('U').length, 1)
  assert.deepEqual(report.forTeam('ghost'), [])
})

test('a clean deployment reports nothing at all', () => {
  const report = createFlowDiagnostics()
  assert.equal(report.count(), 0)
  assert.deepEqual(report.summary(), { total: 0, teams: [] })
})

// --- the wiring, against a really damaged file -----------------------------

test('a damaged inbox line reaches whoever reads it, instead of vanishing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-diag-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { service } = createFlowStore({ root, hooks: inert })
  await service.createTeam('T')
  await service.appendEvents('T', [
    teamEvent('team.created', { name: 'T', captainSessionId: 'sess-cap' }, 1000, 0),
    teamEvent('member.added', { member: { id: 'child-a', name: 'a' } }, 1001, 1),
  ])
  await service.appendMessage('T', 'a', { id: 'm1', from: 'captain', to: 'a', content: 'hi', ts: 1 })
  // What a truncated write leaves behind: one good line, then one that is not
  // JSON. The good one must still be read — parsing does not stop — and the bad
  // one must still be reported.
  await appendFile(join(root, 'T', MAIL_DIRECTORY, 'a.jsonl'), '{ broken\n', 'utf8')

  const report = createFlowDiagnostics()
  const snapshot = await canvasSnapshot(createSourceRegistry({ native: service }), {
    onMalformedLine: (teamId, memberName, line, error) => report.record({ kind: 'mailbox', teamId, member: memberName, line, reason: error.message }),
  })

  assert.equal(snapshot.teams[0].members.find(member => member.name === 'a').unread, 1, 'the readable line is still read')
  const warnings = report.forTeam('T')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].kind, 'mailbox')
  assert.equal(warnings[0].member, 'a')
  assert.equal(warnings[0].line, 2, 'the damaged line is the second one')
  assert.match(warnings[0].reason, /invalid JSON/)
})

// --- what the reader sees --------------------------------------------------

test('every damaged line is listed, with the line number that makes it fixable', () => {
  // A count would throw away the only part anyone can act on.
  const html = warningsHtml([
    { kind: 'mailbox', teamId: 'T', member: '建模手', line: 7, reason: 'invalid JSON' },
    { kind: 'log', teamId: 'T', line: 3, reason: 'expected seq 3, found 5' },
  ])
  assert.match(html, /收件箱 · 建模手/)
  assert.match(html, /第 7 行/)
  assert.match(html, /事件日志/)
  assert.match(html, /第 3 行/)
  assert.match(html, /expected seq 3, found 5/)
  assert.match(html, /2 处/)
})

test('a team with nothing damaged renders nothing rather than an empty box', () => {
  for (const value of [undefined, [], 'nope']) assert.equal(warningsHtml(value), '', JSON.stringify(value))
})

test('a finding against a whole record shows no line number', () => {
  // A team that cannot be projected has no line to point at, and inventing one
  // would send the reader looking for a line that is not the problem.
  const html = warningsHtml([{ kind: 'team', teamId: 'T', reason: '记录不满足团队状态契约' }])
  assert.match(html, /团队记录/)
  assert.doesNotMatch(html, /第/)
  assert.match(html, /记录不满足团队状态契约/)
})

test('a team that exists but cannot be projected is reported, not passed over', async t => {
  // The worst version of a silent skip: the reader sees a directory on disk and
  // nothing on the canvas, and nothing says why.
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-diag-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { service } = createFlowStore({ root, hooks: inert })
  await service.createTeam('T')
  // A running team with a member that has no session. Each event is legal on its
  // own — a member without an id is what a staged roster looks like — and the
  // pair is not: the validator refuses an empty id outside a staged team. So the
  // log parses, the projection produces something, and `isTeamState` rejects it.
  await service.appendEvents('T', [
    teamEvent('team.created', { name: 'T', captainSessionId: 'sess-cap' }, 1000, 0),
    teamEvent('member.added', { member: { name: 'planned' } }, 1001, 1),
  ])

  const named = []
  const snapshot = await canvasSnapshot(createSourceRegistry({ native: service }), {
    onInvalidTeam: (teamId, reason) => named.push({ teamId, reason }),
  })
  assert.deepEqual(snapshot.teams, [], 'it is not drawn')
  assert.equal(named.length, 1, 'and it is not silent either')
  assert.equal(named[0].teamId, 'T')
  assert.match(named[0].reason, /契约/)
})

test('what a damaged file contained cannot break out of the report', () => {
  const html = warningsHtml([{ kind: 'mailbox', teamId: 'T', member: '<img src=x>', line: 1, reason: '<script>' }])
  assert.doesNotMatch(html, /<img|<script>/)
  assert.match(html, /&lt;img src=x&gt;/)
})
