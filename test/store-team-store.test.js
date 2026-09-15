// Contract for the team store.
//
// These run against a real temporary directory rather than a faked filesystem,
// because the properties under test — atomic replacement, append-only growth, a
// checkpoint that can be thrown away — are properties of the filesystem, not of
// a function signature. Faking `fs` here would test a model of the thing
// instead of the thing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTeamStore, EVENTS_FILE, STATE_FILE, MANIFEST_FILE, ARCHIVE_DIRECTORY } from '../src/store/team-store.js'
import { teamEvent } from '../src/rules/index.js'

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-flow-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const store = (t, options = {}) => createTeamStore({ root: scratch(t), now: () => 1000, ...options })

/** A log that produces a valid team. */
const creationLog = (name = 'T') => [
  teamEvent('team.created', { name, captainSessionId: 'sess-cap' }, 1000, 0),
  teamEvent('member.added', { member: { id: 'child-a', name: 'a' } }, 1001, 1),
  teamEvent('task.created', { task: { subject: 'work' } }, 1002, 2),
]

test('a team is created with a manifest, and reads back from its log', async t => {
  const teams = store(t)
  await teams.createTeam('T')
  assert.ok(existsSync(join(teams.root, 'T', MANIFEST_FILE)))
  assert.equal((await teams.readManifest('T')).schemaVersion, 1)

  await teams.appendEvents('T', creationLog())
  const team = await teams.readTeam('T')
  assert.equal(team.name, 'T')
  assert.equal(team.members.length, 1)
  assert.equal(team.tasks.length, 1)
  assert.equal(team.taskSeq, 1)
})

test('the log only grows, and appending does not rewrite history', async t => {
  // A whole-file rewrite would make every append cost the whole history.
  const teams = store(t)
  await teams.createTeam('T')
  await teams.appendEvents('T', creationLog())
  const afterFirst = readFileSync(join(teams.root, 'T', EVENTS_FILE), 'utf8')

  await teams.appendEvents('T', [teamEvent('team.halted', {}, 1003, 3)])
  const afterSecond = readFileSync(join(teams.root, 'T', EVENTS_FILE), 'utf8')

  assert.equal(afterSecond.startsWith(afterFirst), true, 'the earlier bytes are untouched')
  assert.equal(afterSecond.length > afterFirst.length, true)
  assert.equal((await teams.readTeam('T')).halted, true)
})

test('the checkpoint is disposable: deleting it changes nothing', async t => {
  // The log is the record; the projection is a reading. Losing the reading
  // costs one replay, not data.
  const teams = store(t)
  await teams.createTeam('T')
  await teams.appendEvents('T', creationLog())
  const fromLog = await teams.readTeam('T')

  rmSync(join(teams.root, 'T', STATE_FILE))
  assert.deepEqual(await teams.readTeam('T'), fromLog)
  assert.equal(await teams.readCheckpoint('T'), undefined, 'and the checkpoint really was gone')
})

test('the checkpoint is rewritten on every append', async t => {
  const teams = store(t)
  await teams.createTeam('T')
  await teams.appendEvents('T', creationLog())
  assert.equal(JSON.parse(readFileSync(join(teams.root, 'T', STATE_FILE), 'utf8')).name, 'T')
  await teams.appendEvents('T', [teamEvent('team.halted', {}, 1003, 3)])
  assert.equal(JSON.parse(readFileSync(join(teams.root, 'T', STATE_FILE), 'utf8')).halted, true)
})

test('a record carries the directory it was read from, not the name it sanitizes to', async t => {
  // The projection derives an id from the team's name. If that were what a
  // caller wrote back with, a team filed under "T" but named "T" would write
  // its next event into a second, empty directory under "t" — and the original
  // would silently stop being updated.
  const teams = store(t)
  await teams.createTeam('T')
  await teams.appendEvents('T', [
    teamEvent('team.created', { name: 'T', captainSessionId: 's' }, 1, 0),
  ])
  assert.equal((await teams.readTeam('T')).id, 'T')
  assert.equal((await teams.materialize('T')).id, 'T')
})

