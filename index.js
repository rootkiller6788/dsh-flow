import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
// Synchronous twins, used by the teardown flush: process 'exit' and a plugin
// unload will not wait for a promise.
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { installFlowKernel } from './kernel.js'
import { canvasSnapshot } from './src/store/snapshot.js'

export const name = 'dsh-flow'
export const inject = ['webServer', 'sessions']

const MAX_BODY_BYTES = 32 * 1024
const MAX_TITLE_LENGTH = 120
const MAX_NOTE_LENGTH = 4_000
// Projected message text cap: longer replies truncate with a marker pointing
// at the detail view instead of silently cutting mid-sentence.
const MAX_PROJECTION_LENGTH = 8_000
const PROJECTION_TRUNCATED_SUFFIX = '\n——…（已截断，完整内容在「对话」标签中打开）'
// Tool arguments and results are where the projection actually gets big: file
// contents, diffs and command output arrive verbatim, and they measured 2.70MB
// — 60% of a real 4.23MB store — across 722 entries, single fields reaching 48K
// characters. Chat text has always been capped; these two never were.
//
// The distribution is extremely long-tailed: the median argument is 404
// characters and the median result 127, while the 90th percentile is 2843 and
// 4018. So a 4000-character cap clips only the outlier tail that causes the
// bloat — 114 of 722 entries (16%) — and leaves 84% of entries byte-identical,
// while removing 29% of the bytes. 8000 would touch 6%; 2000 would touch 36% for
// another 18 points. DSH keeps the full record (the canvas already sends you
// there for the complete run), so the marker says where to find it.
const MAX_TOOL_FIELD_LENGTH = 4_000
function truncateToolText(text) {
  if (typeof text !== 'string' || text.length <= MAX_TOOL_FIELD_LENGTH) return text
  return `${text.slice(0, MAX_TOOL_FIELD_LENGTH)}\n——…（已截断：原文 ${text.length} 字，此处保留前 ${MAX_TOOL_FIELD_LENGTH} 字；完整过程在「对话」标签中打开）`
}
const TOPIC_COLORS = ['#0f766e', '#0e7490', '#6d28d9', '#b45309', '#be123c']
const LOCK_STALE_MS = 60_000
// Deferred (event-projection) writes coalesce into one save per window, so a
// burst of session events costs a single full-state write instead of one per
// event (issue #13: per-event saves pinned the main thread at ~90% CPU).
const SAVE_DEBOUNCE_MS = 800
// How long a repeated, identical failure stays folded into the previously logged
// one. Long enough that a broken store cannot flood the log, short enough that a
// still-broken store keeps reminding you.
const FAILURE_LOG_WINDOW_MS = 60_000
// The store is one JSON document that reaches megabytes once a session has
// history, so it is written gzip-compressed: ~27% of the bytes on disk. Both
// directions are async (libuv threadpool) — a synchronous gzip of the current
// 4.2MB store blocks the event loop for ~62ms, which is exactly the cost the
// debounce above exists to avoid. Level 1 costs half the CPU of the default
// for 4 percentage points more size (1.13MB vs 0.96MB), which the disk does
// not care about.
const GZIP_OPTIONS = { level: zlib.constants.Z_BEST_SPEED }
const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)
// Written gzip-compressed, read transparently: a file that starts with the
// gzip magic is inflated, anything else is parsed as plain JSON — so a store
// written before this change (or edited by hand) still loads.
function isGzip(buffer) {
  return buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

/**
 * Whether a lock file's contents/mtime mean the lock can be broken. Split out
 * from the async `lockIsStale` so the teardown flush — which may only use
 * synchronous IO — reaches the same verdict instead of growing a second copy of
 * this rule. An empty/garbled pid counts as stale only once the file is old.
 */
function lockIsStaleFrom(content, mtimeMs) {
  const tooOld = Date.now() - mtimeMs > LOCK_STALE_MS
  const pid = Number.parseInt(content, 10)
  if (!Number.isInteger(pid)) return tooOld
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return tooOld
  } catch {
    return true
  }
}

// --- Shared write discipline for dsh-flow's two data files -------------------
// Both files are written whole by a process that may not be the only one
// running, so both need the same three things: a sibling `.lock` while writing,
// an atomic rename so no reader ever sees a partial file, and a way to tell the
// user when a second instance already overwrote them. Kept here rather than
// inline in each writer so the rule cannot drift between them.

async function mtimeOf(file) {
  try { return (await stat(file)).mtimeMs } catch { return null }
}

