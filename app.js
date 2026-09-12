const app = document.querySelector('#app')
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

// ---------------------------------------------------------------------------
// Constants (canvas geometry + semantic-zoom threshold)
// ---------------------------------------------------------------------------
const POSITIONS_KEY = 'dsh-flow:positions:v1'
const STATE_URL = '/plugins/dsh-agent-teams/state'
// Zoom at which member nodes "expand" to reveal their task DAG.
const TASK_ZOOM_THRESHOLD = 1.5
const CAMERA_INSET_X = 56
const CAMERA_INSET_Y = 56
// Nodes outside the viewport (plus this world-space margin) are not mounted
// into the DOM; the margin pre-mounts nodes before they scroll into view.
const VIEWPORT_MARGIN = 1400

// Node/card dimensions (world px).
const TEAM_W = 320
const TEAM_H = 84
const MEMBER_W = 224
const MEMBER_H = 128
const TASK_W = 200
const TASK_H = 84
const TASK_GAP_X = 40
const TASK_GAP_Y = 28
// Lanes: captain + members are stacked vertically; tasks run horizontally.
const LANE_H = 152
const LANE_X = 86
const TASKS_ORIGIN_X = LANE_X + MEMBER_W + 48

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  zoom: 1,
  canvasCamera: { x: 0, y: 0 },
  canvasViewInitialized: false,
  canvasNeedsCenter: false,
  dragging: false,
  canvasGesture: false,
  teams: [],            // raw snapshots from /state
  nodes: [],            // normalized render nodes (team + member + task)
  nodesById: new Map(),
  edges: [],            // dependency edges (fromKey -> toKey)
  activeNodes: [],      // nodes shown at the current zoom level
  mountedNodeIds: new Set(),
  positions: loadPositions(),
  signature: '',
  error: '',
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const selectorValue = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

// ---------------------------------------------------------------------------
// i18n (locale mirrors the host's <html lang> via flow:locale messages)
// ---------------------------------------------------------------------------
let locale = 'zh'
const MESSAGES = {
  zh: {
    'team.members': '{n} 名成员',
    'team.phase.staged': '待确认',
    'team.phase.running': '运行中',
    'team.halted': '已停止',
    'member.current': '正在：{task}',
    'task.state.open': '待办',
    'task.state.running': '进行中',
    'task.state.completed': '完成',
    'task.state.failed': '失败',
    'task.state.cancelled': '取消',
    'task.state.blocked': '阻塞',
    'member.status.idle': '空闲',
    'member.status.working': '工作中',
    'member.status.removed': '已移除',
    'member.status.captain': '队长',
    'empty.title': '画布上还没有团队。',
    'empty.hint': '在对话中用 AgentTeams 拉起一个团队后，这里会出现成员与任务。',
    'error.missing': '未检测到 dsh-agent-teams 插件或它尚未返回状态。请先安装并在对话中拉起一个团队。',
    'control.switch': '转换',
    'control.switch.title': '转换到会话图层：同一张画布的另一层',
    'control.reset': '重置',
    'control.reset.title': '重置视图',
    'control.zoomOut': '缩小',
    'control.zoomIn': '放大',
  },
  en: {
    'team.members': '{n} members',
    'team.phase.staged': 'Staged',
    'team.phase.running': 'Running',
    'team.halted': 'Halted',
    'member.current': 'Now: {task}',
    'task.state.open': 'Open',
    'task.state.running': 'Running',
    'task.state.completed': 'Done',
    'task.state.failed': 'Failed',
    'task.state.cancelled': 'Cancelled',
    'task.state.blocked': 'Blocked',
    'member.status.idle': 'Idle',
    'member.status.working': 'Working',
    'member.status.removed': 'Removed',
    'member.status.captain': 'Captain',
    'empty.title': 'No teams on the canvas yet.',
    'empty.hint': 'Start a team with AgentTeams in a conversation and its members and tasks will appear here.',
    'error.missing': 'dsh-agent-teams is not installed or has not reported any state yet. Install it and start a team in a conversation first.',
    'control.switch': 'Switch',
    'control.switch.title': 'Switch to the session layer: the other layer of this canvas',
    'control.reset': 'Reset',
    'control.reset.title': 'Reset view',
    'control.zoomOut': 'Zoom out',
    'control.zoomIn': 'Zoom in',
  },
}
function t(key, params) {
  const template = MESSAGES[locale]?.[key] ?? MESSAGES.en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => name in params ? String(params[name]) : _)
}
function taskStateLabel(value) { const key = `task.state.${value}`; const label = t(key); return label === key ? value : label }
function memberStatusLabel(value) { const key = `member.status.${value}`; const label = t(key); return label === key ? value : label }

