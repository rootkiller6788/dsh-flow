// dsh-flow canvas — see src/canvas.js for the module map.
import { state, api, turnPositions, canReplaceView, persistCollapsedCards, TURN_W, TURN_H, TURN_STEP_X } from './core.js'
import { relayOf } from './relay.js'
import { render } from './view.js'


// ---------------------------------------------------------------------------
// Session data layer (projection)
// ---------------------------------------------------------------------------
function currentDshWorkspace() {
  const id = state.currentDsh?.id
  return typeof id === 'string' ? state.dshWorkspaces.find(workspace => workspace.sessionIds.includes(id)) : undefined
}
function selectedDshWorkspace() {
  return state.dshWorkspaces.find(workspace => workspace.id === state.selectedDshWorkspaceId)
}
function currentDshThread(threads = state.workspace?.threads ?? []) {
  const id = state.currentDsh?.id
  return typeof id === 'string' ? threads.find(thread => thread.dshSessionId === id) : undefined
}
async function threadsForDshWorkspace(workspace) {
  if (workspace.sessionIds.length === 0) return []
  const requested = new Set(workspace.sessionIds)
  const projections = await Promise.all(state.summaries.map(summary => api(`/dsh-flow/map-api/workspaces/${summary.id}`)))
  return projections.flatMap(projection => projection.workspace.threads.filter(thread => requested.has(thread.dshSessionId)))
}
async function openDshWorkspace(id, { renderAfter = true, preserveCamera = false } = {}) {
  const workspace = state.dshWorkspaces.find(item => item.id === id)
  if (workspace === undefined) return false
  const load = ++state.workspaceLoad
  state.selectedDshWorkspaceId = id
  const threads = await threadsForDshWorkspace(workspace)
  if (load !== state.workspaceLoad) return true
  if (state.workspace?.id !== `dsh:${workspace.id}` && !preserveCamera) state.needsCenter = true
  state.workspace = { id: `dsh:${workspace.id}`, title: workspace.title, cwd: workspace.path, threads }
  const currentThread = currentDshThread(state.workspace.threads)
  state.activeId = currentThread?.id ?? (state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null)
  if (currentThread !== undefined) revealConversationThread(conversationCards(state.workspace.threads), currentThread.id)
  if (renderAfter && canReplaceView()) render()
  if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
  return true
}
async function openCurrentWorkspace({ preserveCamera = false } = {}) {
  const workspace = currentDshWorkspace()
  if (workspace === undefined || workspace.id === state.selectedDshWorkspaceId) return false
  return openDshWorkspace(workspace.id, { preserveCamera })
}
async function refreshSummaries({ renderAfter = true } = {}) {
  const before = JSON.stringify(state.summaries)
  const body = await api('/dsh-flow/map-api/workspaces')
  state.summaries = body.workspaces
  const changed = before !== JSON.stringify(state.summaries)
  const current = state.workspace?.id
  if (state.selectedDshWorkspaceId === null && current !== null && !state.summaries.some(item => item.id === current)) state.workspace = null
  const selected = selectedDshWorkspace()
  if (selected !== undefined && (changed || state.workspace === null)) await openDshWorkspace(selected.id, { renderAfter })
  else if (state.workspace === null && state.summaries.length > 0) await openWorkspace(state.summaries[0].id)
  else if (renderAfter && changed && canReplaceView()) render()
  return changed
}
async function openWorkspace(id, { renderAfter = true } = {}) {
  const load = ++state.workspaceLoad
  const body = await api(`/dsh-flow/map-api/workspaces/${id}`)
  if (load !== state.workspaceLoad) return
  if (state.workspace?.id !== body.workspace.id) state.needsCenter = true
  state.workspace = body.workspace
  state.activeId = state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null
  if (renderAfter && canReplaceView()) render()
  if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
}
async function refreshProjection() {
  const summariesChanged = await refreshSummaries({ renderAfter: false })
  if (!summariesChanged || state.workspace === null || !canReplaceView()) return summariesChanged
  if (state.selectedDshWorkspaceId !== null) await openDshWorkspace(state.selectedDshWorkspaceId)
  else await openWorkspace(state.workspace.id)
  return true
}