async function tryAcquireLock(lockFile) {
  try {
    await writeFile(lockFile, `${process.pid}\n`, { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

async function lockIsStale(lockFile) {
  try {
    const [content, stats] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)])
    return lockIsStaleFrom(content, stats.mtimeMs)
  } catch {
    return false
  }
}

/** Take `<file>.lock`, breaking a stale one; `onContended` runs once per hold-out. */
async function acquireFileLock(file, onContended) {
  const lockFile = `${file}.lock`
  if (await tryAcquireLock(lockFile)) return true
  if (await lockIsStale(lockFile)) {
    // Breaking a stale lock means removing the file first: 'wx' would just fail
    // again against the file still sitting there.
    await unlink(lockFile).catch(() => {})
    if (await tryAcquireLock(lockFile)) return true
  }
  onContended()
  return false
}

async function releaseFileLock(file) {
  await unlink(`${file}.lock`).catch(() => {})
}

/** Write `<file>.<pid>.tmp` then rename it into place. */
async function atomicWrite(file, contents, options) {
  const temporaryFile = `${file}.${process.pid}.tmp`
  await writeFile(temporaryFile, contents, options)
  await rename(temporaryFile, file)
}

// Projection dedup index. `projectEventInto` used to ask "have I already stored
// this seq?" by scanning `thread.messages` for every incoming event — O(messages)
// per event, so O(n²) across a session's history (753 messages in a real store).
// The answer only ever grows, so an index is the right shape.
//
// It is derived from the message list and lives in a WeakMap, which keeps it out
// of two places it must not reach: the persisted JSON (the whole document is
// rewritten on every save, so an index in there would be dead weight on disk)
// and `structuredClone`, which drops non-enumerable properties anyway. The
// message list's identity is checked on every use, so a wholesale replacement of
// `thread.messages` — which the load path does when folding legacy cards —
// invalidates the index instead of leaving it stale.
const seqIndexes = new WeakMap()
function seqIndexOf(thread) {
  const cached = seqIndexes.get(thread)
  if (cached !== undefined && cached.messages === thread.messages) return cached.seqs
  const seqs = new Set()
  for (const message of thread.messages) if (Number.isInteger(message.sourceSeq)) seqs.add(message.sourceSeq)
  seqIndexes.set(thread, { messages: thread.messages, seqs })
  return seqs
}

/**
 * Write while holding the lock, and report the two ways a second dsh web
 * instance becomes visible: it moved the file's mtime since our last write, or
 * it is holding the lock right now.
 */
async function guardedWrite(file, label, state, contents, options) {
  const before = await mtimeOf(file)
  if (state.lastKnownMtime !== null && before !== null && before !== state.lastKnownMtime) {
    state.lastKnownMtime = before
    if (!state.externalWarned) {
      state.externalWarned = true
      process.stderr.write(`dsh-flow: ${label} 已被另一个 dsh web 实例修改，本实例的写入可能覆盖其更改——请只运行一个实例\n`)
    }
  }
  await acquireFileLock(file, () => {
    if (state.lockWarned) return
    state.lockWarned = true
    process.stderr.write(`dsh-flow: 另一个 dsh web 实例正在写入 ${label}——请只运行一个实例，否则画布数据可能互相覆盖\n`)
  })
  try {
    await atomicWrite(file, contents, options)
    state.lastKnownMtime = await mtimeOf(file)
  } finally {
    await releaseFileLock(file)
  }
}

/** JSON persistence for the canvas workspace graph. */
export class WorkspaceStore {
  constructor(dataFile) {
    if (typeof dataFile !== 'string' || dataFile.length === 0) throw new Error('dsh-flow: config.dataFile must be a non-empty path')
    this.dataFile = dataFile
    this.state = undefined
    this.serial = Promise.resolve()
    this.ready = this.load()
    this.lastKnownMtime = null
    this.externalModWarned = false
    this.lockWarned = false
    this.dirty = false
    this.exitHandler = null
    this.flushTimer = null
  }

  async list() {
    await this.ready
    return this.state.workspaces.map(workspace => this.summary(workspace))
  }

  async get(workspaceId) {
    await this.ready
    const workspace = this.workspace(workspaceId)
    return structuredClone(workspace)
  }

  async create(title) {
    return this.mutate(() => {
      const now = new Date().toISOString()
      const workspace = { id: randomUUID(), title: requiredText(title, MAX_TITLE_LENGTH, 'title'), createdAt: now, updatedAt: now, threads: [] }
      this.state.workspaces.unshift(workspace)
      return this.summary(workspace)
    })
  }

  async createThread(workspaceId, input) {
    return this.mutate(() => {
      const workspace = this.workspace(workspaceId)
      const now = new Date().toISOString()
      const thread = this.thread({
        title: input?.title,
        parentId: input?.parentId,
        dshSessionId: input?.dshSessionId,
        dshSessionTitle: input?.dshSessionTitle,
        position: input?.position,
        color: input?.color,
        now,
        order: workspace.threads.length,
      })
      if (thread.parentId !== null && !workspace.threads.some(item => item.id === thread.parentId)) throw new InputError('分支来源不存在')
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  async branch(threadId, input) {
    return this.mutate(() => {
      const { workspace, thread: parent } = this.locateThread(threadId)
      const now = new Date().toISOString()
      const sessionId = typeof input?.dshSessionId === 'string' && input.dshSessionId.length > 0 ? input.dshSessionId : null
      // A DSH fork emits session/created while the browser receives its fork
      // response. Either path may win the race, but both must resolve to one node.
      if (sessionId !== null) {
        const existing = workspace.threads.find(item => item.dshSessionId === sessionId)
        if (existing !== undefined) {
          existing.parentId ??= parent.id
          if (typeof input?.title === 'string' && input.title.trim() !== '') existing.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
          if (typeof input?.dshSessionTitle === 'string') existing.dshSessionTitle = input.dshSessionTitle.slice(0, MAX_TITLE_LENGTH)
          existing.updatedAt = now
          workspace.updatedAt = now
          return structuredClone(existing)
        }
      }
      const siblings = workspace.threads.filter(item => item.parentId === parent.id)
      const thread = this.thread({
        title: input?.title,
        parentId: parent.id,
        dshSessionId: input?.dshSessionId,
        dshSessionTitle: input?.dshSessionTitle,
        position: input?.position ?? { x: parent.position.x + 420, y: parent.position.y + siblings.length * 248 },
        color: input?.color ?? parent.color,
        now,
        order: workspace.threads.length,
      })
      workspace.threads.push(thread)
      workspace.updatedAt = now
      return structuredClone(thread)
    })
  }

  /** Keep only the canvas graph here; DSH remains the source of session truth. */
  async syncSessions(sessions, removedSessionIds = []) {
    return this.mutate(() => {
      if (!Array.isArray(sessions)) throw new InputError('sessions 必须是数组')
      if (!Array.isArray(removedSessionIds) || removedSessionIds.some(item => typeof item !== 'string')) throw new InputError('removedSessionIds 必须是字符串数组')
      const blankIds = new Set(sessions.filter(item => item?.blank === true && typeof item.id === 'string').map(item => item.id))
      const removedIds = new Set(removedSessionIds)
      const hidden = new Set(this.state.hiddenSessionIds)
      for (const workspace of this.state.workspaces) {
        if (workspace.kind !== 'dsh') continue
        workspace.threads = workspace.threads.filter(thread => !blankIds.has(thread.dshSessionId) && !removedIds.has(thread.dshSessionId))
      }
      this.state.workspaces = this.state.workspaces.filter(workspace => workspace.kind !== 'dsh' || workspace.threads.length > 0)
      for (const item of sessions) {
        if (typeof item?.id !== 'string' || item.id === '' || typeof item.cwd !== 'string' || item.cwd === '') continue
        if (item.blank === true) continue
        // Canvas archiving is persistent UI state. A normal DSH list refresh
        // must not recreate a session that the user deliberately archived.
        if (hidden.has(item.id)) continue
        const workspace = this.dshWorkspace(item.cwd, 'DSH 任务')
        const session = { id: item.id, header: { meta: { cwd: item.cwd }, parentSession: typeof item.parentId === 'string' ? item.parentId : undefined }, title: typeof item.title === 'string' ? item.title : undefined, events: [] }
        const thread = this.dshThread(workspace, session)
        if (typeof item.title === 'string' && item.title.trim() !== '') {
          thread.title = item.title.slice(0, MAX_TITLE_LENGTH)
          thread.dshSessionTitle = thread.title
        }
      }
      return this.list()
    }, { deferred: true })
  }

  async addMessage(threadId, text) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      const at = new Date().toISOString()
      const message = { id: randomUUID(), text: requiredText(text, MAX_NOTE_LENGTH, 'text'), kind: 'user', at }
      message.rev = this.touch(thread)
      thread.messages.push(message)
      thread.updatedAt = at
      workspace.updatedAt = at
      return structuredClone(thread)
    })
  }

  async updateThread(threadId, input) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      if (input?.title !== undefined) thread.title = requiredText(input.title, MAX_TITLE_LENGTH, 'title')
      if (input?.position !== undefined) thread.position = positionOf(input.position)
      thread.updatedAt = new Date().toISOString()
      workspace.updatedAt = thread.updatedAt
      return structuredClone(thread)
    })
  }

  async removeThread(threadId) {
    return this.mutate(() => {
      const { workspace, thread } = this.locateThread(threadId)
      // Archiving a node takes its descendants with it. The old form rescanned
      // every thread once per generation of descendants to find the next layer;
      // one parent→children index answers the same question in a single walk.
      const children = new Map()
      for (const item of workspace.threads) {
        if (item.parentId === null) continue
        const list = children.get(item.parentId)
        if (list === undefined) children.set(item.parentId, [item])
        else list.push(item)
      }
      const removal = new Set([thread.id])
      const pending = [thread.id]
      while (pending.length > 0) {
        for (const child of children.get(pending.pop()) ?? []) {
          if (removal.has(child.id)) continue
          removal.add(child.id)
          pending.push(child.id)
        }
      }
      const hidden = new Set(this.state.hiddenSessionIds)
      for (const item of workspace.threads) {
        if (!removal.has(item.id) || item.dshSessionId === null || hidden.has(item.dshSessionId)) continue
        hidden.add(item.dshSessionId)
        this.state.hiddenSessionIds.push(item.dshSessionId)
      }
      workspace.threads = workspace.threads.filter(item => !removal.has(item.id))
      workspace.updatedAt = new Date().toISOString()
      if (workspace.threads.length === 0) this.state.workspaces = this.state.workspaces.filter(item => item.id !== workspace.id)
      return { removed: removal.size }
    })
  }

  async clearLegacy(sessions) {
    return this.mutate(() => {
      const hidden = new Set(this.state.hiddenSessionIds)
      for (const workspace of this.state.workspaces) for (const thread of workspace.threads) if (thread.dshSessionId !== null) hidden.add(thread.dshSessionId)
      for (const session of sessions) hidden.add(session.id)
      this.state.hiddenSessionIds = [...hidden]
      this.state.workspaces = []
      return { cleared: true }
    })
  }

  /** Replay one live DSH session into the dedicated projection workspace. */
  async projectSession(session, replayFrom = 0, workspaceTitle = 'DSH 任务') {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.dshThread(workspace, session)
      for (const event of session.events) {
        if (event.seq >= replayFrom) this.projectEventInto(workspace, thread, event)
      }
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project one committed DSH session event. Repeated sequence numbers are ignored. */
  async projectEvent(session, event, workspaceTitle = 'DSH 任务') {
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.dshThread(workspace, session)
      this.projectEventInto(workspace, thread, event)
      return structuredClone(thread)
    }, { deferred: true })
  }

  /** Project a batch of committed events for one session in a single write. */
  async projectEvents(session, events, workspaceTitle = 'DSH 任务') {
    if (events.length === 0) return null
    return this.mutate(() => {
      if (this.state.hiddenSessionIds.includes(session.id)) return null
      const workspace = this.dshWorkspace(sessionCwd(session), workspaceTitle)
      const thread = this.dshThread(workspace, session)
      for (const event of events) this.projectEventInto(workspace, thread, event)
      return structuredClone(thread)
    }, { deferred: true })
  }

  async load() {
    await mkdir(dirname(this.dataFile), { recursive: true })
    await this.sweepTempFiles()
    try {
      const raw = await readFile(this.dataFile)
      const parsed = JSON.parse(isGzip(raw) ? (await gunzip(raw)).toString('utf8') : raw.toString('utf8'))
      const { state, migrated } = normalizeState(parsed)
      const revMissing = !Number.isSafeInteger(parsed?.rev)
      const { rev, stamped } = stampMissingRevs(state)
      state.rev = rev
      this.state = state
      if (migrated || stamped || revMissing) await this.save()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`dsh-flow: cannot read ${this.dataFile}: ${error.message}`)
      this.state = { version: 4, hiddenSessionIds: [], workspaces: [], rev: 0 }
      await this.save()
    }
  }

  async mutate(action, { deferred = false } = {}) {
    await this.ready
    const task = this.serial.then(async () => {
      const result = action()
      if (deferred) this.markDirty()
      else await this.save()
      return result
    })
    this.serial = task.catch(() => undefined)
    return task
  }

  /** Mark the state dirty and schedule one trailing flush for the window. */
  markDirty() {
    this.dirty = true
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /** Persist the current state when dirty, ordered after in-flight mutations. */
  flush() {
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    const task = this.serial.then(() => this.save())
    this.serial = task.catch(() => undefined)
    return task
  }

  async save() {
    // Two dsh web instances sharing one profile clobber each other's canvas
    // state, so this goes through the shared guardedWrite: the lock, the atomic
    // rename, and a warn-once when the file moved under us (this instance
    // supplies its own mtime/warn state rather than keeping a parallel copy).
    await guardedWrite(this.dataFile, 'workspaces.json', this, await gzip(`${JSON.stringify(this.state)}\n`, GZIP_OPTIONS))
  }

  async fileMtime() {
    return mtimeOf(this.dataFile)
  }

  /**
   * Delete temp files whose writing process is gone. Every write goes
   * `<file>.<pid>.tmp` then rename, so a process that dies in between leaves a
   * file nothing will ever look at again — one is sitting in a real profile
   * right now. The pid in the name is what makes the sweep safe: a temp file
   * whose owner no longer exists can never be renamed into place or adopted, so
   * removing it is lossless. A live owner is left strictly alone, because a
   * concurrent instance may be mid-write. Anything not matching
   * `<base>.<digits>.tmp` is not ours and is skipped.
   */
  async sweepTempFiles(base = this.dataFile) {
    const directory = dirname(base)
    const prefix = `${basename(base)}.`
    let names
    try { names = await readdir(directory) } catch { return 0 }
    let removed = 0
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const owner = Number.parseInt(name.slice(prefix.length, -'.tmp'.length), 10)
      if (!Number.isInteger(owner) || owner === process.pid) continue
      try {
        process.kill(owner, 0)
        continue
      } catch {
        // The owner is gone: the rename that would have consumed this never ran.
      }
      try { await unlink(join(directory, name)); removed += 1 } catch { /* raced with another sweep */ }
    }
    return removed
  }

  /**
   * Synchronous flush for teardown. The debounce above holds up to
   * SAVE_DEBOUNCE_MS of changes in memory, and neither process 'exit' nor a
   * plugin unload waits for a promise — so without this, stopping the host
   * during that window drops the last writes silently.
   *
   * Deliberately plain JSON, not gzip: the goal here is to finish quickly, and
   * `load()` detects the format by magic bytes, so the next normal save
   * re-compresses it.
   */
  flushSync() {
    if (!this.dirty || this.state === undefined) return false
    const lockFile = `${this.dataFile}.lock`
    try {
      writeFileSync(lockFile, `${process.pid}\n`, { flag: 'wx' })
    } catch {
      // Only break a lock whose owner is demonstrably gone; a live holder means
      // another instance is writing, and overwriting it is precisely the
      // clobber the lock exists to prevent.
      let breakable = false
      try { breakable = lockIsStaleFrom(readFileSync(lockFile, 'utf8'), statSync(lockFile).mtimeMs) } catch { breakable = false }
      if (!breakable) {
        process.stderr.write('dsh-flow: 另一个 dsh web 实例正持有写锁，本次退出未保存的改动已丢弃——请只运行一个实例\n')
        return false
      }
      // Breaking a stale lock means removing it first — 'wx' would just fail
      // again against the file still sitting there. (The async acquireLock does
      // the same unlink; leaving it out here silently disabled the whole path.)
      try { unlinkSync(lockFile) } catch { /* raced with another writer */ }
      try { writeFileSync(lockFile, `${process.pid}\n`, { flag: 'wx' }) } catch {
        process.stderr.write('dsh-flow: 退出时未能取得写锁，本次未保存的改动已丢弃\n')
        return false
      }
    }
    try {
      const temporaryFile = `${this.dataFile}.${process.pid}.tmp`
      writeFileSync(temporaryFile, `${JSON.stringify(this.state)}\n`)
      renameSync(temporaryFile, this.dataFile)
      this.dirty = false
      this.lastKnownMtime = statSync(this.dataFile).mtimeMs
      return true
    } catch (error) {
      process.stderr.write(`dsh-flow: 退出时保存失败——${error.message}\n`)
      return false
    } finally {
      try { unlinkSync(lockFile) } catch { /* already gone */ }
    }
  }

  /** Flush the debounced window when the process exits. Idempotent. */
  watchExit() {
    if (this.exitHandler !== null) return
    this.exitHandler = () => { this.flushSync() }
    process.once('exit', this.exitHandler)
  }

  unwatchExit() {
    if (this.exitHandler === null) return
    process.removeListener('exit', this.exitHandler)
    this.exitHandler = null
  }


  workspace(workspaceId) {
    const workspace = this.state.workspaces.find(item => item.id === workspaceId)
    if (workspace === undefined) throw new NotFoundError('工作空间不存在')
    return workspace
  }

  locateThread(threadId) {
    for (const workspace of this.state.workspaces) {
      const thread = workspace.threads.find(item => item.id === threadId)
      if (thread !== undefined) return { workspace, thread }
    }
    throw new NotFoundError('节点不存在')
  }

  dshWorkspace(cwd, fallbackTitle) {
    let workspace = this.state.workspaces.find(item => item.kind === 'dsh' && item.cwd === cwd)
    if (workspace !== undefined) return workspace
    const now = new Date().toISOString()
    workspace = { id: randomUUID(), kind: 'dsh', cwd, title: workspaceTitle(cwd, fallbackTitle), createdAt: now, updatedAt: now, threads: [] }
    this.state.workspaces.unshift(workspace)
    return workspace
  }

  dshThread(workspace, session) {
    let thread = workspace.threads.find(item => item.dshSessionId === session.id)
    if (thread !== undefined) {
      let changed = false
      if (typeof session.title === 'string' && session.title.trim() !== '') {
        const title = session.title.slice(0, MAX_TITLE_LENGTH)
        if (title !== thread.title) changed = true
        thread.title = title
        thread.dshSessionTitle = title
      }
      // `seedLength` is DSH's durable fork cut. Keep it even after the
      // session has been restored, when its in-process `firstLiveSeq` moves.
      const seedLength = session.header?.seedLength
      if (Number.isSafeInteger(seedLength) && seedLength >= 0) {
        if (seedLength !== thread.sourceSeedLength) changed = true
        thread.sourceSeedLength = seedLength
      }
      // Only an actual change earns a revision: dshThread runs for every event
      // of the session, and stamping unconditionally would make every reader
      // reload the thread on every event.
      if (changed) this.touch(thread)
      return thread
    }
    const parentSessionId = typeof session.header?.parentSession === 'string' ? session.header.parentSession : null
    const parent = parentSessionId === null ? undefined : workspace.threads.find(item => item.dshSessionId === parentSessionId)
    const siblings = workspace.threads.filter(item => item.sourceParentSessionId === parentSessionId)
    const now = new Date().toISOString()
    thread = {
      id: randomUUID(),
      title: typeof session.title === 'string' && session.title.trim() !== '' ? session.title.slice(0, MAX_TITLE_LENGTH) : (parent === undefined ? 'DSH 会话' : `${parent.title} 分支`),
      parentId: parent?.id ?? null,
      sourceParentSessionId: parentSessionId,
      sourceSeedLength: Number.isSafeInteger(session.header?.seedLength) && session.header.seedLength >= 0 ? session.header.seedLength : null,
      dshSessionId: session.id,
      dshSessionTitle: typeof session.title === 'string' ? session.title.slice(0, MAX_TITLE_LENGTH) : null,
      color: TOPIC_COLORS[workspace.threads.length % TOPIC_COLORS.length],
      // DSH projection stores only a neutral semantic anchor. The visual map
      // lays out visible cards from the current conversation graph each render,
      // so old/archived session counts must never leak into future coordinates.
      position: parent === undefined ? { x: 86, y: 82 } : { x: parent.position.x + 400, y: parent.position.y },
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
    workspace.threads.push(thread)
    this.touch(thread)
    // A child may arrive before its parent during startup replay. Repair that
    // relation when the missing parent later reaches the projection.
    for (const child of workspace.threads) {
      if (child.sourceParentSessionId === session.id && child.parentId === null) {
        child.parentId = thread.id
        // An edge appeared in the graph: the child has no new message, so the
        // stamp is the only thing that tells a reader the tree changed.
        this.touch(child)
      }
    }
    workspace.updatedAt = now
    return thread
  }

  projectEventInto(workspace, thread, event) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      thread.title = event.data.title.slice(0, MAX_TITLE_LENGTH)
      thread.dshSessionTitle = thread.title
      // No message carries this change, so the thread needs the stamp itself or
      // an incremental reader would keep showing the old title forever.
      this.touch(thread)
      thread.updatedAt = new Date(event.time).toISOString()
      workspace.updatedAt = thread.updatedAt
      return
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      this.foldToolProcess(thread, event)
      workspace.updatedAt = thread.updatedAt
      return
    }
    const projection = projectableEvent(event)
    if (projection === null) return
    const seen = seqIndexOf(thread)
    if (seen.has(event.seq)) return
    const at = new Date(event.time).toISOString()
    const message = {
      id: randomUUID(),
      text: projection.text,
      kind: projection.kind,
      sourceSeq: event.seq,
      at,
      ...(projection.kind === 'assistant' || projection.kind === 'error'
        ? { turn: event.data?.turn, step: event.data?.step, process: [] }
        : {}),
    }
    const agent = classifyAgentText(projection.text)
    if (agent !== null) {
      message.agent = { kind: agent.kind, agentId: agent.agentId, from: agent.from, to: agent.to, ...(agent.label !== undefined ? { label: agent.label } : {}) }
      message.text = agent.text
    }
    this.attachPendingProcess(thread, message)
    message.rev = this.touch(thread)
    thread.messages.push(message)
    seen.add(event.seq)
    thread.updatedAt = at
    workspace.updatedAt = at
    if (thread.dshSessionTitle === null && projection.kind === 'user' && message.agent === undefined) {
      // The derived title rides along with the message that produced it, so no
      // separate stamp: the thread already moved.
      thread.title = titleFromText(message.text)
      thread.dshSessionTitle = thread.title
    }
  }

  /**
   * Stamp a change and return its revision. Every mutation to a thread's content
   * routes through here, so `thread.rev` is always the highest revision in that
   * thread — which is what makes it usable as a client cursor: a reader that has
   * applied everything up to `rev` only needs what comes after it.
   */
  touch(thread) {
    const rev = (this.state.rev ?? 0) + 1
    this.state.rev = rev
    thread.rev = rev
    return rev
  }

  /**
   * Fold one tool call or result into the assistant message of its own
   * turn/step, keyed by `callId`, so a tool invocation never becomes a
   * separate canvas card. If a tool result arrives before its associated
   * assistant/error message, retain it on the thread until that turn appears.
   */
  foldToolProcess(thread, event) {
    const at = new Date(event.time).toISOString()
    const data = event.data ?? {}
    // The newest assistant/error message of this turn/step, or the newest one
    // with no turn/step at all. Walked backwards rather than
    // `[...messages].reverse().find(...)`, which copied the whole message list
    // on every tool event — a 235-message thread allocated a 235-element array
    // per call, for an answer that is almost always in the last few entries.
    let target
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      const message = thread.messages[index]
      if (message.kind !== 'assistant' && message.kind !== 'error') continue
      if (message.turn === data.turn && message.step === data.step || message.turn === undefined && message.step === undefined) {
        target = message
        break
      }
    }
    const process = target === undefined ? (thread.pendingProcess ??= []) : (target.process ??= [])
    const callId = String(event.type === 'tool/call' ? data.callId : data.message?.source?.callId ?? '')
    const entry = process.find(item => item.callId === callId)
    if (event.type === 'tool/call') {
      const toolArguments = truncateToolText(data.arguments)
      if (entry === undefined) {
        process.push({ callId, turn: data.turn, step: data.step, name: data.name, arguments: toolArguments, result: null, error: null })
      } else {
        entry.name = data.name
        entry.arguments = toolArguments
      }
    } else {
      const outcome = truncateToolText(contentText(data.message?.content))
      const error = truncateToolText(errorText(data.error))
      if (entry === undefined) {
        process.push({ callId, turn: data.turn, step: data.step, name: '工具调用', arguments: null, result: outcome, error })
      } else {
        entry.result = outcome
        entry.error = error
      }
    }
    // A tool result folds into an already-delivered message, so the message —
    // not just the thread — needs a fresh revision or an incremental reader
    // would never see the result it is waiting for.
    if (target !== undefined) target.rev = this.touch(thread)
    thread.updatedAt = at
  }

  attachPendingProcess(thread, message) {
    if (!Array.isArray(thread.pendingProcess) || thread.pendingProcess.length === 0 || !Array.isArray(message.process)) return
    const matching = thread.pendingProcess.filter(entry => entry.turn === message.turn && entry.step === message.step)
    if (matching.length === 0) return
    message.process.push(...matching.map(({ turn, step, ...entry }) => entry))
    thread.pendingProcess = thread.pendingProcess.filter(entry => entry.turn !== message.turn || entry.step !== message.step)
  }

  thread({ title, parentId, dshSessionId, dshSessionTitle, position, color, now, order }) {
    return {
      id: randomUUID(),
      title: requiredText(title, MAX_TITLE_LENGTH, 'title'),
      parentId: typeof parentId === 'string' && parentId.length > 0 ? parentId : null,
      dshSessionId: typeof dshSessionId === 'string' && dshSessionId.length > 0 ? dshSessionId : null,
      dshSessionTitle: typeof dshSessionTitle === 'string' ? dshSessionTitle.slice(0, MAX_TITLE_LENGTH) : null,
      color: TOPIC_COLORS.includes(color) ? color : TOPIC_COLORS[order % TOPIC_COLORS.length],
      position: positionOf(position ?? { x: 86 + (order % 3) * 410, y: 82 + Math.floor(order / 3) * 260 }),
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingProcess: [],
    }
  }

  summary(workspace) {
    return { id: workspace.id, kind: workspace.kind ?? 'manual', cwd: workspace.cwd ?? null, title: workspace.title, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt, threadCount: workspace.threads.length }
  }

  /**
   * The canvas' incremental read. Returns every thread belonging to
   * `sessionIds`, but each thread carries only the messages the caller's cursor
   * has not seen — plus the full thread id list, so a reader can prune nodes
   * that went away (archiving removes a thread without leaving a tombstone).
   *
   * This is what keeps a poll cheap: appending one message to a 235-message
   * thread costs that one message instead of the whole workspace. It also
   * replaces reading every workspace in full and throwing away the threads that
   * were not asked for.
   *
   * The response references the live state rather than cloning it. `sendJson`
   * stringifies synchronously in the same microtask, and nothing else can run in
   * between, so there is no window for a mutation to be observed half-applied —
   * which is 6ms of structuredClone per request saved.
   */
  async projection(sessionIds, cursors) {
    await this.ready
    if (!Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string')) throw new InputError('sessionIds 必须是字符串数组')
    if (cursors !== null && cursors !== undefined && typeof cursors !== 'object') throw new InputError('cursors 必须是对象')
    const wanted = new Set(sessionIds)
    const known = cursors ?? {}
    const threadIds = []
    const threads = []
    for (const workspace of this.state.workspaces) {
      for (const thread of workspace.threads) {
        if (thread.dshSessionId === null || !wanted.has(thread.dshSessionId)) continue
        threadIds.push(thread.id)
        const cursor = Number.isSafeInteger(known[thread.id]) ? known[thread.id] : 0
        if ((thread.rev ?? 0) <= cursor) continue
        const { messages, ...metadata } = thread
        threads.push({ ...metadata, messages: messages.filter(message => (message.rev ?? 0) > cursor) })
      }
    }
    return { rev: this.state.rev ?? 0, threadIds, threads }
  }
}