// ---------------------------------------------------------------------------
// Position persistence (visual-only; never determines node identity)
// ---------------------------------------------------------------------------
function loadPositions() {
  try {
    const value = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function persistPositions() {
  try { localStorage.setItem(POSITIONS_KEY, JSON.stringify(state.positions)) } catch { /* private browsing */ }
}
function savedPosition(key) {
  const position = state.positions[key]
  return position && Number.isFinite(position.x) && Number.isFinite(position.y) ? { x: position.x, y: position.y } : undefined
}
function rememberPosition(key, x, y) {
  state.positions[key] = { x: Math.round(x), y: Math.round(y) }
  persistPositions()
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  const headers = { ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) }
  const response = await fetch(path, { cache: 'no-store', ...options, headers })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? '请求失败')
  return body
}

// ---------------------------------------------------------------------------
// Data layer: poll dsh-agent-teams /state -> nodes + edges
// ---------------------------------------------------------------------------
function memberRoleLabel(member) {
  if (member?.role) return member.role
  return ''
}

function layoutTeams(snapshots) {
  const nodes = []
  const edges = []
  let teamY = 96
  for (const team of snapshots) {
    const teamId = team.teamId
    // Team header node (the cluster anchor).
    const teamKey = `${teamId}:team`
    const teamPos = savedPosition(teamKey) ?? { x: LANE_X, y: teamY - TEAM_H - 12 }
    nodes.push({
      type: 'team', key: teamKey, teamId,
      name: team.name, phase: team.phase, halted: team.halted,
      memberCount: team.members?.length ?? 0,
      x: teamPos.x, y: teamPos.y, w: TEAM_W, h: TEAM_H,
    })

    // Member lanes: captain first, then members.
    const lanes = [
      { name: 'captain', isCaptain: true, member: null },
      ...(team.members ?? []).map(member => ({ name: member.name, isCaptain: false, member })),
    ]
    const laneYByName = new Map()
    lanes.forEach((lane, index) => {
      const key = lane.isCaptain ? `${teamId}:captain` : `${teamId}:member:${lane.name}`
      const pos = savedPosition(key) ?? { x: LANE_X, y: teamY + index * LANE_H }
      laneYByName.set(lane.name, pos.y)
      const member = lane.member
      nodes.push({
        type: 'member', key, teamId, teamName: team.name,
        name: lane.name, isCaptain: lane.isCaptain,
        role: memberRoleLabel(member),
        status: lane.isCaptain ? 'captain' : (member?.status ?? 'idle'),
        activity: member?.activity ?? 'unknown',
        model: member?.model ?? (member?.activeModel ?? ''),
        currentTask: member?.currentTask ?? '',
        done: member?.done ?? 0,
        total: member?.total ?? 0,
        unread: member?.unread ?? 0,
        x: pos.x, y: pos.y, w: MEMBER_W, h: MEMBER_H,
      })
    })

    // Tasks: group by assignee, lay out by depth (global column = dependency
    // depth, so edges always point left -> right regardless of which member
    // owns either end).
    const byAssignee = new Map()
    for (const task of team.tasks ?? []) {
      const assignee = (task.assignee && task.assignee !== '' ? task.assignee : 'captain')
      if (!byAssignee.has(assignee)) byAssignee.set(assignee, [])
      byAssignee.get(assignee).push(task)
    }
    const taskNodes = []
    for (const [assignee, tasks] of byAssignee) {
      const laneY = laneYByName.get(assignee) ?? teamY
      const byDepth = new Map()
      for (const task of tasks) {
        const depth = Number.isInteger(task.depth) ? task.depth : 0
        if (!byDepth.has(depth)) byDepth.set(depth, [])
        byDepth.get(depth).push(task)
      }
      for (const [depth, group] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        group.sort((a, b) => String(a.id).localeCompare(String(b.id)))
        group.forEach((task, row) => {
          taskNodes.push({
            type: 'task', key: `${teamId}:task:${task.id}`, teamId, assignee,
            id: task.id, subject: task.subject ?? task.id, state: task.state ?? 'open',
            kind: task.kind, verdict: task.verdict, round: task.round,
            dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
            depth,
            x: TASKS_ORIGIN_X + depth * (TASK_W + TASK_GAP_X),
            y: laneY + row * (TASK_H + TASK_GAP_Y),
            w: TASK_W, h: TASK_H,
          })
        })
      }
    }
    // Dependency edges (from task id -> task id).
    const taskById = new Map(taskNodes.map(node => [node.id, node]))
    for (const task of taskNodes) {
      for (const depId of task.dependencies) {
        const from = taskById.get(depId)
        if (from === undefined) continue
        edges.push({ from: from.key, to: task.key })
      }
    }
    nodes.push(...taskNodes)
    teamY += lanes.length * LANE_H + 48
  }
  return { nodes, edges }
}

