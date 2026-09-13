// dsh-flow canvas — see src/canvas.js for the module map.
// Foundation: shared state, geometry constants, localStorage stores, host bridge.
const app = document.querySelector('#app')
const Engine = window.dshFlowEngine
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

// ---------------------------------------------------------------------------
// Storage (visual metadata only — session truth lives in DSH)
// ---------------------------------------------------------------------------
const TURN_POSITIONS_KEY = 'dsh-flow:map-card-positions:v3'
const CLUSTER_POSITIONS_KEY = 'dsh-flow:cluster-positions:v1'
const COLLAPSED_CARDS_KEY = 'dsh-flow:map-collapsed-cards:v1'
const QUICK_PHRASES_KEY = 'dsh-flow:map-quick-phrases:v1'
const BRANCH_ANCHORS_KEY = 'dsh-flow:map-branch-anchors'
const DEFAULT_QUICK_PHRASES = ['展开说明', '举例', '通俗易懂', '对比解释']
const MAX_QUICK_PHRASES = 12
const MAX_QUICK_PHRASE_LENGTH = 16

// ---------------------------------------------------------------------------
// Geometry (world px)
// ---------------------------------------------------------------------------
const TURN_W = 310
const TURN_H = 276
const TURN_STEP_X = 365
const TEAM_W = 280
const TEAM_H = 72
const MEMBER_W = 224
const MEMBER_H = 104
const MEMBER_GAP = 18
const TASK_W = 200
const TASK_H = 76
const TASK_GAP_X = 40
const TASK_GAP_Y = 20
const CLUSTER_GAP = 150
const CAMERA_INSET_X = 56
const CAMERA_INSET_Y = 56
const VIEWPORT_MARGIN = 1400
const STATE_URL = '/plugins/dsh-agent-teams/state'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  summaries: [], workspace: null, activeId: null, selectedNodeId: null,
  currentDsh: null, dshWorkspaces: [], selectedDshWorkspaceId: null,
  pendingReplies: new Map(), pendingRpc: new Map(), liveReplies: new Map(),
  draft: null, error: '', workspaceLoad: 0,
  branchAnchors: new Map(), collapsedCardIds: new Set(), quickPhrases: DEFAULT_QUICK_PHRASES, quickPhraseEditorOpen: false,
  mapCardSessionSwitches: new Set(), expandedMessageIds: new Set(),
  teams: [], teamsSignature: '', teamsError: false, teamsLoaded: false,
  dragging: false, canvasGesture: false, canvasRefreshAfter: 0, needsCenter: true, cameraTouched: false,
  inspectorId: null, inspectorOpening: false, inspectorScrollById: new Map(),
  scene: null, sceneById: null, sceneEdges: null,
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const selectorValue = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

// ---------------------------------------------------------------------------
// Position / preference persistence
// ---------------------------------------------------------------------------
const turnPositions = Engine.positionStore(TURN_POSITIONS_KEY)
const clusterPositions = Engine.positionStore(CLUSTER_POSITIONS_KEY)