class InputError extends Error {}
class NotFoundError extends Error {}

function normalizeState(value) {
  let migrated = false
  let state
  if ((value?.version === 2 || value?.version === 3 || value?.version === 4) && Array.isArray(value.workspaces)) {
    const hiddenSessionIds = Array.isArray(value.hiddenSessionIds) ? value.hiddenSessionIds.filter(item => typeof item === 'string') : []
    migrated = value.version < 3 || !Array.isArray(value.hiddenSessionIds)
    const workspaces = value.workspaces.map(workspace => ({
      ...workspace,
      threads: Array.isArray(workspace.threads) ? workspace.threads.map(thread => {
        if (Array.isArray(thread.messages)) {
          const messages = thread.messages.filter(message => !isRuntimeContextMessage(message))
          if (messages.length !== thread.messages.length) migrated = true
          return { ...thread, messages }
        }
        migrated = true
        const notes = Array.isArray(thread.notes) ? thread.notes : []
        const { notes: _notes, ...rest } = thread
        return { ...rest, messages: notes, pendingProcess: [] }
      }) : [],
    }))
    state = { ...value, version: value.version, hiddenSessionIds, workspaces }
  } else if (value?.version === 1 && Array.isArray(value.workspaces)) {
    const now = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
    state = {
      version: 3,
      hiddenSessionIds: [],
      workspaces: value.workspaces.map((workspace, index) => {
        const events = Array.isArray(workspace.events) ? workspace.events : []
        const workspaceNow = typeof workspace.updatedAt === 'string' ? workspace.updatedAt : now
        return {
          id: typeof workspace.id === 'string' ? workspace.id : randomUUID(),
          title: typeof workspace.title === 'string' && workspace.title.trim() ? workspace.title : '未命名工作空间',
          createdAt: typeof workspace.createdAt === 'string' ? workspace.createdAt : workspaceNow,
          updatedAt: workspaceNow,
          threads: events.length === 0 ? [] : [{
            id: randomUUID(), title: workspace.title || '历史记录', parentId: null, dshSessionId: null, dshSessionTitle: null,
            color: TOPIC_COLORS[index % TOPIC_COLORS.length], position: { x: 86, y: 82 }, createdAt: workspaceNow, updatedAt: workspaceNow,
            messages: events.map(event => ({ id: typeof event.id === 'string' ? event.id : randomUUID(), text: String(event.text ?? ''), at: typeof event.at === 'string' ? event.at : workspaceNow })),
          }],
        }
      }),
    }
    migrated = true
  } else {
    throw new Error('expected dsh-flow data version 1, 2, 3, or 4')
  }
  if (state.version !== 4) {
    if (foldLegacyToolCards(state.workspaces)) migrated = true
    state.version = 4
    migrated = true
  }
  return { state, migrated }
}

