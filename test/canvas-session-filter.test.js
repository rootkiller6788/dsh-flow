import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionFamily } from '../src/canvas/html.js'

const threads = [
  { id: 'main', dshSessionId: 'a', parentId: null },
  { id: 'child', dshSessionId: 'b', parentId: 'main' },
  { id: 'grandchild', dshSessionId: 'c', parentId: 'child' },
  { id: 'other', dshSessionId: 'd', parentId: null },
  { id: 'other-child', dshSessionId: 'e', parentId: 'other' },
]
test('one session includes its dispatch descendants, excluding unrelated sessions in the same workspace', () => {
  assert.deepEqual(sessionFamily(threads, 'a').map(item => item.id), ['main', 'child', 'grandchild'])
})
test('opening a child retains its parent dispatch chain', () => {
  assert.deepEqual(sessionFamily(threads, 'c').map(item => item.id), ['main', 'child', 'grandchild'])
})
test('unresolved current session does not leak the workspace', () => {
  assert.deepEqual(sessionFamily(threads, 'missing'), [])
  assert.equal(sessionFamily(threads, 'missing', 'workspace'), threads)
})
test('incomplete and cyclic parent records do not hang or pull unrelated roots', () => {
  const incomplete = [{ id: 'orphan', dshSessionId: 'f', parentId: 'missing' }, ...threads]
  assert.deepEqual(sessionFamily(incomplete, 'f').map(item => item.id), ['orphan'])
  const cyclic = [{ id: 'x', dshSessionId: 'x', parentId: 'y' }, { id: 'y', dshSessionId: 'y', parentId: 'x' }, ...threads]
  assert.deepEqual(sessionFamily(cyclic, 'x').map(item => item.id), ['x', 'y'])
})