function persistedMessagesFor(thread) { return thread.messages ?? [] }
function pendingUserIndex(messages, pending) {
  return messages.findLastIndex(message => message.kind === 'user' && message.text === pending.text && new Date(message.at).getTime() >= pending.at - 2_000)
}
function settlePendingReply(thread, messages) {
  const pending = state.pendingReplies.get(thread.dshSessionId)
  if (pending === undefined) return false
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex === -1 || !messages.slice(userIndex + 1).some(message => message.kind === 'assistant')) return false
  state.pendingReplies.delete(thread.dshSessionId)
  return true
}
function messagesFor(thread) {
  const messages = persistedMessagesFor(thread).filter(message => !(message.kind === 'user' && typeof message.text === 'string' && message.text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')))
  const pending = state.pendingReplies.get(thread.dshSessionId)
  if (pending === undefined) return messages
  if (settlePendingReply(thread, messages)) {
    state.liveReplies.delete(thread.dshSessionId)
    return messages
  }
  const liveReply = state.liveReplies.get(thread.dshSessionId)
  const liveAssistant = liveReply?.running ? { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() } : { kind: 'assistant', text: '', pending: true, at: new Date().toISOString() }
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex !== -1) return [...messages, liveAssistant]
  return [...messages, { kind: 'user', text: pending.text, pending: true, at: new Date(pending.at).toISOString() }, liveAssistant]
}
function latestMessage(thread, kind) { return [...messagesFor(thread)].reverse().find(message => message.kind === kind) }

// ---------------------------------------------------------------------------
// Turn cards (session layer of the graph)
// ---------------------------------------------------------------------------
function conversationCards(threads) {
  const cards = []
  const cardsByThread = new Map()
  for (const thread of threads) {
    const messages = messagesFor(thread)
    const turns = []
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const question = messages[messageIndex]
      if (question.kind !== 'user') continue
      const replies = []
      const errors = []
      let processCount = 0
      for (let replyIndex = messageIndex + 1; replyIndex < messages.length; replyIndex++) {
        const reply = messages[replyIndex]
        if (reply.kind === 'user') break
        if (reply.kind === 'assistant') replies.push(reply)
        if (reply.kind === 'error') errors.push(reply)
        if (Array.isArray(reply.process)) processCount += reply.process.length
        else if (reply.kind === 'tool') processCount += 1
      }
      const answer = replies.at(-1) ?? null
      const error = errors.at(-1) ?? null
      const turnIndex = turns.length
      const id = `${thread.id}:turn:${question.sourceSeq ?? messageIndex}`
      const previous = turns.at(-1)
      const positionKey = `${thread.id}:turn-index:${turnIndex}`
      const naturalPosition = previous === undefined ? { x: 86, y: 82 } : { x: previous.naturalPosition.x + TURN_STEP_X, y: previous.naturalPosition.y }
      const savedPosition = turnPositions.get(id) ?? turnPositions.get(positionKey)
      const positionLocked = savedPosition !== undefined
      const relay = answer === null ? null : relayOf(answer)
      const questionAgent = relayOf(question)
      turns.push({
        id,
        positionKey,
        kind: 'turn',
        dshThreadId: thread.id,
        sourceParentId: thread.parentId,
        parentId: null,
        sourceSeq: question.sourceSeq,
        turnIndex,
        naturalPosition,
        position: positionLocked ? savedPosition : naturalPosition,
        positionLocked,
        // A turn whose "question" is agent traffic (member relay, subagent
        // notice) is an agent event: the card shows a derived label, and the
        // full cleaned body stays available for the inspector bubble.
        agentEvent: questionAgent === null ? null : { kind: questionAgent.kind, from: questionAgent.from, to: questionAgent.to, label: questionAgent.title },
        question: questionAgent === null ? question.text : questionAgent.title,
        questionBody: questionAgent === null ? question.text : questionAgent.text,
        answer: answer === null ? null : {
          sourceSeq: answer.sourceSeq,
          pending: answer.pending === true,
          text: relay === null ? answer.text : relay.text,
          from: relay?.from ?? null,
          to: relay?.to ?? null,
        },
        error: error === null ? null : { text: error.text },
        processCount,
      })
    }
    const liveReply = state.liveReplies.get(thread.dshSessionId)
    const latestTurn = turns.at(-1)
    if (liveReply?.running && latestTurn !== undefined && (latestTurn.answer === null || latestTurn.answer.pending === true)) latestTurn.answer = { sourceSeq: undefined, pending: true, text: liveReply.text, from: null, to: null }
    if (turns.length === 0) {
      const id = `${thread.id}:turn:empty`
      const positionKey = `${thread.id}:turn-index:0`
      const naturalPosition = { x: 86, y: 82 }
      const savedPosition = turnPositions.get(id) ?? turnPositions.get(positionKey)
      turns.push({
        id, positionKey, kind: 'turn', dshThreadId: thread.id, sourceParentId: thread.parentId, parentId: null,
        sourceSeq: undefined, turnIndex: 0, naturalPosition, position: savedPosition ?? naturalPosition, positionLocked: savedPosition !== undefined,
        question: thread.dshSessionTitle ?? thread.title, answer: null, error: null, processCount: 0,
      })
    }
    turns.at(-1).canContinue = true
    cardsByThread.set(thread.id, turns)
    cards.push(...turns)
  }
  for (const card of cards) {
    const siblings = cardsByThread.get(card.dshThreadId)
    if (card.turnIndex > 0) card.parentId = siblings[card.turnIndex - 1].id
    else {
      const parentCards = cardsByThread.get(card.sourceParentId)
      const sourceThread = threads.find(thread => thread.id === card.dshThreadId)
      const firstChildQuestion = siblings?.[0]
      const seedLength = sourceThread?.sourceSeedLength ?? firstChildQuestion?.sourceSeq
      // A fork inherits every parent event before DSH's durable seed boundary;
      // the latest parent question below it is the turn this child was born at.
      const inheritedTurn = Number.isSafeInteger(seedLength)
        ? parentCards?.filter(candidate => Number.isInteger(candidate.sourceSeq) && candidate.sourceSeq < seedLength).at(-1)
        : undefined
      card.parentId = state.branchAnchors.get(card.dshThreadId) ?? inheritedTurn?.id ?? null
    }
  }
  return layoutConversationGraph(cards, threads)
}

