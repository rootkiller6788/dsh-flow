// Differential test: every pure rule ported into `src/rules/` is compared
// against the TypeScript original in a sibling checkout of dsh-agent-teams.
//
// The original is imported directly — Node 24 strips types natively — and it is
// the reference that matters, because our on-disk format is deliberately
// wire-compatible with its files. The sibling checkout is a development
// dependency, not a build one, so a clone without it self-skips (the shape DSH
// uses for its own key-gated e2e tests).
//
// Usage:
//   node scripts/diff-agent-teams.mjs
//   DSH_AGENT_TEAMS_DIR=/path/to/checkout node scripts/diff-agent-teams.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORIGINAL = process.env['DSH_AGENT_TEAMS_DIR'] ?? join(root, '..', 'dsh-agent-teams')

if (!existsSync(join(ORIGINAL, 'src', 'state.ts'))) {
  console.log(`dsh-flow: no dsh-agent-teams checkout at ${ORIGINAL} — differential test skipped`)
  process.exit(0)
}

const load = async name => import(pathToFileURL(join(ORIGINAL, 'src', name)).href)
const state = await load('state.ts')
const types = await load('types.ts')
const gates = await load('quality-gates.ts')
const profiles = await load('profiles.ts')
const ours = await import(pathToFileURL(join(root, 'src', 'rules', 'index.js')).href)

let checks = 0
let failures = 0

const clone = value => JSON.parse(JSON.stringify(value))
const show = value => value === undefined ? 'undefined' : JSON.stringify(value)

function same(label, expected, actual) {
  checks++
  const left = show(expected)
  const right = show(actual)
  if (left === right) { console.log(`ok    ${label}`); return }
  failures++
  const at = [...left].findIndex((character, index) => character !== right[index])
  console.error(`FAIL  ${label}`)
  console.error(`      original: ${left.slice(Math.max(0, at - 40), at + 80)}`)
  console.error(`      ours    : ${right.slice(Math.max(0, at - 40), at + 80)}`)
}

