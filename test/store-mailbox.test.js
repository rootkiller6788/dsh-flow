// Contract for the per-member inbox.
//
// The properties that matter here are the ones a fake cannot have: the lease is
// visible to a second reader through the file, the rewrite leaves untouched
// lines byte-for-byte alone, and an appended message survives a crash between
// the write and the rename. So this runs against a real temporary directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMailboxStore, MAIL_DIRECTORY } from '../src/store/mailbox.js'
import { MAILBOX_DELIVERY_LEASE_MS } from '../src/rules/index.js'

let clock = 1000
function inbox(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-flow-mail-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    root,
    mail: createMailboxStore({ teamDir: teamId => join(root, teamId), now: () => clock, ...options }),
    path: (teamId, name) => join(root, teamId, MAIL_DIRECTORY, `${name}.jsonl`),
  }
}

const message = (id, extra = {}) => ({ id, from: 'captain', to: 'a', content: `m${id}`, ts: 1000, ...extra })

test('an inbox that was never written reads as empty, not as an error', async t => {
  const { mail } = inbox(t)
  assert.deepEqual(await mail.readMailbox('T', 'a'), [])
  assert.deepEqual(await mail.readUnreadMailbox('T', 'a'), [])
  assert.deepEqual(await mail.listMailboxes('T'), [])
})

test('messages are appended and read back oldest first', async t => {
  const { mail } = inbox(t)
  await mail.appendMessage('T', 'a', message('m1'))
  await mail.appendMessage('T', 'a', message('m2'))
  assert.deepEqual((await mail.readMailbox('T', 'a')).map(m => m.id), ['m1', 'm2'])
  assert.deepEqual(await mail.listMailboxes('T'), ['a'])
})

test('a leased message is not owed to anyone else', async t => {
  // This is the whole point of the lease: two kicks must not both deliver.
  const { mail } = inbox(t)
  await mail.appendMessage('T', 'a', message('m1'))
  assert.equal((await mail.readUnreadMailbox('T', 'a')).length, 1)

  await mail.claimDelivery('T', 'a', ['m1'])
  assert.deepEqual(await mail.readUnreadMailbox('T', 'a'), [], 'a fresh lease hides it')

  clock += MAILBOX_DELIVERY_LEASE_MS
  assert.equal((await mail.readUnreadMailbox('T', 'a')).length, 1, 'a lapsed lease does not, with no timer involved')
})

test('a released message comes back for the next attempt', async t => {
  const { mail } = inbox(t)
  await mail.appendMessage('T', 'a', message('m1'))
  await mail.claimDelivery('T', 'a', ['m1'])
  await mail.releaseDelivery('T', 'a', ['m1'])
  assert.equal((await mail.readUnreadMailbox('T', 'a')).length, 1)
  assert.equal((await mail.readMailbox('T', 'a'))[0].deliveryClaimedAt, undefined, 'released, not zeroed')
})

test('acknowledging records the first time and keeps it', async t => {
  const { mail } = inbox(t)
  await mail.appendMessage('T', 'a', message('m1'))
  await mail.claimDelivery('T', 'a', ['m1'])
  await mail.acknowledgeDelivery('T', 'a', ['m1'])
  const first = (await mail.readMailbox('T', 'a'))[0]
  assert.equal(first.readAt, clock)
  assert.equal(first.deliveredAt, clock)
  assert.equal(first.deliveryClaimedAt, undefined)

  clock += 500
  await mail.acknowledgeDelivery('T', 'a', ['m1'])
  assert.equal((await mail.readMailbox('T', 'a'))[0].readAt, first.readAt, 'a second ack does not move the clock')
  assert.deepEqual(await mail.readUnreadMailbox('T', 'a'), [])
})

test('a rewrite leaves every other line exactly as it was', async t => {
  // The file is the durable record. A rewrite that reformatted the lines it was
  // not asked about would make every delivery a whole-file diff.
  const { mail, path } = inbox(t)
  await mail.appendMessage('T', 'a', message('m1'))
  await mail.appendMessage('T', 'a', message('m2'))
  const before = readFileSync(path('T', 'a'), 'utf8').split('\n')

  await mail.claimDelivery('T', 'a', ['m2'])
  const after = readFileSync(path('T', 'a'), 'utf8').split('\n')
  assert.equal(after[0], before[0], 'the untouched line is byte-identical')
  assert.notEqual(after[1], before[1])
})

test('a hand-damaged line is reported and left alone, not dropped', async t => {
  const reported = []
  const { mail, path } = inbox(t, {
    onMalformedLine: (teamId, memberName, line, error) => reported.push([teamId, memberName, line, error.message]),
  })
  await mail.appendMessage('T', 'a', message('m1'))
  writeFileSync(path('T', 'a'), `not json\n${readFileSync(path('T', 'a'), 'utf8')}`)

  assert.deepEqual((await mail.readMailbox('T', 'a')).map(m => m.id), ['m1'])
  assert.deepEqual(reported, [['T', 'a', 1, 'invalid JSON']])

  await mail.claimDelivery('T', 'a', ['m1'])
  assert.equal(readFileSync(path('T', 'a'), 'utf8').startsWith('not json\n'), true, 'the damaged line survived the rewrite')
})

test('two names that clean to nothing still get one inbox each', async t => {
  // The failure this guards against is the one that made the ASCII-only
  // whitelist wrong: a shared fallback key silently merges two members' mail.
  const { mail, root } = inbox(t)
  await mail.appendMessage('T', '🚀', message('m1'))
  await mail.appendMessage('T', '🎯', message('m2'))
  assert.deepEqual((await mail.readMailbox('T', '🚀')).map(m => m.id), ['m1'])
  assert.deepEqual((await mail.readMailbox('T', '🎯')).map(m => m.id), ['m2'])
  assert.equal(readdirSync(join(root, 'T', MAIL_DIRECTORY)).length, 2)
})

test('a name that needs folding is folded to one file per member', async t => {
  const { mail, root } = inbox(t)
  await mail.appendMessage('T', '建模 手', message('m1'))
  await mail.appendMessage('T', '建模 手', message('m2'))
  assert.deepEqual((await mail.readMailbox('T', '建模 手')).map(m => m.id), ['m1', 'm2'])
  assert.deepEqual(readdirSync(join(root, 'T', MAIL_DIRECTORY)), ['建模-手.jsonl'])
})

test('no temp files are left behind', async t => {
  const { mail, root } = inbox(t)
  await mail.appendMessage('T', 'a', message('m1'))
  await mail.claimDelivery('T', 'a', ['m1'])
  await mail.releaseDelivery('T', 'a', ['m1'])
  assert.deepEqual(readdirSync(join(root, 'T', MAIL_DIRECTORY)).filter(name => name.endsWith('.tmp')), [])
})

test('a claim for an id that is not there is a no-op, not an error', async t => {
  // The caller usually holds a snapshot that may already be stale.
  const { mail } = inbox(t)
  await mail.appendMessage('T', 'a', message('m1'))
  await mail.claimDelivery('T', 'a', ['ghost'])
  assert.equal((await mail.readMailbox('T', 'a'))[0].deliveryClaimedAt, undefined)
})

test('an empty id list does not even open the file', async t => {
  const { mail, root } = inbox(t)
  mkdirSync(join(root, 'T'), { recursive: true })
  await mail.claimDelivery('T', 'nobody', [])
  assert.deepEqual(readdirSync(join(root, 'T')), [])
})