function layoutConversationGraph(cards, threads) {
  const childrenByThread = new Map()
  for (const thread of threads) {
    if (thread.parentId === null) continue
    const children = childrenByThread.get(thread.parentId) ?? []
    children.push(thread.id)
    childrenByThread.set(thread.parentId, children)
  }
  const laneByThread = new Map()
  const visitThread = threadId => {
    if (laneByThread.has(threadId)) return
    laneByThread.set(threadId, laneByThread.size)
    for (const childId of childrenByThread.get(threadId) ?? []) visitThread(childId)
  }
  for (const thread of threads) if (thread.parentId === null) visitThread(thread.id)
  for (const thread of threads) visitThread(thread.id)

  const byId = new Map(cards.map(card => [card.id, card]))
  const positioned = new Map()
  const positionFor = (card, visiting = new Set()) => {
    if (positioned.has(card.id)) return positioned.get(card.id)
    if (visiting.has(card.id)) return { x: 86, y: 82 + (laneByThread.get(card.dshThreadId) ?? 0) * (TURN_H + 42) }
    visiting.add(card.id)
    const parent = card.parentId === null ? undefined : byId.get(card.parentId)
    const parentPosition = parent === undefined ? undefined : positionFor(parent, visiting)
    const position = {
      x: parentPosition === undefined ? 86 : parentPosition.x + TURN_STEP_X,
      y: 82 + (laneByThread.get(card.dshThreadId) ?? 0) * (TURN_H + 42),
    }
    visiting.delete(card.id)
    positioned.set(card.id, position)
    return position
  }
  for (const card of cards) {
    card.naturalPosition = positionFor(card)
    if (!card.positionLocked) card.position = card.naturalPosition
  }
  // A dragged card keeps its saved position; free cards avoid overlaps.
  const occupied = []
  for (const card of cards) {
    if (card.positionLocked) continue
    const candidate = { x: Math.round(card.position.x), y: Math.max(82, Math.round(card.position.y)) }
    while (true) {
      const collisions = occupied.filter(other => candidate.x < other.x + TURN_W && candidate.x + TURN_W > other.x && candidate.y < other.y + TURN_H && candidate.y + TURN_H > other.y)
      if (collisions.length === 0) break
      candidate.y = Math.max(...collisions.map(other => other.y + TURN_H + 42))
    }
    card.position = candidate
    occupied.push(candidate)
  }
  return cards
}