/**
 * Fold v3-era standalone tool cards (kinds `tool` / `tool-result`) into the
 * preceding assistant message's `process` list, pairing each call with the
 * result that follows it in order, so every tool invocation lives in one
 * home: the assistant turn card.
 */
function foldLegacyToolCards(workspaces) {
  let changed = false
  for (const workspace of workspaces) {
    for (const thread of workspace.threads ?? []) {
      if (!Array.isArray(thread.messages)) continue
      const folded = []
      let assistant = null
      let pending = []
      for (const message of thread.messages) {
        if (message.kind === 'assistant') {
          assistant = message
          assistant.process ??= []
          pending = []
          folded.push(message)
          continue
        }
        if (message.kind !== 'tool' && message.kind !== 'tool-result') {
          folded.push(message)
          continue
        }
        if (assistant === null) {
          folded.push(message)
          continue
        }
        changed = true
        if (message.kind === 'tool') {
          const [name = '工具调用', ...argumentLines] = message.text.split('\n')
          const entry = { callId: `legacy-${assistant.process.length}`, name, arguments: truncateToolText(argumentLines.join('\n')), result: null, error: null }
          pending.push(entry)
          assistant.process.push(entry)
        } else {
          const entry = pending.shift() ?? (() => {
            const orphan = { callId: `legacy-orphan-${assistant.process.length}`, name: '工具调用', arguments: null, result: null, error: null }
            assistant.process.push(orphan)
            return orphan
          })()
          entry.result = truncateToolText(message.text)
        }
      }
      thread.messages = folded
    }
  }
  return changed
}

