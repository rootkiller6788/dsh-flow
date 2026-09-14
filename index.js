import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export const name = 'dsh-flow'
export const inject = ['webServer', 'sessions']

const MAX_BODY_BYTES = 32 * 1024
const MAX_TITLE_LENGTH = 120
const MAX_NOTE_LENGTH = 4_000
// Projected message text cap: longer replies truncate with a marker pointing
// at the detail view instead of silently cutting mid-sentence.
const MAX_PROJECTION_LENGTH = 8_000
const PROJECTION_TRUNCATED_SUFFIX = '\n——…（详情查看全文）'
const TOPIC_COLORS = ['#0f766e', '#0e7490', '#6d28d9', '#b45309', '#be123c']
const LOCK_STALE_MS = 60_000
// Deferred (event-projection) writes coalesce into one save per window, so a
// burst of session events costs a single full-state write instead of one per
// event (issue #13: per-event saves pinned the main thread at ~90% CPU).
const SAVE_DEBOUNCE_MS = 800

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
        if (this.state.hiddenSessionIds.includes(item.id)) continue
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
      const removal = new Set([thread.id])
      for (let changed = true; changed;) {
        changed = false
        for (const item of workspace.threads) {
          if (item.parentId !== null && removal.has(item.parentId) && !removal.has(item.id)) { removal.add(item.id); changed = true }
        }
      }
      for (const item of workspace.threads) {
        if (removal.has(item.id) && item.dshSessionId !== null && !this.state.hiddenSessionIds.includes(item.dshSessionId)) this.state.hiddenSessionIds.push(item.dshSessionId)
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
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, 'utf8'))
      const { state, migrated } = normalizeState(parsed)
      this.state = state
      if (migrated) await this.save()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`dsh-flow: cannot read ${this.dataFile}: ${error.message}`)
      this.state = { version: 4, hiddenSessionIds: [], workspaces: [] }
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
    // state. Warn loudly instead of silently losing work; a live lock held by
    // another process or a file mtime that moved since our last write both
    // indicate a second writer.
    const before = await this.fileMtime()
    if (this.lastKnownMtime !== null && before !== null && before !== this.lastKnownMtime) {
      this.lastKnownMtime = before
      if (!this.externalModWarned) {
        this.externalModWarned = true
        process.stderr.write('dsh-flow: workspaces.json 已被另一个 dsh web 实例修改，本实例的写入可能覆盖其更改——请只运行一个实例\n')
      }
    }
    await this.acquireLock()
    try {
      const temporaryFile = `${this.dataFile}.${process.pid}.tmp`
      await writeFile(temporaryFile, `${JSON.stringify(this.state)}\n`, 'utf8')
      await rename(temporaryFile, this.dataFile)
      this.lastKnownMtime = (await stat(this.dataFile)).mtimeMs
    } finally {
      await this.releaseLock()
    }
  }

  async fileMtime() {
    try { return (await stat(this.dataFile)).mtimeMs } catch { return null }
  }

  /** Take an exclusive cross-process lock, breaking a stale one; warn when a live process holds it. */
  async acquireLock() {
    const lockFile = `${this.dataFile}.lock`
    if (await this.tryAcquire(lockFile)) return
    if (await this.lockIsStale(lockFile)) {
      await unlink(lockFile).catch(() => {})
      if (await this.tryAcquire(lockFile)) return
    }
    if (!this.lockWarned) {
      this.lockWarned = true
      process.stderr.write('dsh-flow: 另一个 dsh web 实例正在写入 workspaces.json——请只运行一个实例，否则画布数据可能互相覆盖\n')
    }
  }

  async tryAcquire(lockFile) {
    try {
      await writeFile(lockFile, `${process.pid}\n`, { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }

  /** A lock is stale when its owner PID is gone or the lock file is older than the stale window. */
  async lockIsStale(lockFile) {
    try {
      const [content, stats] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)])
      const tooOld = Date.now() - stats.mtimeMs > LOCK_STALE_MS
      const pid = Number.parseInt(content, 10)
      if (!Number.isInteger(pid)) return tooOld
      if (pid === process.pid) return false
      try {
        process.kill(pid, 0)
        return tooOld
      } catch {
        return true
      }
    } catch {
      return false
    }
  }

  async releaseLock() {
    await unlink(`${this.dataFile}.lock`).catch(() => {})
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
      if (typeof session.title === 'string' && session.title.trim() !== '') {
        const title = session.title.slice(0, MAX_TITLE_LENGTH)
        thread.title = title
        thread.dshSessionTitle = title
      }
      // `seedLength` is DSH's durable fork cut. Keep it even after the
      // session has been restored, when its in-process `firstLiveSeq` moves.
      const seedLength = session.header?.seedLength
      if (Number.isSafeInteger(seedLength) && seedLength >= 0) thread.sourceSeedLength = seedLength
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
    // A child may arrive before its parent during startup replay. Repair that
    // relation when the missing parent later reaches the projection.
    for (const child of workspace.threads) {
      if (child.sourceParentSessionId === session.id && child.parentId === null) child.parentId = thread.id
    }
    workspace.updatedAt = now
    return thread
  }

  projectEventInto(workspace, thread, event) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      thread.title = event.data.title.slice(0, MAX_TITLE_LENGTH)
      thread.dshSessionTitle = thread.title
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
    if (projection === null || thread.messages.some(message => message.sourceSeq === event.seq)) return
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
    thread.messages.push(message)
    thread.updatedAt = at
    workspace.updatedAt = at
    if (thread.dshSessionTitle === null && projection.kind === 'user' && message.agent === undefined) {
      thread.title = titleFromText(message.text)
      thread.dshSessionTitle = thread.title
    }
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
    const target = [...thread.messages].reverse().find(message =>
      (message.kind === 'assistant' || message.kind === 'error')
      && (message.turn === data.turn && message.step === data.step
        || message.turn === undefined && message.step === undefined))
    const process = target === undefined ? (thread.pendingProcess ??= []) : (target.process ??= [])
    const callId = String(event.type === 'tool/call' ? data.callId : data.message?.source?.callId ?? '')
    const entry = process.find(item => item.callId === callId)
    if (event.type === 'tool/call') {
      if (entry === undefined) {
        process.push({ callId, turn: data.turn, step: data.step, name: data.name, arguments: data.arguments, result: null, error: null })
      } else {
        entry.name = data.name
        entry.arguments = data.arguments
      }
    } else {
      const outcome = contentText(data.message?.content)
      const error = errorText(data.error)
      if (entry === undefined) {
        process.push({ callId, turn: data.turn, step: data.step, name: '工具调用', arguments: null, result: outcome, error })
      } else {
        entry.result = outcome
        entry.error = error
      }
    }
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
          const entry = { callId: `legacy-${assistant.process.length}`, name, arguments: argumentLines.join('\n'), result: null, error: null }
          pending.push(entry)
          assistant.process.push(entry)
        } else {
          const entry = pending.shift() ?? (() => {
            const orphan = { callId: `legacy-orphan-${assistant.process.length}`, name: '工具调用', arguments: null, result: null, error: null }
            assistant.process.push(orphan)
            return orphan
          })()
          entry.result = message.text
        }
      }
      thread.messages = folded
    }
  }
  return changed
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

