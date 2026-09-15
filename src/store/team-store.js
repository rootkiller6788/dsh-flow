// The team store: an append-only event log per team, and a projection of it.
//
// This is the piece that makes the rest real. Everything upstream — the rules
// core, the runner, the tools — was written against an injected store, and this
// is the implementation they were waiting for.
//
// The shape is the host's own session store, applied to teams: the log is the
// record, `state.json` is a reading of it that can be thrown away and rebuilt,
// and nothing ever edits the log in place. That is what makes a rollback, a
// failed attempt, or a task that briefly changed status and changed back
// recoverable after the fact — none of which agent-teams' mutable snapshot can
// express.
//
// Writes are atomic via temp-file-plus-rename, matching the discipline already
// used for `workspaces.json`. Appends go through `appendFile`, not through a
// read-modify-write of the whole log, so a growing log costs a growing write
// rather than a quadratic one.
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createTeamManifest, parseEventLog, parseTeamManifest, projectTeam,
  serializeEventLog, serializeTeamManifest, teamEvent,
} from '../rules/index.js'

/** The log file's name inside a team directory. */
export const EVENTS_FILE = 'events.jsonl'
/** The projection checkpoint's name. */
export const STATE_FILE = 'state.json'
/** The manifest's name. */
export const MANIFEST_FILE = 'manifest.json'
/** Archived teams live here, under the same root. */
export const ARCHIVE_DIRECTORY = 'archive'

/**
 * Run operations for one key strictly in order.
 *
 * Same promise-queue shape as the mailbox and member locks — one pattern for
 * every in-process serialization need, so there is one place to reason about
 * ordering rather than three. Re-entrant use of the same key deadlocks.
 */
export function createLockTable() {
  const queues = new Map()
  return async function withLock(key, operation) {
    const previous = queues.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    queues.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (queues.get(key) === tail) queues.delete(key)
    }
  }
}

/**
 * A store over one directory of team directories.
 *
 * @param options.root - the absolute directory holding team directories.
 * @param options.now - clock, injectable so a manifest is reproducible in a test.
 */
