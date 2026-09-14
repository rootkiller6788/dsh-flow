// Contract for the store manifest and its version refusal.
//
// The behaviour under test is a deliberate absence: there is no migration path
// and no coercion, because the host's own convention is to reject an old
// on-disk format rather than guess at it. What must be true is that the refusal
// is loud and that its message says enough to act on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEAM_SCHEMA_VERSION, isTeamManifest, createTeamManifest,
  parseTeamManifest, serializeTeamManifest, peekSchemaVersion,
} from '../src/rules/index.js'

test('a created manifest round-trips', () => {
  const manifest = createTeamManifest('建模手', 1000)
  assert.ok(isTeamManifest(manifest))
  assert.deepEqual(parseTeamManifest(serializeTeamManifest(manifest)), manifest)
})

test('the current version is the one this build writes', () => {
  assert.equal(createTeamManifest('t', 1).schemaVersion, TEAM_SCHEMA_VERSION)
  assert.equal(parseTeamManifest(serializeTeamManifest(createTeamManifest('t', 1))).schemaVersion, TEAM_SCHEMA_VERSION)
})

test('a version this build does not read is refused, naming both numbers', () => {
  // Version 1 is the first version, so there is no older *valid* one to test
  // against — which is exactly why there is no migration table yet. A file from
  // the future is also the more dangerous direction: this build would silently
  // drop whatever it does not understand and write the loss back.
  const raw = JSON.stringify({ schemaVersion: TEAM_SCHEMA_VERSION + 1, teamId: 't', createdAt: 1 })
  assert.throws(() => parseTeamManifest(raw), (error) => {
    assert.match(error.message, new RegExp(`schemaVersion ${TEAM_SCHEMA_VERSION + 1}`))
    assert.match(error.message, new RegExp(`schemaVersion ${TEAM_SCHEMA_VERSION}`))
    assert.match(error.message, /refusing to guess/)
    return true
  })
})

test('a version field that is not a usable number is reported as such, not as a mismatch', () => {
  // An outdated file and a corrupt one need different fixes, so they get
  // different messages.
  for (const schemaVersion of [0, -1, 1.5, '1', null, undefined]) {
    const raw = JSON.stringify({ schemaVersion, teamId: 't', createdAt: 1 })
    assert.throws(() => parseTeamManifest(raw), /no usable schemaVersion/)
  }
})

test('malformed input is refused rather than coerced', () => {
  assert.throws(() => parseTeamManifest('not json'), /not valid JSON/)
  assert.throws(() => parseTeamManifest('{}'), /no usable schemaVersion/)
  assert.throws(() => parseTeamManifest('{"schemaVersion":0,"teamId":"t","createdAt":1}'), /no usable schemaVersion/)
  assert.throws(() => parseTeamManifest('{"schemaVersion":"one","teamId":"t","createdAt":1}'), /no usable schemaVersion/)
  assert.throws(() => parseTeamManifest('{"schemaVersion":1,"teamId":"","createdAt":1}'), /missing teamId or createdAt/)
  assert.throws(() => parseTeamManifest('{"schemaVersion":1,"teamId":"t"}'), /missing teamId or createdAt/)
  assert.throws(() => parseTeamManifest('[]'), /not a JSON object/)
  assert.throws(() => parseTeamManifest('null'), /not a JSON object/)
})

test('a BOM does not defeat the reader', () => {
  const manifest = createTeamManifest('t', 1)
  assert.deepEqual(parseTeamManifest(`\uFEFF${JSON.stringify(manifest)}`), manifest)
})

test('peek reports the version without enforcing it', () => {
  assert.equal(peekSchemaVersion(JSON.stringify({ schemaVersion: 99 })), 99)
  assert.equal(peekSchemaVersion('not json'), undefined)
  assert.equal(peekSchemaVersion('{}'), undefined)
})