async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new InputError('请求内容过大')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new InputError('请求不是有效 JSON') }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendFile(res, contentType, body, etag) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store', ...(etag ? { etag } : {}) })
  // HEAD shares the headers without the payload.
  res.end(res.req?.method === 'HEAD' ? undefined : body)
}

/** The unified agent canvas: one page, one engine, one graph. */
function canvasPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>智能体画布</title><link rel="stylesheet" href="/dsh-flow/theme.css"></head><body><div id="app"></div><script src="/dsh-flow/engine.js"></script><script type="module" src="/dsh-flow/src/canvas.js"></script></body></html>`
}

const CANVAS_SRC_FILES = ['core.js', 'markdown.js', 'relay.js', 'session.js', 'teams.js', 'scene.js', 'view.js', 'actions.js', 'canvas.js', 'artwork.js']

/**
 * Mount the dsh-flow routes on the existing DSH Web Server: the unified canvas
 * page plus its workspace API. The old per-layer paths (/dsh-flow/map/) remain
 * as redirects so stale links and saved routes land on the unified canvas.
 */
export function apply(ctx, config) {
  const store = new WorkspaceStore(config?.dataFile)
  const teamsFile = join(dirname(config?.dataFile ?? '.'), 'teams.json')
  const autoProjection = config?.autoProjection !== false
  const projectionWorkspaceTitle = typeof config?.projectionWorkspaceTitle === 'string' && config.projectionWorkspaceTitle.trim() !== ''
    ? config.projectionWorkspaceTitle.trim().slice(0, MAX_TITLE_LENGTH)
    : 'DSH 任务'
  const reportProjectionFailure = error => {
    ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
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
      const messages = /^\/dsh-flow\/map-api\/threads\/([0-9a-f-]+)\/messages$/i.exec(path)
      if (messages !== null && req.method === 'POST') return sendJson(res, 201, { thread: await store.addMessage(messages[1], (await readJson(req)).text) })
      const thread = /^\/dsh-flow\/map-api\/threads\/([0-9a-f-]+)$/i.exec(path)
      if (thread !== null && req.method === 'PATCH') return sendJson(res, 200, { thread: await store.updateThread(thread[1], await readJson(req)) })
      if (thread !== null && req.method === 'DELETE') return sendJson(res, 200, await store.removeThread(thread[1]))
      // Team snapshot storage: the canvas polls the live agent-teams feed and
      // mirrors it here, so team regions keep rendering even after the
      // agent-teams plugin is removed (its data is frozen, not live).
      if (path === '/dsh-flow/map-api/teams' && req.method === 'GET') {
        try {
          const stored = JSON.parse(await readFile(teamsFile, 'utf8'))
          return sendJson(res, 200, { teams: Array.isArray(stored.teams) ? stored.teams : [] })
        } catch {
          return sendJson(res, 200, { teams: [] })
        }
      }
      if (path === '/dsh-flow/map-api/teams/snapshot' && req.method === 'POST') {
        const body = await readJson(req)
        if (!Array.isArray(body?.teams)) throw new InputError('teams 必须是数组')
        const temporaryFile = `${teamsFile}.${process.pid}.tmp`
        await writeFile(temporaryFile, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), teams: body.teams })}
`, 'utf8')
        await rename(temporaryFile, teamsFile)
        return sendJson(res, 200, { stored: body.teams.length })
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
  // Static files are read from disk once and cached by mtime: repeated page
  // loads stop hitting the filesystem for every asset.
  const staticCache = new Map()
  const file = (contentType, name) => async (_req, res) => {
    const path = new URL(name, import.meta.url)
    let entry = staticCache.get(name)
    try {
      const mtimeMs = (await stat(path)).mtimeMs
      if (entry === undefined || entry.mtimeMs !== mtimeMs) {
        const body = await readFile(path)
        entry = { mtimeMs, body, gzip: contentType.includes('text') ? zlib.gzipSync(body) : null }
        staticCache.set(name, entry)
      }
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    const etag = `"${entry.mtimeMs.toString(36)}-${entry.body.length.toString(36)}"`
    if (_req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag })
      return res.end()
    }
    if (entry.gzip !== null && (_req.headers['accept-encoding'] ?? '').includes('gzip')) {
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store', etag, 'content-encoding': 'gzip' })
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
    readFile(new URL(`./assets/${name}`, import.meta.url)).then(
      png => {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' })
        res.end(png)
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
