// dsh-flow canvas — see src/canvas/canvas.js for the module map.
import { state, app, api, post, dshRpc, escapeHtml, rememberBranchAnchor, deferCanvasRefresh, turnPositions, clusterPositions, persistQuickPhrases, persistCollapsedCards, MAX_QUICK_PHRASES, MAX_QUICK_PHRASE_LENGTH } from './core.js'
import { render, camera, focusActiveNode, setError, openInspector, closeInspector } from './view.js'
import { refreshSummaries, refreshProjection, draftPlacement, conversationCards, conversationGraphView, latestMessage } from './session.js'


// ---------------------------------------------------------------------------
// Drafts & message actions
// ---------------------------------------------------------------------------
function focusDraftInput() {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement)) return
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}
function openNewSession() {
  if (state.draft !== null) return
  state.activeId = null
  state.selectedNodeId = null
  state.inspectorId = null
  state.inspectorOpening = false
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'new', text: '', sending: false }
  state.error = ''
  state.needsCenter = true
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}
function openContinue(parent, anchorId = undefined, text = '') {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'continue', parentId: parent.id, anchorId, text, sending: false }
  render()
  window.setTimeout(focusDraftInput, 0)
}
function openBranch(parent, atSeq = undefined, anchorId = undefined) {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'branch', parentId: parent.id, atSeq, anchorId, text: '', sending: false }
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}
async function sendMessage(thread, text) {
  if (thread.dshSessionId === null) throw new Error('该节点没有关联的 DSH 会话')
  if (state.pendingReplies.has(thread.dshSessionId)) throw new Error('该会话正在回复，请稍后再发送')
  state.pendingReplies.set(thread.dshSessionId, { text, at: Date.now() })
  state.error = ''
  render()
  try {
    await dshRpc('flow:send-message', { sessionId: thread.dshSessionId, text })
  } catch (error) {
    state.pendingReplies.delete(thread.dshSessionId)
    render()
    throw error
  }
}
async function submitDraft() {
  const draft = state.draft
  const text = draft?.text.trim()
  if (draft === null || !text) return
  const branchPosition = draft.kind === 'branch' && state.workspace !== null ? draftPlacement(conversationCards(state.workspace.threads))?.position : undefined
  draft.sending = true
  state.error = ''
  render()
  try {
    if (draft.kind === 'new') {
      const session = await dshRpc('flow:create-session', { workspaceId: state.selectedDshWorkspaceId, cwd: state.currentDsh?.cwd })
      await dshRpc('flow:send-message', { sessionId: session.id, text })
      state.draft = null
      render()
      window.setTimeout(() => { void refreshProjection().catch(() => {}) }, 150)
      return
    }
    const parent = state.workspace?.threads.find(thread => thread.id === draft.parentId)
    if (parent === undefined) throw new Error('来源会话不存在')
    if (draft.kind === 'continue') {
      state.draft = null
      await sendMessage(parent, text)
      return
    }
    const session = await dshRpc('flow:fork-session', { sessionId: parent.dshSessionId, atSeq: draft.atSeq })
    if (draft.anchorId !== undefined) rememberBranchAnchor(session.id, draft.anchorId)
    const result = await api(`/dsh-flow/map-api/threads/${parent.id}/branch`, { method: 'POST', body: JSON.stringify({ title: text.slice(0, 42), dshSessionId: session.id, dshSessionTitle: session.title, position: branchPosition }) })
    if (state.workspace !== null && !state.workspace.threads.some(thread => thread.id === result.thread.id || thread.dshSessionId === result.thread.dshSessionId)) state.workspace.threads.push(result.thread)
    state.activeId = result.thread.id
    state.draft = null
    state.pendingReplies.set(result.thread.dshSessionId, { text, at: Date.now() })
    render()
    await dshRpc('flow:send-message', { sessionId: result.thread.dshSessionId, text })
    await refreshProjection()
  } catch (error) {
    if (state.draft !== null) state.draft = { ...draft, sending: false }
    setError(error)
  }
}
/**
 * Fetch one task's attempt history and remember it.
 *
 * A failure is kept as a message rather than thrown: the panel is already open,
 * and an unhandled rejection would leave it showing the previous task's
 * timeline with nothing to say that the new one never arrived.
 */
