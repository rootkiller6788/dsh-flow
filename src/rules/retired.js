// The durable deny-list of member sessions that must never be resumed.
//
// Ported from `dsh-agent-teams/src/state.ts` (`parseRetiredMemberIds`,
// `recordRetiredMemberIds`). The file itself is read and written by the store;
// what lives here is the shape of the list and the merge rule, because the
// failure this prevents is subtle: a removed member's child session still
// exists in the host, and anything that resumes it re-enters a team that has
// already let it go.

/** The deny-list file's name, relative to the state root. */
export const RETIRED_MEMBERS_FILE = 'retired-members.json'

/**
 * Parse the deny-list.
 *
 * Strict on purpose. A garbled list means the guard cannot be trusted, and a
 * guard that silently protects nothing is worse than one that refuses to load —
 * the caller can recover from a throw, but not from an unnoticed empty set.
 *
 * @param raw - the file's text.
 * @returns the retired session ids.
 * @throws when the text is not a list of non-empty strings.
 */
export function parseRetiredMemberIds(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw)
  } catch {
    throw new Error('invalid dsh-flow retired member index: not valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || value === '')) {
    throw new Error('invalid dsh-flow retired member index: expected a list of non-empty session ids')
  }
  return new Set(parsed)
}

/** Serialize the deny-list, sorted, so the file has one stable form. */
export function serializeRetiredMemberIds(ids) {
  return `${JSON.stringify([...ids].sort(), null, 2)}\n`
}

/**
 * Merge new ids into the list.
 *
 * Empty ids are dropped rather than stored: an unspawned member has no session
 * to retire, and recording `""` would make the deny-list match everything that
 * asks with a missing id.
 *
 * @param existing - the ids already recorded.
 * @param additions - the ids to add.
 * @returns `{ ids, changed }` — `changed` false when nothing new arrived, which
 *   lets a caller skip the write.
 */
export function mergeRetiredMemberIds(existing, additions) {
  const ids = new Set(existing)
  let changed = false
  for (const id of additions) {
    if (id === '' || ids.has(id)) continue
    ids.add(id)
    changed = true
  }
  return { ids, changed }
}

/** Whether a session has been retired and must not be resumed. */
export function isRetiredMember(retired, sessionId) {
  return retired.has(sessionId)
}