function signatureOf(nodes, edges) {
  // Cheap change detector so the 1s poll does not re-render an idle canvas.
  let s = ''
  for (const node of nodes) {
    s += node.type === 'task'
      ? `${node.key}|${node.state}|${node.assignee}|${node.depth}`
      : `${node.key}|${node.status ?? ''}|${node.activity ?? ''}|${node.done ?? 0}/${node.total ?? 0}`
  }
  return `${s}#${edges.length}`
}

async function pollState() {
  let body
  try {
    body = await api(STATE_URL)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hint = /404|不存在|not found/i.test(message) || /fetch|network/i.test(message)
      ? t('error.missing')
      : message
    if (state.error !== hint) { state.error = hint; render() }
    return
  }
  const snapshots = Array.isArray(body?.teams) ? body.teams : []
  const { nodes, edges } = layoutTeams(snapshots)
  const signature = signatureOf(nodes, edges)
  if (signature === state.signature && state.error === '') return
  state.teams = snapshots
  state.nodes = nodes
  state.edges = edges
  state.nodesById = new Map(nodes.map(node => [node.key, node]))
  state.signature = signature
  state.error = ''
  if (!state.dragging && !state.canvasGesture) render()
}

// ---------------------------------------------------------------------------
// Layout / geometry helpers
// ---------------------------------------------------------------------------
function connectorPath(a, b) {
  const fromX = a.x + a.w
  const fromY = a.y + a.h / 2
  const toX = b.x
  const toY = b.y + b.h / 2
  const bend = Math.min(110, Math.max(36, Math.abs(toX - fromX) * 0.2))
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`
}

function visibleNodeIds(nodes) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return new Set(nodes.map(node => node.key))
  const bounds = viewport.getBoundingClientRect()
  const left = (-state.canvasCamera.x - VIEWPORT_MARGIN) / state.zoom
  const right = (bounds.width - state.canvasCamera.x + VIEWPORT_MARGIN) / state.zoom
  const top = (-state.canvasCamera.y - VIEWPORT_MARGIN) / state.zoom
  const bottom = (bounds.height - state.canvasCamera.y + VIEWPORT_MARGIN) / state.zoom
  const visible = new Set()
  for (const node of nodes) {
    const { x, y, w, h } = node
    if (x + w < left || x > right || y + h < top || y > bottom) continue
    visible.add(node.key)
  }
  return visible
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function statusClass(value) {
  return `status-${String(value ?? '').replace(/[^a-z_-]/gi, '')}`
}

function teamCard(node) {
  const badges = [
    node.phase === 'staged' ? `<span class="badge badge-phase">${t('team.phase.staged')}</span>` : '',
    node.halted ? `<span class="badge badge-halted">${t('team.halted')}</span>` : '',
    node.phase === 'running' ? `<span class="badge badge-running">${t('team.phase.running')}</span>` : '',
  ].join('')
  return `<article class="node-card team-card" data-node="${escapeHtml(node.key)}" data-drag-node="${escapeHtml(node.key)}" style="left:${node.x}px;top:${node.y}px;width:${node.w}px"><header><span class="team-dot"></span><strong>${escapeHtml(node.name)}</strong></header><div class="team-meta">${badges}<span>${t('team.members', { n: node.memberCount })}</span></div></article>`
}

function memberCard(node) {
  const statusLabel = memberStatusLabel(node.status)
  const pct = node.total > 0 ? Math.round((node.done / node.total) * 100) : 0
  const model = node.model ? `<span class="member-model">${escapeHtml(node.model)}</span>` : ''
  const currentTask = node.currentTask ? `<p class="member-current">${escapeHtml(t('member.current', { task: node.currentTask }))}</p>` : ''
  const progress = node.total > 0
    ? `<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div><span class="progress-label">${node.done}/${node.total}</span>`
    : ''
  return `<article class="node-card member-card ${statusClass(node.status)}" data-node="${escapeHtml(node.key)}" data-drag-node="${escapeHtml(node.key)}" style="left:${node.x}px;top:${node.y}px;width:${node.w}px"><header><span class="member-avatar">${escapeHtml(node.name.slice(0, 1))}</span><div class="member-title"><strong>${escapeHtml(node.name)}</strong><span class="member-role">${escapeHtml(node.role || statusLabel)}</span></div><span class="member-status">${escapeHtml(statusLabel)}</span></header>${model}${currentTask}<footer>${progress}</footer></article>`
}

function taskCard(node) {
  const label = taskStateLabel(node.state)
  const kind = node.kind ? `<span class="task-kind">${escapeHtml(node.kind)}</span>` : ''
  const verdict = node.verdict ? `<span class="task-verdict">${escapeHtml(node.verdict)}</span>` : ''
  return `<article class="node-card task-card ${statusClass(node.state)}" data-node="${escapeHtml(node.key)}" style="left:${node.x}px;top:${node.y}px;width:${node.w}px"><header><strong>${escapeHtml(node.subject)}</strong><span class="task-state">${escapeHtml(label)}</span></header><div class="task-meta">${kind}${verdict}<span class="task-id">${escapeHtml(node.id)}</span></div></article>`
}

function nodeCard(node) {
  if (node.type === 'team') return teamCard(node)
  if (node.type === 'member') return memberCard(node)
  return taskCard(node)
}

function connectors() {
  if (state.zoom < TASK_ZOOM_THRESHOLD) return ''
  return state.edges.map(edge => {
    const from = state.nodesById.get(edge.from)
    const to = state.nodesById.get(edge.to)
    if (from === undefined || to === undefined) return ''
    return `<path data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" d="${connectorPath(from, to)}"></path>`
  }).join('')
}

