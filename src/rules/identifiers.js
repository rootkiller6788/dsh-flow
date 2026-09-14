// Team-directory naming. Ported from `dsh-agent-teams/src/state.ts`
// (`sanitizeKey`, `keyDigest`); the digest is `sha256Hex` from `./sha256.js`
// because the pure core cannot import `node:crypto`.
import { sha256Hex } from './sha256.js'

/** Longest key emitted before truncating and appending a digest. */
export const MAX_KEY_LENGTH = 48

/**
 * Short stable digest, used to keep otherwise-colliding keys distinct.
 * The original hashes the **original** name, not the cleaned one, so two names
 * that clean to the same text still diverge.
 * @param name - the raw name.
 * @returns 8 lowercase hex characters.
 */
export function keyDigest(name) {
  return sha256Hex(name).slice(0, 8)
}

/**
 * Fold a free-form name into a safe path/key segment.
 *
 * Unicode letters and digits survive, so CJK/Cyrillic/Greek names stay distinct
 * and readable; everything else — spaces, punctuation, path separators, control
 * characters — folds to `-`. An ASCII-only whitelist mapped *every* non-Latin
 * name onto one shared fallback, which silently merged their mailboxes and
 * rejected the second such member as a duplicate.
 *
 * A name with no letters or digits at all (pure emoji or punctuation) cannot
 * yield a readable key, so it gets a digest rather than a shared constant.
 * Over-long names are truncated with a digest appended, so names sharing a long
 * prefix stay distinct and the result stays within filesystem limits
 * (CJK costs 3 bytes per character in UTF-8).
 *
 * @param name - any user-supplied name.
 * @returns a non-empty key safe as a single path segment.
 */
export function sanitizeKey(name) {
  const cleaned = String(name).normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '') return `k-${keyDigest(name)}`
  // Counted by code point, not UTF-16 unit, so astral characters cost one.
  const points = [...cleaned]
  if (points.length > MAX_KEY_LENGTH) {
    return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`
  }
  return cleaned
}