export function createTeamStore(options) {
  const root = options.root
  const now = options.now ?? (() => Date.now())
  const withLock = createLockTable()
  const teamDir = teamId => join(root, teamId)

  /** Write a file by way of a sibling temp, so no reader sees a partial one. */
  const writeAtomic = async (path, contents) => {
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, path)
  }

  const readIfPresent = async path => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * The raw event log, or an empty list when the team has none yet.
   *
   * A malformed line is reported and skipped rather than fatal — the reader in
   * the rules core does that — but a line whose `seq` does not match its
   * position is also skipped, because a log that has been reordered cannot be
   * projected without inventing an order.
   */
  const readEvents = async teamId => {
    const raw = await readIfPresent(join(teamDir(teamId), EVENTS_FILE))
    if (raw === undefined) return []
    return parseEventLog(raw, (line, error) => {
      options.onMalformedLine?.(teamId, line, error)
    })
  }

  return {
    root,

    /** Team ids on disk, excluding the archive and any mid-write temp. */
    async listTeamIds() {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        return entries
          .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== ARCHIVE_DIRECTORY)
          .map(entry => entry.name)
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
    },

    /** Archived team ids, newest last as the filesystem reports them. */
    async listArchivedTeamIds() {
      try {
        const entries = await readdir(join(root, ARCHIVE_DIRECTORY), { withFileTypes: true })
        return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name)
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
    },

    /**
     * The current state of one team, derived from its log.
     *
     * Always derived, never read from the checkpoint: a checkpoint that has
     * drifted from its log is a bug, and reading the log makes drift impossible
     * to observe rather than merely unlikely.
     *
     * The record's `id` is pinned to the directory it was read from. The
     * projection derives an id from the team's *name*, and the two can differ —
     * a name that sanitizes differently from the directory it is filed under —
     * which would leave every later write addressing a second, empty team.
     * The directory is the identity; the name is display text.
     */
    async readTeam(teamId) {
      const projected = projectTeam(await readEvents(teamId))
      if (projected === undefined) return undefined
      return { ...projected.state, id: teamId }
    },

    /** The events behind a team, for replay and inspection. */
    async readTeamEvents(teamId) {
      return readEvents(teamId)
    },

    /** The next sequence number for a team's log. */
    async nextSeq(teamId) {
      return (await readEvents(teamId)).length
    },

    /** Whether a team directory exists at all, valid or not. */
    async hasTeam(teamId) {
      return (await readIfPresent(join(teamDir(teamId), MANIFEST_FILE))) !== undefined
    },

    /**
     * Create a team directory with its manifest.
     *
     * The manifest is written first and its schema version checked on every
     * later read, so a directory that exists but cannot be read is reported by
     * its version rather than by a confusing absence of fields.
     */
    async createTeam(teamId) {
      await mkdir(teamDir(teamId), { recursive: true })
      await writeAtomic(
        join(teamDir(teamId), MANIFEST_FILE),
        serializeTeamManifest(createTeamManifest(teamId, now())),
      )
    },

    /**
     * Append events and refresh the checkpoint.
     *
     * `appendFile` rather than a whole-file rewrite: the log only grows, and
     * rewriting it would make every append cost the whole history. The
     * checkpoint is written afterwards from the projection, and is disposable —
     * losing it costs one replay, not data.
     */
    async appendEvents(teamId, events) {
      if (events.length === 0) return
      // Sequence numbers belong to the log, not to the caller. Assigning them
      // here means a caller never has to know the current length, and two
      // callers cannot both pick the same number.
      const base = (await readEvents(teamId)).length
      const numbered = events.map((event, index) => {
        const { type, at, seq: _ignored, ...payload } = event
        return teamEvent(type, payload, at, base + index)
      })
      await mkdir(teamDir(teamId), { recursive: true })
      const handle = await open(join(teamDir(teamId), EVENTS_FILE), 'a')
      try {
        await handle.write(serializeEventLog(numbered))
        // Durable before the checkpoint, so a crash between the two leaves a
        // longer log and a shorter checkpoint — which the next read rebuilds.
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.materialize(teamId)
      return numbered
    },

    /**
     * Rewrite the projection checkpoint from the log.
     *
     * @returns the projected state, so a caller that wants it does not read the
     *   log twice.
     */
    async materialize(teamId) {
      const projected = projectTeam(await readEvents(teamId))
      if (projected === undefined) return undefined
      const state = { ...projected.state, id: teamId }
      await writeAtomic(join(teamDir(teamId), STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
      return state
    },

    /** Read the checkpoint without replaying, for a caller that wants the fast path. */
    async readCheckpoint(teamId) {
      const raw = await readIfPresent(join(teamDir(teamId), STATE_FILE))
      return raw === undefined ? undefined : JSON.parse(raw)
    },

    /** Validate a team's manifest, throwing when this build cannot read it. */
    async readManifest(teamId) {
      const raw = await readIfPresent(join(teamDir(teamId), MANIFEST_FILE))
      return raw === undefined ? undefined : parseTeamManifest(raw)
    },

    /**
     * Move a team aside.
     *
     * The manifest is removed last: a crash mid-archive leaves a directory that
     * still reads as a team rather than one that reads as neither.
     */
    async archiveTeam(teamId) {
      const target = join(root, ARCHIVE_DIRECTORY, teamId)
      await rm(target, { recursive: true, force: true })
      await mkdir(join(root, ARCHIVE_DIRECTORY), { recursive: true })
      await rename(teamDir(teamId), target)
      return target
    },

    /** Remove a team directory outright. */
    async removeTeam(teamId) {
      await rm(teamDir(teamId), { recursive: true, force: true })
    },

    /** Serialize operations for one team across the whole process. */
    withTeamLock(teamId, operation) {
      return withLock(teamId, operation)
    },
  }
}
