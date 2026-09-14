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


// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------
{
  const task = (id, status, dependencies = []) => ({ id, status, dependencies })
  const graphs = [
    ['real team tasks', realTeam()?.tasks],
    ['empty', []],
    ['chain', [task('t1', 'completed'), task('t2', 'pending', ['t1']), task('t3', 'pending', ['t2'])]],
    ['diamond', [task('a', 'completed'), task('b', 'pending', ['a']), task('c', 'pending', ['a']), task('d', 'pending', ['b', 'c'])]],
    ['missing dependency', [task('a', 'pending', ['ghost'])]],
    ['self cycle', [task('a', 'pending', ['a'])]],
    ['two cycle', [task('a', 'pending', ['b']), task('b', 'pending', ['a'])]],
    ['three cycle', [task('a', 'pending', ['b']), task('b', 'pending', ['c']), task('c', 'pending', ['a'])]],
    ['cycle plus tail', [task('a', 'pending', ['b']), task('b', 'pending', ['a']), task('c', 'pending', ['a'])]],
    ['duplicate dependency', [task('a', 'completed'), task('b', 'pending', ['a', 'a'])]],
    ['unfinished dependency', [task('a', 'in_progress'), task('b', 'pending', ['a'])]],
    ['failed dependency blocks', [task('a', 'failed'), task('b', 'pending', ['a'])]],
  ].filter(([, tasks]) => tasks !== undefined)

  let mismatches = 0
  for (const [label, tasks] of graphs) {
    const left = [...state.taskDepthsById(tasks)].sort()
    const right = [...ours.taskDepthsById(tasks)].sort()
    if (show(left) !== show(right)) { mismatches++; console.error(`FAIL  taskDepthsById [${label}] ${show(left)} vs ${show(right)}`) }
    for (const item of tasks) {
      const a = state.unsatisfiedDependencies(tasks, item.dependencies)
      const b = ours.unsatisfiedDependencies(tasks, item.dependencies)
      if (show(a) !== show(b)) { mismatches++; console.error(`FAIL  unsatisfiedDependencies [${label}/${item.id}] ${show(a)} vs ${show(b)}`) }
      for (const status of ours.TASK_STATUS) {
        const x = state.taskVisualState(status, item.dependencies, tasks)
        const y = ours.taskVisualState(status, item.dependencies, tasks)
        if (x !== y) { mismatches++; console.error(`FAIL  taskVisualState [${label}/${item.id}/${status}] ${x} vs ${y}`) }
      }
    }
  }
  if (mismatches === 0) console.log(`ok    dependency graph over ${graphs.length} graphs × 6 statuses (chains, diamonds, cycles, dangling ids, failures)`)
  else failures++
  checks++
}

// ---------------------------------------------------------------------------
// Mailbox: the delivery lease
// ---------------------------------------------------------------------------
// The original reads the clock itself, so a case sitting exactly on the lease
// boundary would flip on a millisecond of drift and prove nothing. Cases are
// chosen far from that boundary and compared against the original through its
// own IO entry point; the boundary itself is asserted against the rule.
{
  const live = Date.now()
  const message = (id, extra = {}) => ({ id, from: 'captain', to: '建模手', content: `c-${id}`, ts: live - 1000, ...extra })

  const boxes = {
    'all unread': [message('m1'), message('m2'), message('m3')],
    'one read': [message('m1'), message('m2', { readAt: live - 10 }), message('m3')],
    'fresh lease holds': [message('m1', { deliveryClaimedAt: live - 1000 }), message('m2')],
    'stale lease expired': [message('m1', { deliveryClaimedAt: live - 120_000 })],
    'claimed and read': [message('m1', { deliveryClaimedAt: live - 5000, readAt: live - 4000 })],
    'delivered but unread': [message('m1', { deliveredAt: live - 4000 })],
    'empty': [],
  }

  const root = join(scratch, 'inbox')
  let mismatches = 0
  for (const [label, messages] of Object.entries(boxes)) {
    const dir = join(root, 't', 'inbox')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'captain.jsonl'), `${messages.map(m => JSON.stringify(m)).join('\n')}\n`)
    const expected = (await state.readUnreadMailbox(root, 't', 'captain')).map(m => m.id)
    const actual = ours.unreadMessages(messages, Date.now()).map(m => m.id)
    if (show(expected) !== show(actual)) { mismatches++; console.error(`FAIL  unread [${label}] ${show(expected)} vs ${show(actual)}`) }
  }

  // The boundary the original cannot be asked about without racing its clock.
  const LEASE = ours.MAILBOX_DELIVERY_LEASE_MS
  const at = boundary => ours.unreadMessages([message('m', { deliveryClaimedAt: boundary })], live).length === 1
  // Exactly at the lease the message becomes unread again; one millisecond
  // younger it is still held, one millisecond older it is already released.
  const boundaryHolds = at(live - LEASE) && !at(live - LEASE + 1) && at(live - LEASE - 1)
  if (mismatches === 0 && boundaryHolds) {
    console.log(`ok    unread lease over ${Object.keys(boxes).length} mailboxes, plus the exact ${LEASE}ms boundary`)
  } else {
    if (!boundaryHolds) differ('lease boundary', `expected unread at exactly ${LEASE}ms elapsed and not before`)
    failures++
  }
  checks++
}