// Collapsed-subtree filtering, with O(n) descendant counts for fold labels.
function conversationGraphView(cards, collapsedCardIds = state.collapsedCardIds) {
  const cardIds = new Set(cards.map(card => card.id))
  const childrenByParent = new Map()
  for (const card of cards) {
    if (card.parentId === null || !cardIds.has(card.parentId)) continue
    const children = childrenByParent.get(card.parentId) ?? []
    children.push(card.id)
    childrenByParent.set(card.parentId, children)
  }
  const hiddenIds = new Set()
  for (const rootId of collapsedCardIds) {
    if (!cardIds.has(rootId)) continue
    const visited = new Set([rootId])
    const visit = parentId => {
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        hiddenIds.add(childId)
        visit(childId)
      }
    }
    visit(rootId)
  }
  for (const rootId of collapsedCardIds) hiddenIds.delete(rootId)
  const descendantCounts = new Map()
  for (const card of cards) {
    if (descendantCounts.has(card.id)) continue
    let count = 0
    const stack = [...(childrenByParent.get(card.id) ?? [])]
    const seen = new Set(stack)
    while (stack.length > 0) {
      const id = stack.pop()
      count += 1
      for (const childId of childrenByParent.get(id) ?? []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        stack.push(childId)
      }
    }
    descendantCounts.set(card.id, count)
  }
  return {
    cards: cards.filter(card => !hiddenIds.has(card.id)),
    childCounts: new Map(cards.map(card => [card.id, childrenByParent.get(card.id)?.length ?? 0])),
    descendantCounts,
  }
}

function revealConversationThread(cards, threadId) {
  const byId = new Map(cards.map(card => [card.id, card]))
  let changed = false
  for (const target of cards.filter(card => card.dshThreadId === threadId)) {
    const visited = new Set([target.id])
    let parentId = target.parentId
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId)
      if (state.collapsedCardIds.delete(parentId)) changed = true
      parentId = byId.get(parentId)?.parentId ?? null
    }
  }
  if (changed) persistCollapsedCards()
}
function draftPlacement(cards) {
  const draft = state.draft
  if (draft === null || draft.kind === 'new') return null
  const parent = draft.anchorId === undefined
    ? cards.filter(card => card.dshThreadId === draft.parentId).at(-1)
    : cards.find(card => card.id === draft.anchorId)
  if (parent === undefined) return null
  const occupied = cards.map(card => card.position)
  const position = { x: parent.position.x + TURN_STEP_X, y: Math.max(82, parent.position.y) }
  while (occupied.some(other => position.x < other.x + TURN_W && position.x + TURN_W > other.x && position.y < other.y + TURN_H && position.y + TURN_H > other.y)) position.y += TURN_H + 42
  return { parent, position }
}


export { currentDshWorkspace, selectedDshWorkspace, currentDshThread, threadsForDshWorkspace, openDshWorkspace, openCurrentWorkspace, refreshSummaries, openWorkspace, refreshProjection, messagesFor, latestMessage, conversationCards, conversationGraphView, revealConversationThread, draftPlacement }