test('nextSeq follows the log length, so a caller never guesses', async t => {
  const teams = store(t)
  await teams.createTeam('T')
  assert.equal(await teams.nextSeq('T'), 0)
  await teams.appendEvents('T', creationLog())
  assert.equal(await teams.nextSeq('T'), 3)
})

test('a malformed line is reported and skipped, not fatal', async t => {
  const reported = []
  const teams = store(t, { onMalformedLine: (teamId, line, error) => reported.push([teamId, line, error.message]) })
  await teams.createTeam('T')
  await teams.appendEvents('T', creationLog())
  const path = join(teams.root, 'T', EVENTS_FILE)
  writeFileSync(path, `${readFileSync(path, 'utf8')}not json\n`)

  const team = await teams.readTeam('T')
  assert.equal(team.name, 'T', 'the good lines still project')
  assert.equal(reported.length, 1)
  assert.deepEqual(reported[0].slice(0, 2), ['T', 4])
})

test('listing skips the archive and anything hidden', async t => {
  const teams = store(t)
  await teams.createTeam('T')
  await teams.createTeam('U')
  mkdirSync(join(teams.root, ARCHIVE_DIRECTORY), { recursive: true })
  mkdirSync(join(teams.root, '.mid-write'), { recursive: true })
  assert.deepEqual((await teams.listTeamIds()).sort(), ['T', 'U'])
})

test('archiving moves a team out of the live set and into the archive', async t => {
  const teams = store(t)
  await teams.createTeam('T')
  await teams.appendEvents('T', creationLog())
  await teams.archiveTeam('T')

  assert.deepEqual(await teams.listTeamIds(), [])
  assert.deepEqual(await teams.listArchivedTeamIds(), ['T'])
  assert.ok(existsSync(join(teams.root, ARCHIVE_DIRECTORY, 'T', EVENTS_FILE)), 'the history goes with it')
})

test('archiving over an existing archive replaces it rather than merging', async t => {
  const teams = store(t)
  for (const name of ['old', 'new']) {
    await teams.createTeam('T')
    await teams.appendEvents('T', [teamEvent('team.created', { name, captainSessionId: 's' }, 1, 0)])
    await teams.archiveTeam('T')
  }
  const archived = await teams.readTeam(`../${ARCHIVE_DIRECTORY}/T`.replace('..', ''))
  assert.equal(archived.name, 'new', 'the newer archive wins')
})

test('a team that was never written reads as absent, not as empty', async t => {
  // An empty team and a missing one are different answers, and a caller that
  // conflates them will create a second team over the first.
  const teams = store(t)
  assert.equal(await teams.readTeam('ghost'), undefined)
  assert.equal(await teams.hasTeam('ghost'), false)
  assert.deepEqual(await teams.listTeamIds(), [])
  assert.deepEqual(await teams.readTeamEvents('ghost'), [])
})

test('a version this build cannot read is refused rather than guessed at', async t => {
  const teams = store(t)
  await teams.createTeam('T')
  const path = join(teams.root, 'T', MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...manifest, schemaVersion: 99 }))
  await assert.rejects(() => teams.readManifest('T'), /refusing to guess/)
})

test('operations for one team serialize', async t => {
  const teams = store(t)
  await teams.createTeam('T')
  const order = []
  const slow = (label, delay) => teams.withTeamLock('T', async () => {
    order.push(`${label}-start`)
    await new Promise(resolve => setTimeout(resolve, delay))
    order.push(`${label}-end`)
  })
  await Promise.all([slow('a', 10), slow('b', 1)])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'], 'the second waits for the first')
})

test('different teams do not block each other', async t => {
  const teams = store(t)
  await teams.createTeam('T')
  await teams.createTeam('U')
  const order = []
  await Promise.all([
    teams.withTeamLock('T', async () => { order.push('T'); await new Promise(r => setTimeout(r, 10)); order.push('T-end') }),
    teams.withTeamLock('U', async () => { order.push('U'); order.push('U-end') }),
  ])
  assert.deepEqual(order.slice(0, 2), ['T', 'U'], 'U did not wait for T')
})

test('no temp files are left behind', async t => {
  const teams = store(t)
  await teams.createTeam('T')
  await teams.appendEvents('T', creationLog())
  await teams.materialize('T')
  const leftovers = readdirSync(join(teams.root, 'T')).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})
