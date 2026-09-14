// Contract for the retired-member deny-list, its guard, and archiving.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RETIRED_MEMBERS_FILE, parseRetiredMemberIds, serializeRetiredMemberIds,
  mergeRetiredMemberIds, isRetiredMember,
} from '../src/rules/index.js'
import { installRetiredMemberGuard } from '../src/runner/retired-guard.js'
import { archiveTeamDir, listArchivedTeamIds, ARCHIVE_DIR } from '../src/runner/archive.js'
import { createFakeHost } from './support/fake-host.js'

class NotResumableError extends Error {
  constructor(message, code) { super(message); this.code = code }
}

// --- the deny-list --------------------------------------------------------

test('the deny-list file has one name', () => {
  assert.equal(RETIRED_MEMBERS_FILE, 'retired-members.json')
  assert.equal(ARCHIVE_DIR, 'archive')
})

test('a valid deny-list parses, including through a BOM', () => {
  assert.deepEqual([...parseRetiredMemberIds('["a","b"]')], ['a', 'b'])
  assert.deepEqual([...parseRetiredMemberIds('﻿["a"]')], ['a'])
  assert.equal(parseRetiredMemberIds('[]').size, 0)
})

test('a garbled deny-list throws rather than protecting nothing', () => {
  // A guard that silently matches nothing is worse than one that refuses to
  // load: the caller can recover from a throw, not from an unnoticed empty set.
  for (const raw of ['not json', '{}', '[""]', '[1]', '["a",null]', 'null', '"a"']) {
    assert.throws(() => parseRetiredMemberIds(raw), /invalid dsh-flow retired member index/, JSON.stringify(raw))
  }
})

test('the file is written in one stable, sorted form', () => {
  assert.equal(serializeRetiredMemberIds(['b', 'a', 'c']), '[\n  "a",\n  "b",\n  "c"\n]\n')
  assert.equal(serializeRetiredMemberIds([]), '[]\n')
})

test('merging drops empty ids and reports whether anything changed', () => {
  // An unspawned member has no session to retire, and `""` in the list would
  // match every caller that asks with a missing id.
  assert.deepEqual(mergeRetiredMemberIds(['a'], ['', 'a']), { ids: new Set(['a']), changed: false })
  const merged = mergeRetiredMemberIds(['a'], ['', 'b'])
  assert.equal(merged.changed, true)
  assert.deepEqual([...merged.ids].sort(), ['a', 'b'])
  assert.equal(mergeRetiredMemberIds([], []).changed, false)
})

test('membership is by session id', () => {
  assert.equal(isRetiredMember(new Set(['x']), 'x'), true)
  assert.equal(isRetiredMember(new Set(['x']), 'y'), false)
})

// --- the guard ------------------------------------------------------------

function guarded({ retired = new Set(), throws } = {}) {
  const host = createFakeHost({ subagents: { followup: async () => 'delivered' } })
  installRetiredMemberGuard(host.ctx, {
    isRetired: async () => { if (throws === true) throw new Error('deny-list unreadable'); return retired.has('child-1') },
    errorType: NotResumableError,
  })
  return host
}

test('a retired target is refused before delivery', async () => {
  const host = guarded({ retired: new Set(['child-1']) })
  await assert.rejects(
    () => host.ctx.subagents.followup({ id: 'p' }, 'child-1', [], {}),
    error => {
      assert.ok(error instanceof NotResumableError)
      assert.equal(error.code, 'NOT_RESUMABLE')
      assert.ok(!error.message.includes('undefined'), 'the message names the target, not an undefined')
      return true
    },
  )
})

test('a live target is delivered normally and sees unchanged arguments', async () => {
  const host = guarded()
  const result = await host.ctx.subagents.followup({ id: 'p' }, 'child-2', ['c'], { source: 's' })
  assert.equal(result, 'delivered')
})

test('an unreadable deny-list does not block delivery', async () => {
  // Blocking here would strand every delivery behind an unrelated problem, and
  // the durable state check inside the service still refuses a retired member.
  const host = guarded({ throws: true })
  assert.equal(await host.ctx.subagents.followup({ id: 'p' }, 'child-1', [], {}), 'delivered')
})

test('unloading restores the original method, and only its own change', async () => {
  const host = createFakeHost({ subagents: { followup: async () => 'original' } })
  const original = host.ctx.subagents.followup
  installRetiredMemberGuard(host.ctx, { isRetired: async () => false, errorType: NotResumableError })
  assert.notEqual(host.ctx.subagents.followup, original)

  await host.disposeAll()
  assert.equal(host.ctx.subagents.followup, original)
})

test('a foreign replacement installed after us is left alone', async () => {
  // Cordis hands out fresh Proxies on method reads, so restoring blindly could
  // clobber whoever installed after us.
  const host = createFakeHost({ subagents: { followup: async () => 'original' } })
  installRetiredMemberGuard(host.ctx, { isRetired: async () => false, errorType: NotResumableError })
  const foreign = async () => 'someone else'
  host.ctx.subagents.followup = foreign

  await host.disposeAll()
  assert.equal(host.ctx.subagents.followup, foreign, 'the later install owns the property now')
})

test('a deployment with no delivery entry point is simply not guarded', () => {
  const host = createFakeHost({ subagents: {} })
  installRetiredMemberGuard(host.ctx, { isRetired: async () => true, errorType: NotResumableError })
  assert.equal(host.ctx.subagents.followup, undefined)
})

// --- archiving ------------------------------------------------------------

function fakeIo(initial = [], failures = {}) {
  const entries = new Set(initial)
  const moves = []
  return {
    entries,
    moves,
    async exists(path) { return entries.has(path) },
    async move(from, to) {
      if (failures.move !== undefined && failures.move(from, to)) throw new Error('move failed')
      entries.delete(from)
      entries.add(to)
      moves.push([from, to])
    },
    async remove(path) { entries.delete(path) },
  }
}

test('archiving moves the team under archive/', async () => {
  const io = fakeIo(['/root/T', '/root/archive'])
  await archiveTeamDir(io, '/root', 'T', 'n1')
  assert.ok(io.entries.has('/root/archive/T'))
  assert.ok(!io.entries.has('/root/T'))
})

test('an existing archive is displaced, then cleaned up', async () => {
  const io = fakeIo(['/root/T', '/root/archive/T'])
  await archiveTeamDir(io, '/root', 'T', 'n1')
  assert.ok(io.entries.has('/root/archive/T'), 'the new archive is in place')
  assert.ok(!io.entries.has('/root/archive/.T.previous-n1'), 'and the displaced copy is gone')
})

test('a failed move puts the displaced archive back', async () => {
  // Both halves would otherwise be lost: the old archive displaced and the new
  // one never landed.
  const io = fakeIo(['/root/T', '/root/archive/T'], { move: from => from === '/root/T' })
  await assert.rejects(() => archiveTeamDir(io, '/root', 'T', 'n1'), /move failed/)
  assert.ok(io.entries.has('/root/archive/T'), 'the earlier archive is restored')
  assert.ok(io.entries.has('/root/T'), 'and the team is still where it was')
})

test('archived listings skip the displaced copies', () => {
  // Those are mid-protocol names, not teams; offering one to a user would show
  // a half-archived team the next archive is about to overwrite.
  const entries = [
    { name: 'T', isDirectory: () => true },
    { name: '.T.previous-n1', isDirectory: () => true },
    { name: 'loose.txt', isDirectory: () => false },
    { name: 'U', isDirectory: () => true },
  ]
  assert.deepEqual(listArchivedTeamIds(entries), ['T', 'U'])
})