/**
 * Complete the revision space on load.
 *
 * Two things have to hold for cursors to work. Every item needs a revision: a
 * store written before revisions existed has none anywhere, and since a cursor
 * of 0 means "I hold nothing", an unstamped thread reads as unchanged
 * (`0 <= 0`) and a freshly opened canvas would come up empty — the whole history
 * invisible. And `state.rev` — the space cursors live in — must be at least the
 * highest revision on disk, or a counter that restarted from 0 would hand out
 * revisions colliding with existing ones, which an incremental reader would
 * never be sent.
 *
 * A thread's revision is forced to the highest in that thread: it is the value a
 * reader stores as its cursor, so it must never sit below a message it contains.
 */
function stampMissingRevs(state) {
  let rev = Number.isSafeInteger(state.rev) && state.rev >= 0 ? state.rev : 0
  let stamped = false
  const next = () => { rev += 1; return rev }
  for (const workspace of state.workspaces ?? []) {
    for (const thread of workspace.threads ?? []) {
      let highest = Number.isSafeInteger(thread.rev) && thread.rev > 0 ? thread.rev : 0
      for (const message of thread.messages ?? []) {
        if (!Number.isSafeInteger(message.rev) || message.rev <= 0) {
          message.rev = next()
          stamped = true
        }
        if (message.rev > highest) highest = message.rev
      }
      if (highest === 0) {
        highest = next()
        stamped = true
      }
      if (highest > rev) rev = highest
      if (thread.rev !== highest) {
        thread.rev = highest
        stamped = true
      }
    }
  }
  return { rev, stamped }
}