function emptyState() {
  return `<section class="empty-canvas"><strong>${t('empty.title')}</strong><p>${state.error ? escapeHtml(state.error) : t('empty.hint')}</p></section>`
}

function renderCanvas() {
  const showTasks = state.zoom >= TASK_ZOOM_THRESHOLD
  state.activeNodes = showTasks ? state.nodes : state.nodes.filter(node => node.type !== 'task')
  if (state.activeNodes.length === 0) return emptyState()
  if (!state.canvasViewInitialized) {
    state.canvasCamera = initialCanvasCamera(state.activeNodes)
    state.canvasViewInitialized = true
    state.canvasNeedsCenter = true
  }
  const visible = visibleNodeIds(state.activeNodes)
  state.mountedNodeIds = new Set(visible)
  const mounted = state.activeNodes.filter(node => visible.has(node.key))
  return `<section class="canvas-view"><div class="canvas-viewport"><div class="canvas-content" style="transform:translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})"><svg class="connectors">${connectors()}</svg><div class="nodes-layer">${mounted.map(nodeCard).join('')}</div></div></div></section>`
}

function initialCanvasCamera(nodes) {
  if (nodes.length === 0) return { x: 0, y: 0 }
  const focus = nodes.find(node => node.type === 'member' || node.type === 'team') ?? nodes[0]
  return { x: CAMERA_INSET_X - focus.x * state.zoom, y: CAMERA_INSET_Y - focus.y * state.zoom }
}

function render() {
  const canvas = renderCanvas()
  const zoomPct = Math.round(state.zoom * 100)
  // No brand row of its own — same as the session map. The canvas is named by
  // the host's View tab, not by anything painted inside it.
  // 转换 sits leftmost: it leaves this layer, every other control acts on it.
  app.innerHTML = `<header class="topbar"><div class="canvas-controls"><button type="button" data-action="switch-layer" title="${t('control.switch.title')}">${t('control.switch')}</button><button type="button" data-action="reset-camera" title="${t('control.reset.title')}">${t('control.reset')}</button><button type="button" data-action="zoom-out" title="${t('control.zoomOut')}">−</button><span class="zoom-label">${zoomPct}%</span><button type="button" data-action="zoom-in" title="${t('control.zoomIn')}">＋</button></div></header><section class="main-stage">${canvas}</section>`
  if (state.canvasNeedsCenter) {
    state.canvasNeedsCenter = false
    centerCanvas()
  }
  bindMountedDragHandles()
}

