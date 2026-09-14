// Store manifest: the schema version a team directory was written with.
//
// agent-teams has no version field anywhere — not in `team.json`, not in its
// validators, not in its types. It survives format changes only through
// tolerant read-time coercion, and it drops unknown fields whenever it
// re-serializes. That works until it doesn't, and when it doesn't the failure
// is silent.
//
// This file takes the opposite position, following the host's own stance
// (`AGENTS.md`: "foundation over blast radius", "backends reject old on-disk
// formats"). A version that does not match is refused with a message naming
// both numbers, rather than coerced into something plausible.
//
// There is deliberately **no migration table yet**. Migrations serve released
// formats; there is nothing released here to migrate from. Add one when there
// is a version worth carrying forward, not before.

/**
 * Format version of the team store.
 *
 * Bump on any change a reader of the previous version could not interpret
 * correctly. Purely additive optional fields do not need a bump — an old reader
 * ignores them, and the field-preservation rule below keeps them intact across
 * a rewrite.
 */
export const TEAM_SCHEMA_VERSION = 1

/** Fields a manifest must carry. */
export function isTeamManifest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!Number.isSafeInteger(value['schemaVersion']) || value['schemaVersion'] < 1) return false
  if (typeof value['teamId'] !== 'string' || value['teamId'] === '') return false
  if (typeof value['createdAt'] !== 'number' || !Number.isFinite(value['createdAt'])) return false
  return true
}

/**
 * Build the manifest for a new team directory.
 * @param teamId - the team's sanitized id.
 * @param at - epoch milliseconds.
 */
export function createTeamManifest(teamId, at) {
  return {
    schemaVersion: TEAM_SCHEMA_VERSION,
    teamId,
    createdAt: at,
    createdBy: 'dsh-flow',
  }
}

/**
 * Parse and check a manifest, refusing anything this build cannot read.
 *
 * @param raw - the manifest file's text.
 * @returns the manifest.
 * @throws when the text is not JSON, is not a manifest, or carries a version
 *   this build does not read. The message names the found and expected
 *   versions so the fix is obvious from the error alone.
 */
export function parseTeamManifest(raw) {
  let value
  try {
    value = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
  } catch {
    throw new Error('team manifest is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('team manifest is not a JSON object')
  }
  // Version first, deliberately. A file whose version is wrong is usually a
  // *well-formed* older record, and reporting it as "missing fields" would send
  // the reader looking for a corrupt file instead of an outdated one.
  const { schemaVersion } = value
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`team manifest has no usable schemaVersion (found ${JSON.stringify(schemaVersion)})`)
  }
  if (schemaVersion !== TEAM_SCHEMA_VERSION) {
    throw new Error(
      `team manifest is schemaVersion ${schemaVersion}, `
      + `but this build reads schemaVersion ${TEAM_SCHEMA_VERSION}; `
      + 'refusing to guess at a format it does not know',
    )
  }
  if (!isTeamManifest(value)) {
    throw new Error('team manifest is missing teamId or createdAt')
  }
  return value
}

/** Serialize a manifest as the file body. */
export function serializeTeamManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * The version portion of the store this module owns, or `undefined` when the
 * text is not a manifest. Used where a caller wants the number without the
 * strictness — reporting, not reading.
 */
export function peekSchemaVersion(raw) {
  try {
    const value = JSON.parse(raw)
    return Number.isSafeInteger(value?.schemaVersion) ? value.schemaVersion : undefined
  } catch {
    return undefined
  }
}