function positionOf(value) {
  const x = Number(value?.x)
  const y = Number(value?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new InputError('position 必须包含有效坐标')
  return { x: Math.round(Math.max(-2000, Math.min(5000, x))), y: Math.round(Math.max(-2000, Math.min(5000, y))) }
}

function requiredText(value, maxLength, field) {
  if (typeof value !== 'string') throw new InputError(`${field} 必须是文本`)
  const text = value.trim()
  if (text.length === 0) throw new InputError(`${field} 不能为空`)
  if (text.length > maxLength) throw new InputError(`${field} 超过长度限制`)
  return text
}

function projectableEvent(event) {
  switch (event.type) {
    case 'user/message': {
      const text = contentText(event.data.content)
      return isRuntimeContextText(text) ? null : noteProjection('user', text)
    }
    case 'assistant/message':
      return noteProjection('assistant', contentText(event.data?.message?.content))
    case 'todo/write':
      return noteProjection('todo', Array.isArray(event.data?.todos) ? event.data.todos.map(todo => `[${todo.status}] ${todo.content}`).join('\n') : '')
    case 'turn/end': {
      const reason = event.data?.reason
      if (reason?.kind === 'error') return noteProjection('error', errorText(reason.error) ?? '本轮执行失败')
      if (reason?.kind === 'cancelled' || reason?.kind === 'canceled' || reason?.kind === 'aborted') return noteProjection('error', '本轮已取消')
      return null
    }
    default:
      return /(?:error|failed|failure|cancel(?:led)?|abort)/i.test(event.type)
        ? noteProjection('error', errorText(event.data?.error ?? event.data?.reason ?? event.data) ?? 'Harness 运行失败')
        : null
  }
}

function errorText(value) {
  if (typeof value === 'string') return value.trim() || null
  if (value === null || value === undefined || typeof value !== 'object') return null
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : ''
  const code = typeof value.code === 'string' && value.code.trim() !== '' ? value.code.trim() : ''
  const message = typeof value.message === 'string' && value.message.trim() !== '' ? value.message.trim() : ''
  if (message !== '') return [name, code].filter(Boolean).concat(message).join(': ')
  return [name, code].filter(Boolean).join(': ') || null
}

function noteProjection(kind, text) {
  const normalized = text.trim()
  if (normalized === '') return null
  if (normalized.length <= MAX_PROJECTION_LENGTH) return { kind, text: normalized }
  return { kind, text: `${normalized.slice(0, MAX_PROJECTION_LENGTH)}${PROJECTION_TRUNCATED_SUFFIX}` }
}

function isRuntimeContextText(text) {
  return typeof text === 'string' && text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')
}

function isRuntimeContextMessage(message) {
  return message?.kind === 'user' && isRuntimeContextText(message.text)
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (block?.type === 'text') return [block.text]
    if (block?.type === 'tool-call') return [block.name, block.arguments]
    if (block?.type === 'tool-result') return contentText(block.content)
    return []
  }).filter(value => typeof value === 'string' && value.trim() !== '').join('\n')
}

function titleFromText(text) {
  const line = text.replaceAll(/\s+/g, ' ').trim()
  return (line.length > 42 ? `${line.slice(0, 42)}...` : line) || 'DSH 会话'
}

/**
 * agent-teams (and the harness beneath it) inject agent traffic into the host
 * session as plain text. Four shapes exist in the wild:
 *   Agent <uuid> sent a message:【发送者 → 接收者】正文      (member relay)
 *   Agent <uuid> sent a message:正文                        (route-less relay)
 *   AgentTeams message from member <name>: 正文              (member → captain)
 *   Background subagent <uuid> finished … Its closing message: 正文
 * Structuring them at projection time is what lets the canvas show a turn as
 * a real multi-agent conversation (who spoke to whom) instead of protocol
 * text with a raw UUID in it — for questions and answers alike.
 */
const RELAY_ROUTE_RE = /^Agent\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+sent a message:\s*【([^】\n]*)】\s*/
const RELAY_PLAIN_RE = /^Agent\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+sent a message:\s*/
const MEMBER_RELAY_RE = /^AgentTeams message from member\s+([^:：\n]+)[:：]\s*/
const SUBAGENT_NOTICE_RE = /^Background subagent\s+([0-9a-f][0-9a-f-]{8,})\s+/
const SUBAGENT_CLOSING_RE = /Its closing message:\s*/

function classifyAgentText(text) {
  if (typeof text !== 'string') return null
  let match = RELAY_ROUTE_RE.exec(text)
  if (match !== null) {
    const route = match[2].split(/→|->/)
    const from = (route[0] ?? '').trim()
    const to = (route[1] ?? '').trim()
    if (from !== '' || to !== '') return { kind: 'relay', agentId: match[1], from: from || '成员', to, text: text.slice(match[0].length).trim() }
  }
  match = MEMBER_RELAY_RE.exec(text)
  if (match !== null) {
    const from = match[1].trim()
    if (from !== '') return { kind: 'relay', agentId: null, from, to: '队长', text: text.slice(match[0].length).trim() }
  }
  match = SUBAGENT_NOTICE_RE.exec(text)
  if (match !== null) {
    let body = text.slice(match[0].length)
    let label = '子代理通知'
    const closing = SUBAGENT_CLOSING_RE.exec(body)
    if (closing !== null) {
      label = '子代理完成汇报'
      body = body.slice(closing.index + closing[0].length)
    }
    return { kind: 'notice', agentId: match[1], from: '子代理', to: '', label, text: body.trim() }
  }
  match = RELAY_PLAIN_RE.exec(text)
  if (match !== null) {
    return { kind: 'relay', agentId: match[1], from: `agent ${match[1].slice(0, 8)}`, to: '', text: text.slice(match[0].length).trim() }
  }
  return null
}

function sessionCwd(session) {
  const cwd = session.header?.meta?.cwd ?? session.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '未指定工作目录'
}