function differ(label, detail) {
  checks++
  failures++
  console.error(`FAIL  ${label}\n      ${detail}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-flow-diff-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

function writeTeam(record) {
  const dir = join(scratch, record.id || 'unnamed')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'team.json'), JSON.stringify(record))
  return dir
}

/** The real 4-member team measured during the audit, when it is on this machine. */
function realTeam() {
  const path = process.env['DSH_FLOW_DIFF_TEAM'] ?? join(
    process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.',
    'Desktop', 'projects', 'fixture', '.agent-teams', 'fixture-team', 'team.json',
  )
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}


// ---------------------------------------------------------------------------
// Constants and the transition table
// ---------------------------------------------------------------------------
for (const [label, a, b] of [
  ['TERMINAL_TASK_STATUSES', types.TERMINAL_TASK_STATUSES, ours.TERMINAL_TASK_STATUSES],
  ['TASK_KINDS', types.TASK_KINDS, ours.TASK_KINDS],
  ['REVIEW_VERDICTS', types.REVIEW_VERDICTS, ours.REVIEW_VERDICTS],
  ['FINDING_SEVERITIES', types.FINDING_SEVERITIES, ours.FINDING_SEVERITIES],
  ['CAPTAIN_KEY', state.CAPTAIN_KEY, ours.CAPTAIN_KEY],
  ['TASK_TRANSITIONS', state.TASK_TRANSITIONS, ours.TASK_TRANSITIONS],
]) same(label, a, b)

{
  let mismatches = 0
  for (const from of ours.TASK_STATUS) {
    for (const to of ours.TASK_STATUS) {
      if (state.transitionError(from, to) !== ours.transitionError(from, to)) mismatches++
    }
  }
  const pairs = ours.TASK_STATUS.length ** 2
  if (mismatches === 0) console.log(`ok    transitionError over all ${pairs} status pairs`)
  else differ('transitionError', `${mismatches} of ${pairs} pairs disagree`)
  checks++
}


// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------
{
  const names = [
    '建模手', '程序员', '论文手', '资料员', 'captain', 'CAPTAIN', '  spaced  ', '--dashes--',
    'a b  c', 'x'.repeat(47), 'x'.repeat(48), 'x'.repeat(49), '建'.repeat(48), '建'.repeat(49),
    '🎉🎉', '!!!', '', '   ', 'Ünïcödé', 'Ελληνικά', 'Кириллица', 'a/b\\c', 'nul\u0000byte',
    'café', 'café', '👨‍👩‍👧', '混合 Mixed 123', '.hidden', '..', 'a'.repeat(200),
  ]
  let mismatches = 0
  for (const name of names) {
    let expected, actual
    try { expected = state.sanitizeKey(name) } catch (error) { expected = `THREW:${error.constructor.name}` }
    try { actual = ours.sanitizeKey(name) } catch (error) { actual = `THREW:${error.constructor.name}` }
    if (expected !== actual) { mismatches++; console.error(`FAIL  sanitizeKey(${JSON.stringify(name)}) ${expected} vs ${actual}`) }
  }
  if (mismatches === 0) console.log(`ok    sanitizeKey over ${names.length} names (NFC/NFD, emoji, over-long, path characters)`)
  else failures++
  checks++
}


// ---------------------------------------------------------------------------
// Entity validation and read-time coercion
// ---------------------------------------------------------------------------
{
  const real = realTeam()
  if (real === undefined) {
    console.log('ok    coerceTeamState skipped — no real team.json on this machine')
  } else {
    // readTeamSync throws where coerceTeamState returns undefined; both mean
    // "not a usable record", so compare the verdict and, when both accept, the
    // coerced record field for field.
    const verdictOf = record => {
      writeTeam(record)
      try { return { valid: true, value: state.readTeamSync(scratch, record.id) } }
      catch { return { valid: false } }
    }
    const mineOf = record => {
      const value = ours.coerceTeamState(clone(record), record.id)
      return value === undefined ? { valid: false } : { valid: true, value }
    }

    const cases = [['baseline', real]]
    const mutate = (label, apply) => { const record = clone(real); apply(record); cases.push([label, record]) }
    mutate('name blank', r => { r.name = '' })
    mutate('captainSessionId blank', r => { r.captainSessionId = '' })
    mutate('taskSeq negative', r => { r.taskSeq = -1 })
    mutate('taskSeq fractional', r => { r.taskSeq = 1.5 })
    mutate('phase unknown', r => { r.phase = 'bogus' })
    mutate('task.status unknown', r => { r.tasks[0].status = 'bogus' })
    mutate('task.id blank', r => { r.tasks[0].id = '' })
    mutate('task.id duplicate', r => { r.tasks[1].id = r.tasks[0].id })
    mutate('member named captain', r => { r.members[0].name = 'captain' })
    mutate('member name duplicate', r => { r.members[1].name = r.members[0].name })
    mutate('member names collide after sanitizeKey', r => { r.members[1].name = `${r.members[0].name.toUpperCase()}!!` })
    mutate('member.status unknown', r => { r.members[0].status = 'bogus' })
    mutate('joinedAt NaN', r => { r.members[0].joinedAt = NaN })
    mutate('dependencies not an array', r => { r.tasks[0].dependencies = 'x' })
    mutate('dependencies not strings', r => { r.tasks[0].dependencies = [1] })
    mutate('profile legacy string', r => { r.profile = 'legacy' })
    mutate('profile invalid record', r => { r.profile = { bogus: 1 } })
    mutate('objective blank (model dirt)', r => { r.tasks[0].objective = '' })
    mutate('acceptance with blanks', r => { r.tasks[0].acceptance = ['', 'ok', '  '] })
    mutate('kind unknown', r => { r.tasks[0].kind = 'bogus' })
    mutate('id mismatch', r => { r.id = 'wrong-id' })
    mutate('tasks missing', r => { delete r.tasks })
    mutate('members missing', r => { delete r.members })
    mutate('running member with blank id', r => { r.members[0].id = '' })
    mutate('staged member with blank id (legal)', r => { r.phase = 'staged'; r.members[0].id = '' })
    mutate('reviewPolicy min > max', r => { r.reviewPolicy = { requirementsMinRounds: 5, requirementsMaxRounds: 2 } })
    mutate('reviewPolicy unknown key', r => { r.reviewPolicy = { bogusKey: 1 } })
    mutate('findings duplicate id', r => { r.tasks[0].findings = [{ id: 'A', severity: 'low', problem: 'p', requiredFix: 'f' }, { id: 'A', severity: 'high', problem: 'q', requiredFix: 'g' }] })
    mutate('finding severity unknown', r => { r.tasks[0].findings = [{ id: 'A', severity: 'nope', problem: 'p', requiredFix: 'f' }] })
    mutate('attempt negative', r => { r.tasks[0].attempt = -1 })
    mutate('escalated not boolean', r => { r.escalated = 'yes' })
    mutate('profileSeedId blank', r => { r.tasks[0].profileSeedId = '' })
    mutate('deliverables with blanks', r => { r.tasks[0].deliverables = ['ok', ''] })
    mutate('inScope all blanks', r => { r.tasks[0].inScope = ['', '  '] })
    mutate('reviewedTaskId blank', r => { r.tasks[0].reviewedTaskId = '' })

    let verdictDiff = 0
    let valueDiff = 0
    let accepted = 0
    for (const [label, record] of cases) {
      const expected = verdictOf(record)
      const actual = mineOf(record)
      if (expected.valid !== actual.valid) {
        differ(`coerceTeamState verdict [${label}]`, `original valid=${expected.valid}, ours valid=${actual.valid}`)
        verdictDiff++
        continue
      }
      if (!expected.valid) continue
      accepted++
      const left = JSON.stringify(expected.value)
      const right = JSON.stringify(actual.value)
      if (left !== right) {
        valueDiff++
        differ(`coerceTeamState value [${label}]`, `original ${left.slice(0, 180)}\n      ours     ${right.slice(0, 180)}`)
      }
    }
    if (verdictDiff === 0 && valueDiff === 0) {
      console.log(`ok    coerceTeamState over ${cases.length} records (${accepted} accepted) from a real team.json`)
      checks++
    }
  }
}


console.log(failures === 0
  ? `\ndsh-flow: ${checks} differential checks agree with dsh-agent-teams`
  : `\ndsh-flow: ${failures} of ${checks} differential checks disagree`)
process.exit(failures === 0 ? 0 : 1)
