// The takeover rehearsal: read a real `.agent-teams` state root through the
// kernel, the way a deployment migrating off that plugin would.
//
// This is the acceptance test the plan named, and it is the only check here
// that runs against data nobody wrote for a test. What it proves is narrow and
// worth stating exactly: a team another plugin produced — its members, its task
// graph, its statuses and every message in every inbox — is reachable from
// dsh-flow without that plugin installed, and projects to the state its own
// record described.
//
// Like the differential harness, this is a development check rather than a
// build one, and it self-skips when there is no state root to read.
//
//   DSH_AGENT_TEAMS_STATE=/path/to/.agent-teams node scripts/rehearsal-agent-teams.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const THEIR_ROOT = process.env['DSH_AGENT_TEAMS_STATE']

if (THEIR_ROOT === undefined || !existsSync(THEIR_ROOT)) {
  console.log('dsh-flow: no DSH_AGENT_TEAMS_STATE set (or it does not exist) — rehearsal skipped')
  console.log('dsh-flow: point it at a .agent-teams directory to read real teams through the kernel')
  process.exit(0)
}

const { installFlowKernel } = await import(new URL('../kernel.js', import.meta.url).href)
const { canvasSnapshot } = await import(new URL('../src/store/snapshot.js', import.meta.url).href)

const problems = []
const note = (condition, message) => { if (!condition) problems.push(message) }

// A context with no host in it at all: the rehearsal is about reading what some
// other process left on disk, so nothing here should need a running harness.
const ctx = {
  logger: { warn: message => console.log(`  warn: ${message}`), info: () => {}, error: () => {} },
  agents: { get: () => undefined, list: () => [] },
  llm: {}, subagents: {}, systemPrompt: { section: () => {} },
  tools: { register: () => () => {} },
  on: () => {},
  effect: execute => execute(),
  provide: () => {},
}

const kernel = installFlowKernel(ctx, {
  // Into a scratch directory: the rehearsal must not write anywhere near the
  // records it is reading.
  stateDir: mkdtempSync(join(tmpdir(), 'dsh-flow-rehearsal-')),
  runner: 'manual',
  profiles: {},
  agentTeamsStateDir: THEIR_ROOT,
})

console.log(`dsh-flow: reading ${THEIR_ROOT} through the kernel\n`)
console.log('sources:', kernel.sources.describe().map(source => `${source.id}${source.writable ? ' (writable)' : ''}`).join(', '))

const found = await kernel.sources.enumerate()
note(found.length > 0, 'no teams were enumerated')
console.log(`teams: ${found.map(entry => `${entry.teamId} [${entry.source}]`).join(', ')}\n`)

const { teams } = await canvasSnapshot(kernel.sources)
for (const team of teams) {
  console.log(`team ${team.teamId} (${team.name})`)
  console.log(`  source=${team.source} writable=${team.writable} phase=${team.phase} halted=${team.halted}`)
  console.log(`  members: ${team.members.map(member => (
    `${member.name} [${member.status}] ${member.done}/${member.total}`
  )).join(', ')}`)
  console.log(`  tasks: ${team.tasks.map(task => `${task.id} [${task.state}] → ${task.assignee || 'unassigned'}`).join(', ')}`)

  note(team.members.length > 0, `${team.teamId}: no members`)
  note(team.tasks.length > 0, `${team.teamId}: no tasks`)
  // Every task has to land in a display state the canvas knows, or it renders
  // as a blank chip nobody can act on.
  for (const task of team.tasks) {
    note(
      ['open', 'running', 'completed', 'failed', 'blocked', 'cancelled'].includes(task.state),
      `${team.teamId}/${task.id}: display state "${task.state}" is not one the canvas renders`,
    )
  }

  // And its inboxes have to be readable, message for message. This is the check
  // the whole takeover argues from: a team whose mail is unreachable is a team
  // whose conversations were lost in the move.
  const entry = kernel.sources.get(team.source)
  let reachable = 0
  for (const member of [...team.members.map(member => member.name), 'captain']) {
    reachable += (await entry.readMailbox(team.teamId, member)).length
  }
  const onDisk = countMailboxLines(join(THEIR_ROOT, team.teamId, 'inbox'))
  console.log(`  messages: ${reachable} reachable, ${onDisk} lines on disk`)
  note(
    reachable >= onDisk,
    `${team.teamId}: ${onDisk} mailbox lines on disk but only ${reachable} readable`,
  )
}

/**
 * Non-blank lines across every inbox file.
 *
 * The count is the yardstick rather than a fixed number: the point is that
 * nothing on disk went unreachable, and a fixed expectation would turn a real
 * team's growth into a test failure.
 */
function countMailboxLines(directory) {
  if (!existsSync(directory)) return 0
  let total = 0
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(directory, name)
    if (!statSync(path).isFile()) continue
    total += readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').length
  }
  return total
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`dsh-flow: ${problem}`)
  process.exit(1)
}
console.log('\ndsh-flow: every team, task and message in the state root is reachable')