function workspaceTitle(cwd, fallbackTitle) {
  if (cwd === '未指定工作目录') return fallbackTitle
  const segment = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
  return segment && segment.trim() !== '' ? segment : fallbackTitle
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > maxBytes) throw new InputError(`请求内容过大（上限 ${Math.round(maxBytes / 1024)}KB）`)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new InputError('请求不是有效 JSON') }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendFile(res, contentType, body, etag) {
  // `no-cache`, not `no-store`: it still forces a revalidation on every request,
  // so a changed file is never served stale — but unlike `no-store` it lets the
  // browser keep the response and revalidate it, which is the only way the ETag
  // below ever produces a 304. With `no-store` the browser is forbidden from
  // storing the response at all, so it has nothing to revalidate and never
  // sends If-None-Match: the 304 branch was unreachable.
  // A response carrying an ETag came from the static cache, which can serve a
  // gzip or an identity variant of the same URL — so it must declare that it
  // varies by Accept-Encoding. (Both variants share one ETag, so without Vary a
  // cache could hand the gzip body to a client that never asked for gzip.)
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache', ...(etag ? { etag, vary: 'accept-encoding' } : {}) })
  // HEAD shares the headers without the payload.
  res.end(res.req?.method === 'HEAD' ? undefined : body)
}
/** The unified agent canvas: one page, one engine, one graph. */
function canvasPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>智能体画布</title><link rel="stylesheet" href="/dsh-flow/theme.css"></head><body><div id="app"></div><script src="/dsh-flow/engine.js"></script><script type="module" src="/dsh-flow/src/canvas/canvas.js"></script></body></html>`
}

// Deliberately explicit — this list is also the serve allowlist, so it must not
// be auto-widened. The cost is that adding a module means adding it here too;
// forgetting silently 404s the import and the canvas never boots.
//
// Two layers are served: the pure rules core, which the canvas imports directly,
// and the canvas modules themselves. Everything else under `src/` is host-only
// and is asserted out of this list by `scripts/check.js`.
const CANVAS_SRC_FILES = ['rules/index.js', 'rules/constants.js', 'rules/sha256.js', 'rules/identifiers.js', 'rules/entities.js', 'rules/dependencies.js', 'rules/mailbox.js', 'rules/paths.js', 'rules/gates.js', 'rules/completion.js', 'rules/delivery.js', 'rules/coverage.js', 'rules/followup.js', 'rules/profiles.js', 'rules/events.js', 'rules/project.js', 'rules/reconcile.js', 'rules/plan.js', 'rules/manifest.js', 'rules/tool-names.js', 'rules/fallback.js', 'rules/model-route.js', 'rules/assignment.js', 'rules/attempts.js', 'rules/retired.js', 'canvas/core.js', 'canvas/html.js', 'canvas/markdown.js', 'canvas/relay.js', 'canvas/session.js', 'canvas/teams.js', 'canvas/scene.js', 'canvas/view.js', 'canvas/actions.js', 'canvas/canvas.js', 'canvas/artwork.js']

/**
 * Mount the dsh-flow routes on the existing DSH Web Server: the unified canvas
 * page plus its workspace API. The old per-layer paths (/dsh-flow/map/) remain
 * as redirects so stale links and saved routes land on the unified canvas.
 */
export function apply(ctx, config) {
  const store = new WorkspaceStore(config?.dataFile)
  // Two teardown paths, because they cover different exits: the process 'exit'
  // handler catches process.exit() (and the end of a drained event loop), while
  // the effect cleanup catches the host disposing just this plugin. Both flush
  // the debounced window synchronously — an async flush would be cut short.
  ctx.effect(() => {
    store.watchExit()
    return () => { store.unwatchExit(); store.flushSync() }
  }, 'dsh-flow: flush the debounced write on teardown')

  // The team kernel: the store, the executor and the tools. Mounted here so a
  // deployment that only wants the canvas can say `runner: 'manual'` rather
  // than not load the plugin — the choice is configuration, not a second build.
  //
  // A mount that fails must not take the canvas down with it: the canvas is how
  // a human sees that something is wrong, so the failure is reported and the
  // routes are served against an empty set rather than not served at all.
  let kernel
  try {
    kernel = installFlowKernel(ctx, {
      stateDir: config?.stateDir ?? '.dsh-flow',
      profiles: config?.profiles,
      maxMembers: config?.maxMembers,
      runner: config?.runner ?? 'subagents',
      captainPrompt: config?.captainPrompt,
      executionPrompt: config?.executionPrompt,
      memberProvider: config?.memberProvider,
    })
  } catch (error) {
    ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
  }

  const autoProjection = config?.autoProjection !== false
  const projectionWorkspaceTitle = typeof config?.projectionWorkspaceTitle === 'string' && config.projectionWorkspaceTitle.trim() !== ''
    ? config.projectionWorkspaceTitle.trim().slice(0, MAX_TITLE_LENGTH)
    : 'DSH 任务'
  // A write that keeps failing — a read-only data directory, a full disk — would
  // otherwise log once per projected event, i.e. per turn event, flooding the
  // host's log with the same line. Keep the first failure intact (its stack is
  // the useful part), then at most one per window, carrying a count of what was
  // folded into it so the situation stays visible instead of merely quieter.
  let lastFailureLogAt = 0
  let suppressedFailures = 0
  const reportProjectionFailure = error => {
    const now = Date.now()
    if (now - lastFailureLogAt < FAILURE_LOG_WINDOW_MS) {
      suppressedFailures += 1
      return
    }
    const reported = error instanceof Error ? error : new Error(String(error))
    const suppressed = suppressedFailures
    lastFailureLogAt = now
    suppressedFailures = 0
    ctx.logger.warn(suppressed === 0 ? reported : new Error(`${reported.message}（同一窗口内另有 ${suppressed} 次失败未单独记录）`))
  }
  const replaySession = session => {
    // Forks inherit their parent's log. The canvas already represents that
    // history through the parent node, so only project the child's live tail.
    const replayFrom = session.header?.parentSession === undefined ? 0 : session.firstLiveSeq
    void store.projectSession(session, replayFrom, projectionWorkspaceTitle).catch(reportProjectionFailure)
  }
  // Buffer live events per session and flush them in one write per microtask,
  // so a burst of turn events coalesces into a single save instead of N.
  const projectionQueue = []
  let projectionScheduled = false
  const enqueueProjection = (session, event) => {
    projectionQueue.push({ session, event })
    if (projectionScheduled) return
    projectionScheduled = true
    queueMicrotask(() => {
      projectionScheduled = false
      const batch = projectionQueue.splice(0)
      const bySession = new Map()
      for (const item of batch) {
        const entry = bySession.get(item.session.id)
        if (entry === undefined) bySession.set(item.session.id, [item.session, [item.event]])
        else entry[1].push(item.event)
      }
      for (const [sessionId, [session, events]] of bySession) {
        void store.projectEvents(session, events, projectionWorkspaceTitle).catch(reportProjectionFailure)
      }
    })
  }
  if (autoProjection) {
    ctx.on('session/created', replaySession)
    ctx.on('session/event', enqueueProjection)
    for (const session of ctx.sessions.list()) replaySession(session)
  }
  // The DSH /api browser-trust fence does not cover /dsh-flow routes, so this
  // handler checks the Host header itself: localhost is allowed by default and
  // additional authorities opt in through config.trustedHosts (mirrors the
  // fence's DNS-rebinding defense).
  const trustedHosts = new Set(['localhost', '127.0.0.1', ...[...(config?.trustedHosts ?? [])].map(host => String(host).trim().toLowerCase()).filter(Boolean)])
  const api = async (req, res) => {
    try {
      const hostname = (typeof req.headers.host === 'string' ? req.headers.host : '').replace(/:\d+$/, '').toLowerCase()
      if (!trustedHosts.has(hostname)) return sendJson(res, 403, { error: '不被信任的 Host' })
      const path = new URL(req.url ?? '/', 'http://dsh.local').pathname
      if (path === '/dsh-flow/map-api/reset' && req.method === 'POST') return sendJson(res, 200, await store.clearLegacy(ctx.sessions.list()))
      if (path === '/dsh-flow/map-api/workspaces') {
        if (req.method === 'GET') return sendJson(res, 200, { workspaces: await store.list() })
        if (req.method === 'POST') return sendJson(res, 201, { workspace: await store.create((await readJson(req)).title) })
      }
      const workspace = /^\/dsh-flow\/map-api\/workspaces\/([0-9a-f-]+)$/i.exec(path)
      if (workspace !== null) {
        if (req.method === 'GET') return sendJson(res, 200, { workspace: await store.get(workspace[1]) })
        if (req.method === 'POST') return sendJson(res, 201, { thread: await store.createThread(workspace[1], await readJson(req)) })
      }
      const branch = /^\/dsh-flow\/map-api\/threads\/([0-9a-f-]+)\/branch$/i.exec(path)
      if (branch !== null && req.method === 'POST') return sendJson(res, 201, { thread: await store.branch(branch[1], await readJson(req)) })
      if (path === '/dsh-flow/map-api/sessions/sync' && req.method === 'POST') { const body = await readJson(req); return sendJson(res, 200, { workspaces: await store.syncSessions(body.sessions, body.removedSessionIds) }) }
      // The canvas' incremental read: POST because the cursor map grows with the
      // number of threads the caller already holds.
      if (path === '/dsh-flow/map-api/projection' && req.method === 'POST') {
        const body = await readJson(req)
        return sendJson(res, 200, await store.projection(body?.sessionIds, body?.cursors))
      }
      const messages = /^\/dsh-flow\/map-api\/threads\/([0-9a-f-]+)\/messages$/i.exec(path)
      if (messages !== null && req.method === 'POST') return sendJson(res, 201, { thread: await store.addMessage(messages[1], (await readJson(req)).text) })
      const thread = /^\/dsh-flow\/map-api\/threads\/([0-9a-f-]+)$/i.exec(path)
      if (thread !== null && req.method === 'PATCH') return sendJson(res, 200, { thread: await store.updateThread(thread[1], await readJson(req)) })
      if (thread !== null && req.method === 'DELETE') return sendJson(res, 200, await store.removeThread(thread[1]))
      // The teams the canvas renders, read from dsh-flow's own store.
      //
      // This used to be a mirror: the canvas polled agent-teams' live feed and
      // POSTed a copy back here, so the regions kept rendering after that
      // plugin was removed. It is a read now, because the store has been the
      // source since the kernel was mounted — and a mirror of a foreign feed
      // would be a second record of a team, able to disagree with the log.
      if (path === '/dsh-flow/map-api/teams' && req.method === 'GET') {
        if (kernel === undefined) return sendJson(res, 200, { teams: [] })
        return sendJson(res, 200, await canvasSnapshot(kernel.sources, {
          onMalformedLine: (teamId, memberName, line, error) => ctx.logger.warn(
            `dsh-flow: ${teamId}/${memberName} mailbox line ${line}: ${error.message}`,
          ),
        }))
      }
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      if (error instanceof InputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message })
      ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      return sendJson(res, 500, { error: '会话地图数据暂时不可用' })
    }
  }
  const redirect = location => (_req, res) => { res.writeHead(302, { location }); res.end() }
  // Static files — pages, modules, stylesheets and portraits alike — are read
  // from disk once and cached by mtime: repeated page loads stop hitting the
  // filesystem for every asset. One cache serves both routes; the key is the
  // asset's own identity, never the request.
  const staticCache = new Map()
  const cachedBody = async (key, path, compress) => {
    const cached = staticCache.get(key)
    const mtimeMs = (await stat(path)).mtimeMs
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached
    const body = await readFile(path)
    // Async: gzipSync blocked the event loop for the whole compression, and this
    // runs on the request path the first time each file is asked for (and again
    // whenever one changes). The win is small in absolute terms — the text
    // assets total ~155KB — but it is the same "keep the main thread free" rule
    // the write path already follows.
    const entry = { mtimeMs, body, gzip: compress ? await gzip(body) : null }
    staticCache.set(key, entry)
    return entry
  }
  /** mtime + length: changes exactly when the bytes do, and needs no hashing. */
  const etagOf = entry => `"${entry.mtimeMs.toString(36)}-${entry.body.length.toString(36)}"`
  const file = (contentType, name) => async (_req, res) => {
    let entry
    try {
      entry = await cachedBody(name, new URL(name, import.meta.url), contentType.includes('text'))
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    const etag = etagOf(entry)
    if (_req.headers['if-none-match'] === etag) {
      // A 304 repeats the headers a 200 would have carried, so a cache keys the
      // revalidated entry the same way.
      res.writeHead(304, { etag, vary: 'accept-encoding', 'cache-control': 'no-cache' })
      return res.end()
    }
    if (entry.gzip !== null && (_req.headers['accept-encoding'] ?? '').includes('gzip')) {
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache', etag, 'content-encoding': 'gzip', vary: 'accept-encoding' })
      return res.end(entry.gzip)
    }
    sendFile(res, contentType, entry.body.toString('utf8'), etag)
  }
  // Static pages are behind the same Host fence as the API: the DSH browser-trust
  // fence only covers /api, so a missing check here would expose these to
  // DNS-rebinding probes from a hostile origin.
  const serve = (req, res, handler) => {
    const hostname = (typeof req.headers.host === 'string' ? req.headers.host : '').replace(/:\d+$/, '').toLowerCase()
    if (!trustedHosts.has(hostname)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ error: '不被信任的 Host' }))
    }
    return handler(req, res)
  }
  const route = (kind, path, handler, label) => ctx.effect(() => ctx.webServer.register({ kind, path, handler: (req, res) => serve(req, res, handler) }), `dsh-flow: ${label}`)

  // Unified canvas.
  route('exact', '/dsh-flow', redirect('/dsh-flow/'), 'canvas redirect')
  route('exact', '/dsh-flow/', (_req, res) => sendFile(res, 'text/html; charset=utf-8', canvasPage()), 'canvas page')
  route('exact', '/dsh-flow/engine.js', file('text/javascript; charset=utf-8', './engine.js'), 'canvas engine')
  for (const name of CANVAS_SRC_FILES) {
    route('exact', `/dsh-flow/src/${name}`, file('text/javascript; charset=utf-8', `./src/${name}`), `canvas src ${name}`)
  }
  route('exact', '/dsh-flow/theme.css', file('text/css; charset=utf-8', './theme.css'), 'canvas styles')
  // Character portraits for the team inspector (exact .png names only).
  route('prefix', '/dsh-flow/assets', (req, res) => {
    const name = new URL(req.url ?? '/', 'http://dsh.local').pathname.slice('/dsh-flow/assets/'.length)
    if (!/^[a-z0-9-]+\.png$/i.test(name)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    // Portraits are 1.5–1.9MB each, so serving them reads from disk once and
    // then serves the cached buffer: 15 files, cached forever by mtime. No
    // gzip — PNG is already compressed.
    cachedBody(`assets/${name}`, new URL(`./assets/${name}`, import.meta.url), false).then(
      entry => {
        const etag = etagOf(entry)
        // `max-age` is what keeps the portraits off the wire during a session;
        // the ETag is what keeps the request after it expires cheap. 15 portraits
        // at 1.5MB each means an expiry without a validator re-downloads ~22MB,
        // where a revalidation costs one stat and a 304.
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag, 'cache-control': 'max-age=3600' })
          return res.end()
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600', etag })
        res.end(entry.body)
      },
      () => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      },
    )
  }, 'canvas portraits')
  // Legacy layer paths: both layers now live at /dsh-flow/.
  route('exact', '/dsh-flow/map', redirect('/dsh-flow/'), 'legacy map redirect')
  route('exact', '/dsh-flow/map/', redirect('/dsh-flow/'), 'legacy map redirect')
  route('prefix', '/dsh-flow/map-api', api, 'map api')
}