// ---------------------------------------------------------------------------
// Mailbox: the line-preserving rewrite
// ---------------------------------------------------------------------------
// Run the original's own mutators against a real file, then compare the file it
// wrote with what our pure transform produces from the same input. Timestamps
// minted inside the original are normalised on both sides.
{
  const live = Date.now()
  const message = (id, extra = {}) => ({ id, from: 'captain', to: '建模手', content: `c-${id}`, ts: live - 1000, ...extra })
  const rawBox = [
    JSON.stringify(message('m1')),
    'not json at all',
    JSON.stringify(message('m2', { readAt: live - 100 })),
    '',
    JSON.stringify(message('m3', { deliveryClaimedAt: live - 500 })),
    '{"id":"m4"',
  ].join('\n')

  const normalise = text => text.replace(/\b17\d{11}\b/g, 'TS-NOW')
  const results = []

  const run = async (label, ids, original, mutator) => {
    const dir = join(scratch, 'rw', label, 'inbox')
    rmSync(join(scratch, 'rw', label), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'captain.jsonl'), rawBox)
    await original(join(scratch, 'rw'), label, 'captain', ids)
    const theirs = normalise(readFileSync(join(dir, 'captain.jsonl'), 'utf8'))
    const mine = normalise(ours.mutateMailboxLines(rawBox, ids, mutator))
    results.push([label, theirs, mine])
  }

  await run('claim', ['m1', 'm3'], state.claimMailboxDelivery, m => ours.claimDelivery(m, live))
  await run('release', ['m3'], state.releaseMailboxDelivery, m => ours.releaseDelivery(m))
  await run('ack', ['m1'], state.acknowledgeMailbox, m => ours.acknowledgeDelivery(m, live))
  await run('no ids', [], state.claimMailboxDelivery, m => ours.claimDelivery(m, live))
  await run('unknown id', ['nope'], state.claimMailboxDelivery, m => ours.claimDelivery(m, live))

  let mismatches = 0
  for (const [label, theirs, mine] of results) {
    if (theirs !== mine) {
      mismatches++
      differ(`mailbox rewrite [${label}]`, `original ${JSON.stringify(theirs).slice(0, 170)}\n      ours     ${JSON.stringify(mine).slice(0, 170)}`)
    }
  }
  if (mismatches === 0) {
    console.log(`ok    mailbox rewrite over ${results.length} mutations (malformed and unselected lines survive verbatim)`)
    checks++
  }
}

