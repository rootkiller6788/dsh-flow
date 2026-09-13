// dsh-flow canvas — see src/canvas.js for the module map.
// Entry: host bridge, live replies, polls, boot.
import { state, app, post, escapeHtml, canReplaceView, settleRpc } from './core.js'
import { render, focusActiveNode, setError } from './view.js'
import { refreshSummaries, refreshProjection, openDshWorkspace, openCurrentWorkspace, revealConversationThread, conversationCards, currentDshThread, currentDshWorkspace, selectedDshWorkspace } from './session.js'
import { pollTeams } from './teams.js'
import './actions.js'
import { renderMarkdown } from './markdown.js'


// ---------------------------------------------------------------------------
// Host bridge
// ---------------------------------------------------------------------------
window.addEventListener('message', event => {
  if (event.origin !== window.location.origin || event.data?.source !== 'dsh-flow') return
  const data = event.data
  if (data.type === 'flow:theme') document.documentElement.dataset.theme = data.dark === true ? 'dark' : 'light'
  if (data.type === 'flow:workspaces') {
    state.dshWorkspaces = Array.isArray(data.workspaces) ? data.workspaces.filter(workspace => typeof workspace?.id === 'string' && typeof workspace.title === 'string' && Array.isArray(workspace.sessionIds)) : []
    const current = currentDshWorkspace()
    if (current !== undefined && current.id !== state.selectedDshWorkspaceId) void openDshWorkspace(current.id).catch(setError)
    else if (state.selectedDshWorkspaceId !== null) void openDshWorkspace(state.selectedDshWorkspaceId).catch(setError)
    else if (canReplaceView()) render()
  }
  if (data.type === 'flow:current-session') {
    const previousId = state.currentDsh?.id
    state.currentDsh = data.session
    const preserveCamera = previousId !== data.session?.id && state.mapCardSessionSwitches.delete(data.session?.id)
    const thread = currentDshThread()
    if (thread !== undefined) {
      const preserveSelected = state.activeId === thread.id
      state.activeId = thread.id
      if (!preserveSelected) {
        state.selectedNodeId = null
        state.inspectorId = null
        state.inspectorOpening = false
      }
      if (state.workspace !== null) revealConversationThread(conversationCards(state.workspace.threads), thread.id)
    }
    if (previousId !== data.session?.id) {
      void openCurrentWorkspace({ preserveCamera: preserveCamera }).then(opened => {
        if (!opened && canReplaceView()) {
          render()
          if (!preserveCamera) focusActiveNode()
        }
      }).catch(setError)
    } else if (canReplaceView()) render()
  }
  if (data.type === 'flow:live-reply' && typeof data.sessionId === 'string') {
    const thread = state.workspace?.threads.find(item => item.dshSessionId === data.sessionId)
    if (thread !== undefined) {
      if (data.running === true) {
        state.liveReplies.set(data.sessionId, { running: true, text: typeof data.text === 'string' ? data.text : '' })
        scheduleLiveCardUpdate(data.sessionId)
      } else {
        state.liveReplies.delete(data.sessionId)
        if (canReplaceView() || state.pendingReplies.has(data.sessionId)) render()
      }
    }
  }
  if (data.type === 'flow:forked-session' || data.type === 'flow:created-session' || data.type === 'flow:message-sent') settleRpc(data.requestId, data.session ?? data)
  if (data.type === 'flow:bridge-error') { settleRpc(data.requestId, undefined, new Error(data.message)); if (data.requestId === undefined) setError(data.message) }
})

let liveCardFrame = 0
let liveCardSessionId = null
function scheduleLiveCardUpdate(sessionId) {
  liveCardSessionId = sessionId
  if (liveCardFrame !== 0) return
  liveCardFrame = window.requestAnimationFrame(() => {
    liveCardFrame = 0
    if (liveCardSessionId === null) return
    applyLiveReplyToCard(liveCardSessionId)
    liveCardSessionId = null
  })
}
function applyLiveReplyToCard(sessionId) {
  if (state.dragging || state.canvasGesture) return
  const thread = state.workspace?.threads.find(item => item.dshSessionId === sessionId)
  if (thread === undefined) return
  const live = state.liveReplies.get(sessionId)
  if (live?.running !== true) return
  const cards = app.querySelectorAll(`.card--turn[data-thread="${CSS.escape(thread.id)}"]`)
  const card = cards[cards.length - 1]
  if (!(card instanceof HTMLElement)) return
  const body = card.querySelector('.card-body')
  if (!(body instanceof HTMLElement)) return
  body.innerHTML = live.text.trim() === ''
    ? '<p class="card-body-pending">正在回复</p>'
    : `${renderMarkdown(live.text)}<p class="card-body-pending">正在回复</p>`
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// A thrown render used to die silently inside a poll interval, leaving the
// canvas frozen on its last good frame. Surface it on the stage instead.
window.addEventListener('error', event => {
  const message = String(event.message ?? '渲染失败')
  let toast = document.querySelector('.error-toast')
  if (toast === null) {
    app.insertAdjacentHTML('afterbegin', `<div class="error-toast" role="alert"><span></span><button data-action="dismiss-error" aria-label="关闭" title="关闭">×</button></div>`)
    toast = document.querySelector('.error-toast')
    toast?.querySelector('[data-action="dismiss-error"]')?.addEventListener('click', () => toast.remove())
  }
  const span = toast?.querySelector('span')
  if (span !== null && span !== undefined) span.textContent = message
})
post('flow:request-current')
// Kick the teams fetch off before the first paint: the hierarchy layout is
// team-driven, and painting without it would flash a flat timeline that
// re-weaves a second later.
void pollTeams().catch(setError)
void refreshSummaries().catch(setError)
let projectionPolling = false
async function pollProjection() {
  if (projectionPolling || document.hidden || !canReplaceView()) return
  projectionPolling = true
  try {
    await refreshProjection()
  } finally { projectionPolling = false }
}
window.setInterval(() => { void pollProjection() }, 1_000)
window.setInterval(() => { void pollTeams() }, 1_000)