function bindMountedDragHandles() {
  const layer = document.querySelector('.nodes-layer')
  if (!(layer instanceof HTMLElement)) return
  for (const element of layer.querySelectorAll('[data-drag-node]')) bindDragHandle(element)
}

// ---------------------------------------------------------------------------
// Viewport: incremental mount/unmount
// ---------------------------------------------------------------------------
function syncCanvasViewport() {
  const layer = document.querySelector('.nodes-layer')
  if (!(layer instanceof HTMLElement)) return
  const visible = visibleNodeIds(state.activeNodes)
  for (const key of [...state.mountedNodeIds]) {
    if (visible.has(key)) continue
    const element = layer.querySelector(`[data-node="${selectorValue(key)}"]`)
    if (element instanceof HTMLElement) element.remove()
    state.mountedNodeIds.delete(key)
  }
  for (const node of state.activeNodes) {
    if (!visible.has(node.key) || state.mountedNodeIds.has(node.key)) continue
    const wrapper = document.createElement('div')
    wrapper.innerHTML = nodeCard(node)
    const element = wrapper.firstElementChild
    if (element instanceof HTMLElement) {
      layer.appendChild(element)
      const handle = element.matches('[data-drag-node]') ? element : element.querySelector('[data-drag-node]')
      if (handle instanceof HTMLElement) bindDragHandle(handle)
    }
    state.mountedNodeIds.add(node.key)
  }
}

function applyCanvasTransform() {
  const content = document.querySelector('.canvas-content')
  if (content instanceof HTMLElement) content.style.transform = `translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})`
}

function centerCanvas() {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement) || state.activeNodes.length === 0) return
  const focus = state.activeNodes.find(node => node.type === 'member' || node.type === 'team') ?? state.activeNodes[0]
  const bounds = viewport.getBoundingClientRect()
  state.canvasCamera = {
    x: bounds.width / 2 - (focus.x + focus.w / 2) * state.zoom,
    y: bounds.height / 2 - (focus.y + focus.h / 2) * state.zoom,
  }
  applyCanvasTransform()
  syncCanvasViewport()
}