async function loadTaskHistory(key, teamId, taskId) {
  try {
    const path = `/dsh-flow/map-api/teams/${encodeURIComponent(teamId)}/tasks/${encodeURIComponent(taskId)}`
    state.taskHistory.set(key, await api(path))
    state.taskHistoryError = ''
  } catch (error) {
    state.taskHistoryError = error instanceof Error ? error.message : String(error)
  }
  render()
}

async function archiveThread(thread) {
  if (!window.confirm(`归档画布中的「${thread.title}」及其分支？DSH 原会话会保留，可在 DSH 内继续查看。`)) return
  await api(`/dsh-flow/map-api/threads/${thread.id}`, { method: 'DELETE' })
  if (state.workspace !== null) {
    const removed = new Set([thread.id])
    for (let changed = true; changed;) {
      changed = false
      for (const item of state.workspace.threads) {
        if (item.parentId !== null && removed.has(item.parentId) && !removed.has(item.id)) { removed.add(item.id); changed = true }
      }
    }
    state.workspace.threads = state.workspace.threads.filter(item => !removed.has(item.id))
    for (const key of [...state.collapsedCardIds]) {
      if ([...removed].some(id => key.startsWith(`${id}:`))) state.collapsedCardIds.delete(key)
    }
    persistCollapsedCards()
    state.activeId = state.activeId !== null && state.workspace.threads.some(item => item.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null
    render()
  } else {
    state.activeId = null
  }
  await refreshSummaries()
}

// Quick phrases
function insertQuickPhrase(phrase) {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement) || state.draft === null) return
  const start = input.selectionStart
  const end = input.selectionEnd
  const prefix = input.value.slice(0, start)
  const suffix = input.value.slice(end)
  const separator = prefix !== '' && !prefix.endsWith('\n') ? '\n' : ''
  const text = `${prefix}${separator}${phrase}${suffix}`
  if (text.length > input.maxLength) return setError('追问内容不能超过 4000 个字符')
  const caret = prefix.length + separator.length + phrase.length
  input.value = text
  state.draft.text = text
  input.focus()
  input.setSelectionRange(caret, caret)
}
function addQuickPhrase(value) {
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') return false
  if (state.quickPhrases.includes(phrase)) return setError('这个快捷词已经存在')
  if (state.quickPhrases.length >= MAX_QUICK_PHRASES) return setError(`最多保留 ${MAX_QUICK_PHRASES} 个快捷词`)
  state.quickPhrases.push(phrase)
  persistQuickPhrases()
  return true
}
function updateQuickPhrase(index, value) {
  if (!Number.isInteger(index) || index < 0 || index >= state.quickPhrases.length) return
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') state.quickPhrases.splice(index, 1)
  else if (state.quickPhrases.some((item, itemIndex) => itemIndex !== index && item === phrase)) return setError('这个快捷词已经存在')
  else state.quickPhrases[index] = phrase
  persistQuickPhrases()
  render()
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------
let pointerDownPosition = null
app.addEventListener('pointerdown', event => { pointerDownPosition = { x: event.clientX, y: event.clientY } })

let selectionFollowup = null
let selectionFollowupFrame = 0
function hideSelectionFollowup() {
  if (selectionFollowupFrame !== 0) { window.cancelAnimationFrame(selectionFollowupFrame); selectionFollowupFrame = 0 }
  selectionFollowup = null
  const button = app.querySelector('.follow-chip')
  if (button instanceof HTMLButtonElement) button.hidden = true
}
function selectionFollowupTarget(range) {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  if (!(start instanceof Element) || !(end instanceof Element)) return null
  const body = start.closest('.card-body')
  if (body instanceof HTMLElement && body.contains(end)) {
    const card = body.closest('[data-node-kind="turn"]')
    if (card instanceof HTMLElement && card.dataset.thread !== undefined) return { threadId: card.dataset.thread }
  }
  return null
}
function updateSelectionFollowup() {
  selectionFollowupFrame = 0
  const button = app.querySelector('.follow-chip')
  const selection = window.getSelection()
  if (!(button instanceof HTMLButtonElement) || state.draft !== null || selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return hideSelectionFollowup()
  const text = selection.toString().trim()
  const range = selection.getRangeAt(0)
  const target = text === '' || text.length > 4000 ? null : selectionFollowupTarget(range)
  const rect = range.getBoundingClientRect()
  if (target === null || rect.width === 0 || rect.height === 0) return hideSelectionFollowup()
  selectionFollowup = { ...target, text }
  button.dataset.thread = target.threadId
  button.style.left = `${Math.min(window.innerWidth - 12, Math.max(76, rect.right))}px`
  button.style.top = `${Math.min(window.innerHeight - 38, Math.max(8, rect.bottom + 8))}px`
  button.hidden = false
}
function queueSelectionFollowup() {
  if (selectionFollowupFrame !== 0) return
  selectionFollowupFrame = window.requestAnimationFrame(updateSelectionFollowup)
}
app.addEventListener('pointerup', queueSelectionFollowup)
app.addEventListener('scroll', hideSelectionFollowup, true)
document.addEventListener('selectionchange', queueSelectionFollowup)
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || state.inspectorId === null) return
  event.preventDefault()
  state.inspectorId = null
  state.inspectorOpening = false
  render()
})