function loadJsonList(key, filter) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value.filter(filter) : []
  } catch { return [] }
}
const savedCollapsedCards = loadJsonList(COLLAPSED_CARDS_KEY, item => typeof item === 'string')
const savedBranchAnchors = loadJsonList(BRANCH_ANCHORS_KEY, item => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string')
for (const id of savedCollapsedCards) state.collapsedCardIds.add(id)
for (const [sessionId, cardId] of savedBranchAnchors) state.branchAnchors.set(sessionId, cardId)
try {
  const stored = JSON.parse(localStorage.getItem(QUICK_PHRASES_KEY) ?? 'null')
  if (Array.isArray(stored)) state.quickPhrases = normalizeQuickPhrases(stored)
} catch { /* defaults */ }

function normalizeQuickPhrases(value) {
  const phrases = []
  for (const item of value) {
    const phrase = typeof item === 'string' ? item.trim().slice(0, MAX_QUICK_PHRASE_LENGTH) : ''
    if (phrase !== '' && !phrases.includes(phrase)) phrases.push(phrase)
    if (phrases.length === MAX_QUICK_PHRASES) break
  }
  return phrases
}
function persistQuickPhrases() { try { localStorage.setItem(QUICK_PHRASES_KEY, JSON.stringify(state.quickPhrases)) } catch { /* private browsing */ } }
function persistCollapsedCards() { try { localStorage.setItem(COLLAPSED_CARDS_KEY, JSON.stringify([...state.collapsedCardIds])) } catch { /* private browsing */ } }
function persistBranchAnchors() { try { localStorage.setItem(BRANCH_ANCHORS_KEY, JSON.stringify([...state.branchAnchors])) } catch { /* private browsing */ } }
function rememberBranchAnchor(sessionId, cardId) { state.branchAnchors.set(sessionId, cardId); persistBranchAnchors() }

// ---------------------------------------------------------------------------
// Bridge helpers
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? '请求失败')
  return body
}
function post(type, payload = {}) {
  if (window.parent !== window) window.parent.postMessage({ source: 'dsh-flow', type, ...payload }, window.location.origin)
}
function dshRpc(type, payload = {}) {
  if (window.parent === window) return Promise.reject(new Error('请从 DSH 页面打开后再操作会话'))
  const requestId = crypto.randomUUID()
  post(type, { requestId, ...payload })
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      state.pendingRpc.delete(requestId)
      reject(new Error('DSH 未在规定时间内响应'))
    }, 20_000)
    state.pendingRpc.set(requestId, { resolve, reject, timer })
  })
}
function settleRpc(requestId, value, error) {
  const pending = state.pendingRpc.get(requestId)
  if (pending === undefined) return
  state.pendingRpc.delete(requestId)
  window.clearTimeout(pending.timer)
  if (error === undefined) pending.resolve(value)
  else pending.reject(error instanceof Error ? error : new Error(String(error)))
}
function canReplaceView() {
  return state.draft === null && !state.dragging && !state.canvasGesture && Date.now() >= state.canvasRefreshAfter && !document.activeElement?.matches('textarea')
}
function deferCanvasRefresh(delay = 700) {
  state.canvasRefreshAfter = Math.max(state.canvasRefreshAfter, Date.now() + delay)
}
// Stable per-name accent for avatars and bubbles.
const WHO_PALETTE = [['--accent-soft', '--accent-strong'], ['--info-soft', '--info'], ['--violet-soft', '--violet'], ['--run-soft', '--run'], ['--ok-soft', '--ok']]
const WHO_SOLID = ['--accent', '--info', '--violet', '--run', '--ok']
function whoHash(name) {
  let hash = 0
  for (const character of String(name ?? '')) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash % WHO_PALETTE.length
}
function whoVars(name) {
  const pair = WHO_PALETTE[whoHash(name)]
  return `--who:var(${pair[0]});--who-text:var(${pair[1]})`
}
function whoSolid(name) { return `var(${WHO_SOLID[whoHash(name)]})` }

export { app, Engine, state, escapeHtml, selectorValue, turnPositions, clusterPositions,
  normalizeQuickPhrases, persistQuickPhrases, persistCollapsedCards, persistBranchAnchors, rememberBranchAnchor,
  api, post, dshRpc, settleRpc, canReplaceView, deferCanvasRefresh,
  TURN_POSITIONS_KEY, CLUSTER_POSITIONS_KEY, COLLAPSED_CARDS_KEY, QUICK_PHRASES_KEY, BRANCH_ANCHORS_KEY,
  DEFAULT_QUICK_PHRASES, MAX_QUICK_PHRASES, MAX_QUICK_PHRASE_LENGTH,
  TURN_W, TURN_H, TURN_STEP_X, TEAM_W, TEAM_H, MEMBER_W, MEMBER_H, MEMBER_GAP,
  TASK_W, TASK_H, TASK_GAP_X, TASK_GAP_Y, CLUSTER_GAP, VIEWPORT_MARGIN, STATE_URL,
  WHO_PALETTE, WHO_SOLID, whoHash, whoVars, whoSolid }