// ---------------------------------------------------------------------------
// Workspace path scope
// ---------------------------------------------------------------------------
{
  const paths = [
    'src/a.js', 'src/deep/b.js', './src/a.js', 'src//a.js', 'src/./a.js', 'src\\a.js',
    '  src/a.js  ', '', '   ', '.', './', '/abs/path', '~/home', 'C:/drive', 'c:\\drive',
    '../escape', 'src/../../etc/passwd', '.git/config', '.dsh/state', 'app/.env', '.env.local',
    'config/secrets/key.txt', 'id_rsa', 'id_rsa.pub', 'secrets', 'a/b/secrets/c',
    'src/', 'src', '.hidden/file', '中文/文件.js', 'a b/c d.js',
  ]
  const patterns = ['.', './', 'src', 'src/', 'src/a.js', './src', 'src/deep/', '', '   ', '/abs', '~', 'C:/x', '../up', 'a/b/secrets/c', '.env']

  let mismatches = 0
  const mismatch = (label, a, b) => { mismatches++; console.error(`FAIL  ${label} ${show(a)} vs ${show(b)}`) }

  for (const path of paths) {
    if (show(gates.normalizeWorkspacePath(path)) !== show(ours.normalizeWorkspacePath(path))) {
      mismatch(`normalizeWorkspacePath(${JSON.stringify(path)})`, gates.normalizeWorkspacePath(path), ours.normalizeWorkspacePath(path))
    }
    for (const pattern of patterns) {
      if (gates.pathMatchesScope(path, pattern) !== ours.pathMatchesScope(path, pattern)) {
        mismatch(`pathMatchesScope(${JSON.stringify(path)}, ${JSON.stringify(pattern)})`, gates.pathMatchesScope(path, pattern), ours.pathMatchesScope(path, pattern))
      }
    }
  }

  const scopes = [[], ['src/'], ['src/a.js'], ['.'], ['.env'], ['secrets']]
  for (const path of paths) {
    for (const inScope of scopes) {
      for (const outOfScope of scopes) {
        const a = gates.classifyChangedPath(path, inScope, outOfScope)
        const b = ours.classifyChangedPath(path, inScope, outOfScope)
        if (a !== b) mismatch(`classifyChangedPath(${JSON.stringify(path)}, ${show(inScope)}, ${show(outOfScope)})`, a, b)
      }
    }
  }

  const statuses = [
    ' M src/a.js',
    'M  src/b.js\nA  src/c.js',
    '?? new.txt',
    'R  old.js -> src/new.js',
    ' D gone.js',
    'MM both.js',
    'UU conflict.js',
    ' M "quoted name.js"',
    ' M ../outside.js',
    ' M C:/abs.js',
    ' M src/a.js\n M src/a.js',
    '', '   ', '\n\n', 'garbage line without status', ' M .env',
  ]
  for (const text of statuses) {
    if (show(gates.collectChangedPaths(text)) !== show(ours.collectChangedPaths(text))) {
      mismatch(`collectChangedPaths(${JSON.stringify(text).slice(0, 40)})`, gates.collectChangedPaths(text), ours.collectChangedPaths(text))
    }
  }

  const overlapCases = [
    [['src/'], ['src/a.js']], [['src/a.js'], ['src/']], [['src/'], ['lib/']],
    [['.'], ['src/a.js']], [[], ['src/']], [undefined, ['src/']], [['src/'], undefined],
    [['a', 'b'], ['b', 'c']],
  ]
  for (const [left, right] of overlapCases) {
    if (show(gates.inScopeOverlap(left, right)) !== show(ours.inScopeOverlap(left, right))) {
      mismatch(`inScopeOverlap(${show(left)}, ${show(right)})`, gates.inScopeOverlap(left, right), ours.inScopeOverlap(left, right))
    }
  }

  if (mismatches === 0) {
    console.log(`ok    path scope over ${paths.length} paths × ${patterns.length} patterns, ${paths.length * scopes.length ** 2} classifications, ${statuses.length} git-status blobs`)
    checks++
  }
}

console.log(failures === 0
  ? `\ndsh-flow: ${checks} differential checks agree with dsh-agent-teams`
  : `\ndsh-flow: ${failures} of ${checks} differential checks disagree`)
process.exit(failures === 0 ? 0 : 1)