app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]')
  if (!(button instanceof HTMLElement)) {
    const nodeElement = event.target instanceof Element ? event.target.closest('[data-node]') : null
    if (!(nodeElement instanceof HTMLElement) || event.target instanceof Element && event.target.closest('.card-grip, textarea, select, form, input, button')) return
    if (event.detail > 1) return
    if (pointerDownPosition !== null && Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y) > 4) return
    const nodeId = nodeElement.dataset.node
    if (nodeId === undefined || nodeId === 'draft') return
    const node = state.sceneById?.get(nodeId)
    if (node === undefined) return
    if (node.kind === 'turn') {
      const thread = state.workspace?.threads.find(item => item.id === node.card.dshThreadId)
      if (thread === undefined) return
      state.activeId = thread.id
      state.selectedNodeId = nodeId
      openInspector(nodeId)
      state.error = ''
      render()
      // Bidirectional current-session sync: switch DSH's session in place.
      if (thread.dshSessionId !== null) {
        if (thread.dshSessionId !== state.currentDsh?.id) state.mapCardSessionSwitches.add(thread.dshSessionId)
        post('flow:activate-session', { sessionId: thread.dshSessionId })
      }
      return
    }
    if (node.kind === 'team' || node.kind === 'teamRegion' || node.kind === 'memberRegion' || node.kind === 'member' || node.kind === 'task') {
      state.selectedNodeId = nodeId
      openInspector(`team:${node.teamId}`)
      render()
      return
    }
    return
  }
  const thread = state.workspace?.threads.find(item => item.id === button.dataset.thread)
  try {
    if (button.dataset.action === 'follow-selection') {
      const followup = selectionFollowup
      hideSelectionFollowup()
      if (followup !== null && thread !== undefined && thread.id === followup.threadId && state.draft === null) openContinue(thread, undefined, followup.text)
      return
    }
    if (button.dataset.action === 'show-task' && button.dataset.team !== undefined && button.dataset.task !== undefined) {
      const key = `${button.dataset.team}:${button.dataset.task}`
      // Closing is local and instant. Opening paints whatever is already cached
      // and then refreshes: the history grows while work is running, so a cached
      // one shown without a refresh would be a timeline that stopped.
      if (state.expandedTaskId === key) { state.expandedTaskId = null; render(); return }
      state.expandedTaskId = key
      render()
      void loadTaskHistory(key, button.dataset.team, button.dataset.task)
      return
    }
    if (button.dataset.action === 'insert-quick-phrase' && button.dataset.quickPhrase !== undefined) insertQuickPhrase(button.dataset.quickPhrase)
    if (button.dataset.action === 'open-quick-phrase-editor') { state.quickPhraseEditorOpen = true; render() }
    if (button.dataset.action === 'close-quick-phrase-editor') { state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'add-quick-phrase') {
      const editor = button.closest('.phrase-editor-row')
      const input = editor?.querySelector('input')
      if (input instanceof HTMLInputElement && addQuickPhrase(input.value)) render()
    }
    if (button.dataset.action === 'remove-quick-phrase') {
      const index = Number(button.dataset.quickPhraseIndex)
      if (Number.isInteger(index) && index >= 0 && index < state.quickPhrases.length) {
        state.quickPhrases.splice(index, 1)
        persistQuickPhrases()
        render()
      }
    }
    if (button.dataset.action === 'close-inspector') { closeInspector(); return }
    if (button.dataset.action === 'create-session') openNewSession()
    if (button.dataset.action === 'open-dsh' && thread !== undefined && thread.dshSessionId !== null) post('flow:open-session', { sessionId: thread.dshSessionId, seq: Number.isInteger(Number(button.dataset.seq)) ? Number(button.dataset.seq) : undefined })
    if (button.dataset.action === 'toggle-card-children' && button.dataset.card !== undefined) {
      const cardId = button.dataset.card
      const collapsing = !state.collapsedCardIds.has(cardId)
      if (collapsing && state.workspace !== null) {
        const allCards = conversationCards(state.workspace.threads)
        const nextCollapsed = new Set(state.collapsedCardIds).add(cardId)
        const visibleCards = conversationGraphView(allCards, nextCollapsed).cards
        const visibleIds = new Set(visibleCards.map(card => card.id))
        const draftParentId = draftPlacement(allCards)?.parent.id
        if (draftParentId !== undefined && !visibleIds.has(draftParentId)) return setError('请先完成或取消正在编辑的追问或分支')
        if (state.activeId !== null && !visibleCards.some(card => card.dshThreadId === state.activeId)) return setError('当前会话位于这个后续分支中，请先切换会话')
      }
      if (collapsing) state.collapsedCardIds.add(cardId)
      else state.collapsedCardIds.delete(cardId)
      persistCollapsedCards()
      render()
    }
    if (button.dataset.action === 'open-continue' && thread !== undefined) openContinue(thread, button.dataset.card)
    if (button.dataset.action === 'open-branch' && thread !== undefined) {
      const requestedSeq = Number(button.dataset.seq)
      if (button.dataset.card !== undefined && !Number.isInteger(requestedSeq)) return setError('请等待这张卡片的最终回答后再创建分支')
      const fallbackSeq = latestMessage(thread, 'assistant')?.sourceSeq
      openBranch(thread, Number.isInteger(requestedSeq) ? requestedSeq : fallbackSeq, button.dataset.card)
    }
    if (button.dataset.action === 'cancel-draft') { state.draft = null; state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'toggle-message' && button.dataset.message !== undefined) {
      if (state.expandedMessageIds.has(button.dataset.message)) state.expandedMessageIds.delete(button.dataset.message)
      else state.expandedMessageIds.add(button.dataset.message)
      render()
    }
    if (button.dataset.action === 'archive-thread' && thread !== undefined) await archiveThread(thread)
    if (button.dataset.action === 'zoom-in') { state.cameraTouched = true; camera.zoomBy(0.15, document.querySelector('.canvas-viewport')) }
    if (button.dataset.action === 'zoom-out') { state.cameraTouched = true; camera.zoomBy(-0.15, document.querySelector('.canvas-viewport')) }
    if (button.dataset.action === 'dismiss-error') { state.error = ''; render() }
    if (button.dataset.action === 'reset-canvas') {
      turnPositions.clear()
      clusterPositions.clear()
      camera.zoom = 1
      state.needsCenter = true
      // Reset hands control back to auto-centering until the user pans again.
      state.cameraTouched = false
      render()
    }
  } catch (error) { setError(error) }
})

app.addEventListener('change', event => {
  const quickPhrase = event.target instanceof Element ? event.target.closest('[data-quick-phrase-index]') : null
  if (quickPhrase instanceof HTMLInputElement) updateQuickPhrase(Number(quickPhrase.dataset.quickPhraseIndex), quickPhrase.value)
})
app.addEventListener('input', event => {
  const input = event.target
  if (input instanceof HTMLTextAreaElement && input.closest('[data-draft]') && state.draft !== null) state.draft.text = input.value
})
app.addEventListener('submit', event => {
  const form = event.target
  if (form instanceof HTMLFormElement && form.matches('[data-draft]')) { event.preventDefault(); void submitDraft() }
})
