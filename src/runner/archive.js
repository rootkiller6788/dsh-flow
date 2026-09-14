// Moving a finished team out of the live set.
//
// Ported from `dsh-agent-teams/src/state.ts` (`archiveTeamDir`,
// `listArchivedTeamIds`). The filesystem is injected so the displace-and-restore
// protocol can be tested without one — and that protocol is the whole point:
// archiving reuses the team directory name, so an earlier archive of the same
// team has to be moved aside first, and a failure halfway through must put it
// back rather than leave two half-teams on disk.

/** Directory archived teams live under, relative to the state root. */
export const ARCHIVE_DIR = 'archive'

/** The hidden name an existing archive is displaced to while a new one lands. */
const displacedName = (teamId, nonce) => `.${teamId}.previous-${nonce}`

/**
 * Archive one team directory.
 *
 * Three steps, each able to fail without corrupting the others:
 *   1. displace an existing `archive/<teamId>` to a hidden sibling
 *   2. move `<teamId>` into the archive
 *   3. remove the displaced copy, or restore it if step 2 failed
 *
 * @param io - the filesystem operations this needs.
 * @param io.exists - `(path) => Promise<boolean>`.
 * @param io.move - `(from, to) => Promise<void>`.
 * @param io.remove - `(path) => Promise<void>`.
 * @param stateRoot - the absolute state root.
 * @param teamId - the team to archive.
 * @param nonce - a unique suffix for the displaced name.
 * @returns `{ archived, displaced? }` — `displaced` is the hidden path left
 *   behind when it could not be cleaned up.
 */
export async function archiveTeamDir(io, stateRoot, teamId, nonce) {
  const source = `${stateRoot}/${teamId}`
  const target = `${stateRoot}/${ARCHIVE_DIR}/${teamId}`
  const stash = `${stateRoot}/${ARCHIVE_DIR}/${displacedName(teamId, nonce)}`

  let displaced
  if (await io.exists(target)) {
    await io.move(target, stash)
    displaced = stash
  }

  try {
    await io.move(source, target)
  } catch (error) {
    // The team never landed, so the earlier archive is still the only copy.
    if (displaced !== undefined) await io.move(displaced, target).catch(() => {})
    throw error
  }

  if (displaced !== undefined) {
    // Best effort: the team is archived either way, and a leftover hidden
    // directory is a smaller problem than a failed archive.
    await io.remove(displaced).catch(() => {})
  }
  return { archived: target }
}

/**
 * Names of archived teams, newest last as the filesystem reports them.
 *
 * Dot-entries are skipped: those are the displaced copies mid-protocol, not
 * teams. Listing them would offer a user a half-archived team that the next
 * archive is about to overwrite.
 *
 * @param entries - `readdir` output with file types.
 * @returns the team ids.
 */
export function listArchivedTeamIds(entries) {
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
}