// ---------------------------------------------------------------------------
// Canvas engine: drag nodes, pan, zoom
// ---------------------------------------------------------------------------
function bindDragHandle(handle) {
  handle.addEventListener('pointerdown', event => {
    const key = event.currentTarget.dataset.dragNode
    const card = event.currentTarget.closest('.node-card')
    if (key === undefined || !(card instanceof HTMLElement)) return
    event.preventDefault()
    const origin = { x: event.clientX, y: event.clientY, position: { x: Number.parseFloat(card.style.left), y: Number.parseFloat(card.style.top) } }
    let position = origin.position
    let stopped = false
    let frame = 0
    state.dragging = true
    const apply = () => {
      frame = 0
      state.positions[key] = { x: Math.round(position.x), y: Math.round(position.y) }
      const dataNode = state.nodesById.get(key)
      if (dataNode !== undefined) { dataNode.x = position.x; dataNode.y = position.y }
      card.style.left = `${position.x}px`
      card.style.top = `${position.y}px`
      refreshConnectorsFor(key)
    }
    const move = moveEvent => {
      position = { x: origin.position.x + (moveEvent.clientX - origin.x) / state.zoom, y: origin.position.y + (moveEvent.clientY - origin.y) / state.zoom }
      if (frame === 0) frame = window.requestAnimationFrame(apply)
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
      apply()
      rememberPosition(key, position.x, position.y)
      state.dragging = false
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  })
}

function refreshConnectorsFor(key) {
  const svg = document.querySelector('.connectors')
  if (!(svg instanceof SVGElement)) return
  for (const path of svg.querySelectorAll('path[data-from], path[data-to]')) {
    const fromKey = path.getAttribute('data-from')
    const toKey = path.getAttribute('data-to')
    if (fromKey !== key && toKey !== key) continue
    const from = state.nodesById.get(fromKey)
    const to = state.nodesById.get(toKey)
    if (from !== undefined && to !== undefined) path.setAttribute('d', connectorPath(from, to))
  }
}

function zoomCanvas(viewport, nextZoom, clientX, clientY) {
  const zoom = Math.min(4, Math.max(0.6, Math.round(nextZoom * 100) / 100))
  if (zoom === state.zoom) return
  const crossing = (state.zoom < TASK_ZOOM_THRESHOLD) !== (zoom < TASK_ZOOM_THRESHOLD)
  const bounds = viewport.getBoundingClientRect()
  const localX = clientX - bounds.left
  const localY = clientY - bounds.top
  const worldX = (localX - state.canvasCamera.x) / state.zoom
  const worldY = (localY - state.canvasCamera.y) / state.zoom
  state.zoom = zoom
  state.canvasCamera = { x: localX - worldX * zoom, y: localY - worldY * zoom }
  const content = viewport.querySelector('.canvas-content')
  if (content instanceof HTMLElement) content.style.willChange = 'auto'
  if (crossing) {
    // Node set changes at the threshold; rebuild the canvas section only.
    const stage = document.querySelector('.main-stage')
    if (stage instanceof HTMLElement) stage.innerHTML = renderCanvas()
    applyCanvasTransform()
  } else {
    applyCanvasTransform()
    syncCanvasViewport()
  }
  if (content instanceof HTMLElement) window.requestAnimationFrame(() => { content.style.willChange = '' })
  const label = document.querySelector('.zoom-label')
  if (label !== null) label.textContent = `${Math.round(state.zoom * 100)}%`
}

function zoomCanvasAtCenter(delta) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const bounds = viewport.getBoundingClientRect()
  zoomCanvas(viewport, state.zoom + delta, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
}

// Pan: drag the empty canvas.
app.addEventListener('pointerdown', event => {
  const viewport = event.target instanceof Element ? event.target.closest('.canvas-viewport') : null
  if (!(viewport instanceof HTMLElement) || (event.target instanceof Element && event.target.closest('.node-card, button'))) return
  event.preventDefault()
  const origin = { x: event.clientX, y: event.clientY, camera: { ...state.canvasCamera } }
  let pendingCamera = null
  let frame = 0
  state.canvasGesture = true
  viewport.classList.add('is-panning')
  viewport.setPointerCapture(event.pointerId)
  const apply = () => {
    frame = 0
    if (pendingCamera === null) return
    state.canvasCamera = pendingCamera
    pendingCamera = null
    applyCanvasTransform()
    syncCanvasViewport()
  }
  const move = moveEvent => {
    pendingCamera = { x: origin.camera.x + moveEvent.clientX - origin.x, y: origin.camera.y + moveEvent.clientY - origin.y }
    if (frame === 0) frame = window.requestAnimationFrame(apply)
  }
  const stop = () => {
    viewport.classList.remove('is-panning')
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
    apply()
    state.canvasGesture = false
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
})

app.addEventListener('wheel', event => {
  const viewport = event.target instanceof Element ? event.target.closest('.canvas-viewport') : null
  if (!(viewport instanceof HTMLElement)) return
  event.preventDefault()
  const delta = event.deltaY < 0 ? 0.1 : -0.1
  zoomCanvas(viewport, state.zoom + delta, event.clientX, event.clientY)
}, { passive: false })

// Zoom buttons / reset / layer switch.
app.addEventListener('click', event => {
  const action = event.target instanceof Element ? event.target.closest('[data-action]')?.dataset.action : undefined
  if (action === 'zoom-in') zoomCanvasAtCenter(0.2)
  else if (action === 'zoom-out') zoomCanvasAtCenter(-0.2)
  else if (action === 'reset-camera') { state.canvasCamera = { x: 0, y: 0 }; state.zoom = 1; render() }
  // 转换 hands the frame over to the session layer. The host owns the swap —
  // this page has no way to navigate itself to the other page, and the frame
  // that hosts both layers is the host client's, not ours.
  else if (action === 'switch-layer') post('flow:switch-layer')
})

// ---------------------------------------------------------------------------
// Host bridge: mirror the parent web client's theme + locale. Navigation
// (back to the chat, switching canvases) belongs to the host's View tab row —
// this page deliberately renders no view chrome of its own.
// ---------------------------------------------------------------------------
document.documentElement.lang = 'zh-CN'
const post = (type, payload) => { if (window.parent !== window) window.parent.postMessage({ source: 'dsh-flow', type, ...payload }, window.location.origin) }
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return
  const data = event.data
  if (data?.source !== 'dsh-flow') return
  if (data.type === 'flow:theme') {
    document.documentElement.dataset.theme = data.dark === true ? 'dark' : 'light'
  } else if (data.type === 'flow:locale') {
    const next = data.locale === 'zh' ? 'zh' : 'en'
    if (next !== locale) { locale = next; document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'; render() }
  }
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
render()
pollState()
window.setInterval(pollState, 1000)
