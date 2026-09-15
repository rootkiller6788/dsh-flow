// dsh-flow canvas — see src/canvas/canvas.js for the module map.
import { state, app, Engine, escapeHtml, selectorValue, whoVars, whoSolid, turnPositions, clusterPositions, canReplaceView, deferCanvasRefresh, VIEWPORT_MARGIN, TURN_W, TURN_H, MAX_QUICK_PHRASE_LENGTH } from './core.js'
import { renderMarkdown } from './markdown.js'
import { relayOf } from './relay.js'
import { messagesFor, latestMessage } from './session.js'
import { qualityPanelHtml, taskStateLabel } from './team-panels.js'
import { memberArtUrl, captainArtUrl, actionArtUrl } from './artwork.js'
import { edgePathFor, buildScene } from './scene.js'


// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const camera = Engine.createCamera({ x: 0, y: 0, zoom: 1, onChange: onCameraChange })
let nodeVirtualizer = null
let regionVirtualizer = null
let edgeIndex = new Map()

function onCameraChange() {
  camera.apply(document.querySelector('.canvas-content'))
  syncViewport()
  const label = document.querySelector('.tool-zoom')
  if (label !== null) label.textContent = `${Math.round(camera.zoom * 100)}%`
}

function syncViewport() {
  if (state.scene === null || nodeVirtualizer === null) return
  const viewport = document.querySelector('.canvas-viewport')
  const isRegion = node => node.kind === 'teamRegion' || node.kind === 'memberRegion'
  regionVirtualizer.sync(state.scene.nodes.filter(isRegion), camera, viewport)
  nodeVirtualizer.sync(state.scene.nodes.filter(node => !isRegion(node)), camera, viewport)
}

function cacheEdgeIndex() {
  edgeIndex = new Map()
  const layer = document.querySelector('.edge-layer')
  if (!(layer instanceof SVGElement)) return
  for (const path of layer.querySelectorAll('path[data-from]')) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (toId === null) continue
    for (const id of [fromId, toId]) {
      const paths = edgeIndex.get(id)
      if (paths === undefined) edgeIndex.set(id, new Set([path]))
      else paths.add(path)
    }
  }
}

function refreshEdgesFor(nodeId) {
  const paths = edgeIndex.get(nodeId)
  if (paths === undefined || state.sceneById === undefined) return
  for (const path of paths) {
    const from = state.sceneById.get(path.getAttribute('data-from'))
    const to = state.sceneById.get(path.getAttribute('data-to'))
    if (from === undefined || to === undefined) continue
    path.setAttribute('d', edgePathFor(from.rect, to.rect))
  }
}

function emptyScene() {
  const hasTeams = state.teams.length > 0
  return `<section class="empty-note"><strong>${state.teamsError ? '还没有可展示的会话或团队。' : '当前工作目录还没有 DSH 对话。'}</strong><p>${state.teamsError ? '团队数据暂时读不到；在对话中拉起一个团队后这里会出现成员与任务。' : '点击新建会话，在画布中输入第一条消息；拉起智能体团队后，团队会出现在会话右侧。'}</p>${hasTeams || state.teamsError ? '' : '<div><button class="primary" type="button" data-action="create-session">新建会话</button></div>'}</section>`
}

function edgeLayerHtml(edges, marks = []) {
  const paths = edges.map(edge => {
    const from = state.sceneById.get(edge.from)
    const to = state.sceneById.get(edge.to)
    if (from === undefined || to === undefined) return ''
    return `<path class="edge ${edge.cls}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" d="${edgePathFor(from.rect, to.rect)}"></path>`
  }).join('')
  // Time ticks: a member speech turn dotted down onto its swimlane.
  const ticks = marks.map(mark => `<path class="edge--tick" d="M ${mark.x} ${mark.y1} L ${mark.x} ${mark.y2}"></path><circle class="mark-dot" cx="${mark.x}" cy="${mark.y2}" r="3.5"></circle>`).join('')
  return `<svg class="edge-layer"><defs><marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" style="fill:var(--edge-strong)"></path></marker><marker id="flow-arrow-accent" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" style="fill:var(--accent)"></path></marker></defs>${paths}${ticks}</svg>`
}

function renderCanvasHtml() {
  // The first paint waits for the teams feed: painting earlier would flash a
  // flat timeline that re-weaves into the hierarchy a second later.
  if (!state.teamsLoaded) return '<section class="empty-note"><strong>正在装载画布…</strong></section>'
  const scene = buildScene()
  state.scene = scene
  state.sceneById = new Map(scene.nodes.map(node => [node.id, node]))
  state.sceneEdges = scene.edges
  if (state.inspectorId !== null && !state.sceneById.has(state.inspectorId)) {
    state.inspectorId = null
    state.inspectorOpening = false
  }
  if (scene.nodes.length === 0) return emptyScene()
  return `<div class="canvas-view"><div class="canvas-viewport"><div class="canvas-content" style="transform:translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})"><div class="regions-layer"></div>${edgeLayerHtml(scene.edges)}<div class="nodes-layer"></div></div></div>${renderInspector()}</div>`
}

// -- Node cards -------------------------------------------------------------
function gripHtml(nodeId) {
  return `<button class="card-grip" data-drag-id="${escapeHtml(nodeId)}" aria-label="拖动卡片" title="拖动卡片"></button>`
}

function turnCardHtml(node) {
  const card = node.card
  const thread = state.workspace?.threads.find(item => item.id === card.dshThreadId)
  const color = thread?.color ?? 'var(--accent)'
  const source = card.agentEvent !== null ? '智能体消息' : card.parentId === null ? 'DSH 会话' : card.turnIndex === 0 ? 'DSH 分支' : '追问'
  const childCount = state.scene.graph.childCounts.get(card.id) ?? 0
  const descendantCount = state.scene.graph.descendantCounts.get(card.id) ?? 0
  const collapsed = state.collapsedCardIds.has(card.id)
  const foldButton = childCount === 0 || card.canContinue === true ? '' : `<button class="card-corner card-corner--fold" data-action="toggle-card-children" data-card="${escapeHtml(card.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? '展开后续对话' : '折叠后续对话'}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"/>${collapsed ? '<path d="M8 3.5v9"/>' : ''}</svg></button>`
  const continueButton = card.canContinue === true ? `<button class="card-corner card-corner--continue" data-action="open-continue" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" title="添加追问" aria-label="添加追问"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button>` : ''
  const branchButton = childCount === 0 || card.canContinue === true || !Number.isInteger(card.answer?.sourceSeq) ? '' : `<button class="card-corner card-corner--branch" data-action="open-branch" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" data-seq="${card.answer.sourceSeq}" title="在新对话中分支" aria-label="在新对话中分支"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.08 1.37a1.83 1.83 0 0 1 1.82 1.83 1.83 1.83 0 0 1-1.82 1.82c-.78 0-1.44-.49-1.71-1.17H4.36c.44.42.8.92 1.06 1.48l1.69 3.74c.78 1.72 2.45 2.85 4.31 2.97.29-.63.93-1.06 1.66-1.06a1.83 1.83 0 0 1 0 3.65c-.82 0-1.52-.55-1.75-1.3a6.93 6.93 0 0 1-5.15-3.73l-1.69-3.73a1.9 1.9 0 0 0-1.72-1.13V2.55l10.24-.01c.27-.68.93-1.17 1.71-1.17Zm0 10.9c-.29 0-.53.24-.53.53s.24.53.53.53c.29-.01.52-.24.52-.53 0-.29-.23-.52-.52-.53Zm0-9.6c-.29 0-.53.24-.53.53s.24.52.53.53a.53.53 0 0 0 0-1.06Z" fill="currentColor" stroke="none"/></svg></button>`
  const body = card.answer === null
    ? card.error === null ? '<p class="card-body-empty">等待助手回复</p>' : ''
    : card.answer.pending && card.answer.text === '' ? '<p class="card-body-pending">正在回复</p>'
      : `${renderMarkdown(card.answer.text)}${card.answer.pending ? '<p class="card-body-pending">正在回复</p>' : ''}`
  // Speaker identity, visible on the strip without opening anything: an
  // agent-event turn wears its member's avatar and edge color; a turn whose
  // answer is a member relay shows the answering member above the body.
  const speaker = card.agentEvent !== null
    ? { name: card.agentEvent.from, to: card.agentEvent.to, fromQuestion: true }
    : card.answer !== null && card.answer.from !== null
      ? { name: card.answer.from, to: card.answer.to, fromQuestion: false }
      : null
  const identity = speaker !== null && speaker.fromQuestion
    ? `<span class="avatar avatar--sm" style="${whoVars(speaker.name)}" title="${escapeHtml(speaker.to && speaker.to !== 'parent' ? `${speaker.name} → ${speaker.to}` : speaker.name)}">${escapeHtml(speaker.name.slice(0, 1))}</span>`
    : '<span class="card-dot"></span>'
  const whoStrip = speaker !== null && !speaker.fromQuestion
    ? `<div class="answer-who"><span class="avatar avatar--sm" style="${whoVars(speaker.name)}">${escapeHtml(speaker.name.slice(0, 1))}</span><span>${escapeHtml(speaker.to && speaker.to !== 'parent' ? `${speaker.name} → ${speaker.to}` : speaker.name)}</span></div>`
    : ''
  const dotColor = card.agentEvent !== null ? whoSolid(card.agentEvent.from) : escapeHtml(color)
  return `<article class="card card--turn${card.id === state.selectedNodeId ? ' is-selected' : ''}" data-node="${escapeHtml(card.id)}" data-node-kind="turn" data-thread="${card.dshThreadId}" data-position-key="${escapeHtml(card.positionKey)}" style="left:${node.rect.x}px;top:${node.rect.y}px;--dot:${dotColor}">
    ${gripHtml(card.id)}${foldButton}${continueButton}${branchButton}
    <div class="card-title-row">${identity}<button class="card-title-btn" data-action="open-dsh" data-thread="${card.dshThreadId}" data-seq="${Number.isInteger(card.sourceSeq) ? card.sourceSeq : ''}" title="在 DSH 中打开完整会话">${escapeHtml(card.question)}</button></div>
    <div class="card-meta"><span>${source}</span><span>第 ${card.turnIndex + 1} 轮</span>${card.error === null ? '' : '<span class="meta-fail">失败</span>'}${card.processCount > 0 ? `<span class="meta-chip">工具 ${card.processCount}</span>` : ''}${descendantCount > 0 && !collapsed ? `<span class="meta-chip">+${descendantCount} 后续</span>` : ''}</div>
    <div class="card-body">${whoStrip}${body}${card.error === null ? '' : `<p class="card-body-fail" title="${escapeHtml(card.error.text)}">本轮失败：${escapeHtml(card.error.text)}</p>`}</div>
    <footer class="card-foot"><button data-action="open-dsh" data-thread="${card.dshThreadId}" data-seq="${Number.isInteger(card.sourceSeq) ? card.sourceSeq : ''}" title="在 DSH 中打开完整会话"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 3.5h3v3M12.4 3.6 7.5 8.5"/></svg>DSH</button><button data-action="archive-thread" data-thread="${card.dshThreadId}" title="归档此会话"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5h11M5.5 7v5.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V7"/><path d="M4 5 5 2.8a.7.7 0 0 1 .6-.4h4.8a.7.7 0 0 1 .6.4L12 5M6 9.5h4"/></svg>归档</button></footer>
  </article>`
}

function teamCardHtml(node) {
  const badges = [
    node.halted ? '<span class="chip chip--halted">已停止</span>' : '',
    node.phase === 'running' ? '<span class="chip chip--running">运行中</span>' : '',
    node.phase === 'staged' ? '<span class="chip chip--staged">待确认</span>' : '',
  ].join('')
  const progress = node.taskCount > 0 ? `${node.taskDone}/${node.taskCount}` : `${node.memberCount} 名成员`
  return `<article class="card card--team${node.id === state.selectedNodeId ? ' is-selected' : ''}" data-node="${escapeHtml(node.id)}" data-node-kind="team" style="left:${node.rect.x}px;top:${node.rect.y}px;width:${node.rect.w}px;height:${node.rect.h}px">
    <div class="team-name"><span class="team-dot${node.halted ? ' is-halted' : ''}"></span><span>${escapeHtml(node.name)}</span></div>
    <div class="team-badges">${badges}<span>${progress}</span></div>
  </article>`
}

function memberRegionHtml(node) {
  const member = node.member
  const role = node.isCaptain ? '拆解 · 派发 · 汇总' : (member?.role ?? '')
  const statusChip = node.isCaptain
    ? '<span class="chip chip--staged">队长</span>'
    : member?.status === 'working' ? '<span class="chip chip--running">工作中</span>' : member?.status === 'removed' ? '<span class="chip chip--halted">已移除</span>' : '<span class="chip chip--idle">空闲</span>'
  const pct = member && member.total > 0 ? Math.round((member.done / member.total) * 100) : 0
  const meter = member && member.total > 0
    ? `<div class="meter" style="margin-left:auto;max-width:150px"><div class="meter-track"><div class="meter-fill" style="width:${pct}%"></div></div><span class="meter-label">${member.done}/${member.total}</span></div>`
    : ''
  return `<section class="member-region" data-node="${escapeHtml(node.id)}" data-node-kind="memberRegion" data-team="${escapeHtml(node.teamId)}" style="left:${node.rect.x}px;top:${node.rect.y}px;width:${node.rect.w}px;height:${node.rect.h}px">
    <div class="member-region-head"><span class="avatar avatar--sm${node.isCaptain ? ' avatar--captain' : ''}" style="${whoVars(node.name)}">${escapeHtml(node.name.slice(0, 1))}</span><strong class="member-region-name">${escapeHtml(node.name)}</strong><span class="member-region-role">${escapeHtml(role)}</span>${statusChip}${meter}</div>
  </section>`
}

function teamRegionHtml(node) {
  return `<div class="team-region" data-node="${escapeHtml(node.id)}" data-node-kind="teamRegion" style="left:${node.rect.x}px;top:${node.rect.y}px;width:${node.rect.w}px;height:${node.rect.h}px"></div>`
}

function memberCardHtml(node) {
  const pct = node.total > 0 ? Math.round((node.done / node.total) * 100) : 0
  const statusChip = node.isCaptain
    ? '<span class="chip chip--staged">队长</span>'
    : node.status === 'working' ? '<span class="chip chip--running">工作中</span>' : node.status === 'removed' ? '<span class="chip chip--halted">已移除</span>' : '<span class="chip chip--idle">空闲</span>'
  const meter = node.total > 0 ? `<div class="meter"><div class="meter-track"><div class="meter-fill" style="width:${pct}%"></div></div><span class="meter-label">${node.done}/${node.total}</span></div>` : ''
  return `<article class="card card--member${node.id === state.selectedNodeId ? ' is-selected' : ''}" data-node="${escapeHtml(node.id)}" data-node-kind="member" data-team="${escapeHtml(node.teamId)}" style="left:${node.rect.x}px;top:${node.rect.y}px">
    ${gripHtml(node.id)}${node.unread > 0 ? `<span class="member-unread">${node.unread}</span>` : ''}
    <div class="member-head">${memberArtUrl(node.name, node.role) !== null ? `<img class="member-portrait member-portrait--card" src="${memberArtUrl(node.name, node.role)}" alt="">` : `<span class="avatar avatar--card-fallback" style="${whoVars(node.name)}">${escapeHtml(node.name.slice(0, 1))}</span>`}<div class="member-names"><div class="member-name">${escapeHtml(node.name)}</div><div class="member-role">${escapeHtml(node.role || (node.isCaptain ? '拆解 · 派发 · 汇总' : ''))}</div></div>${statusChip}</div>
    ${node.currentTask ? `<div class="member-role">正在：${escapeHtml(node.currentTask)}</div>` : ''}
    ${node.model ? `<div class="member-model">${escapeHtml(node.model)}</div>` : ''}
    ${meter}
  </article>`
}

function taskCardHtml(node) {
  return `<article class="card card--task${node.id === state.selectedNodeId ? ' is-selected' : ''}" data-node="${escapeHtml(node.id)}" data-node-kind="task" data-team="${escapeHtml(node.teamId)}" style="left:${node.rect.x}px;top:${node.rect.y}px">
    <div class="task-subject" title="${escapeHtml(node.subject)}">${escapeHtml(node.subject)}</div>
    <div class="task-meta"><span class="chip chip--state-${escapeHtml(node.state)}">${escapeHtml(taskStateLabel(node.state))}</span>${node.verdict ? `<span class="task-verdict">${escapeHtml(node.verdict)}</span>` : ''}<span class="task-id">${escapeHtml(node.taskId)}</span></div>
  </article>`
}

function draftCardHtml(node) {
  const draft = node.draft
  const disabled = draft.sending ? 'disabled' : ''
  const title = draft.kind === 'new' ? '新会话' : draft.kind === 'continue' ? '新的追问' : '新的分支'
  const placeholder = draft.kind === 'new' ? '输入第一条消息' : draft.kind === 'continue' ? '输入追问' : '输入这个分支的新问题'
  const phrases = draft.kind === 'new' ? '' : state.quickPhraseEditorOpen
    ? `<div class="phrase-editor">${state.quickPhrases.map((phrase, index) => `<div class="phrase-editor-row"><input data-quick-phrase-index="${index}" maxlength="${MAX_QUICK_PHRASE_LENGTH}" value="${escapeHtml(phrase)}" aria-label="快捷词 ${index + 1}" ${disabled}><button type="button" data-action="remove-quick-phrase" data-quick-phrase-index="${index}" title="删除" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button></div>`).join('')}<div class="phrase-editor-row"><input maxlength="${MAX_QUICK_PHRASE_LENGTH}" placeholder="添加快捷词" aria-label="添加快捷词" ${disabled}><button class="primary" type="button" data-action="add-quick-phrase" title="添加快捷词" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div><button class="phrase-done" type="button" data-action="close-quick-phrase-editor" ${disabled}>完成</button></div></div>`
    : `<div class="phrase-row">${state.quickPhrases.map(phrase => `<button class="phrase" type="button" data-action="insert-quick-phrase" data-quick-phrase="${escapeHtml(phrase)}" ${disabled}>${escapeHtml(phrase)}</button>`).join('')}<button class="phrase phrase-manage" type="button" data-action="open-quick-phrase-editor" title="管理快捷词" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div>`
  return `<article class="card card--draft" data-node="draft" data-node-kind="draft" style="left:${node.rect.x}px;top:${node.rect.y}px">
    <div class="draft-title"><span class="card-dot"></span><strong>${title}</strong></div>
    <form class="draft-form" data-draft>${phrases}<textarea maxlength="4000" placeholder="${placeholder}" ${disabled}>${escapeHtml(draft.text)}</textarea><div class="draft-actions"><button type="button" data-action="cancel-draft" ${disabled} title="取消" aria-label="取消"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button><button class="primary" type="submit" ${disabled} title="发送" aria-label="发送"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/></svg></button></div></form>
  </article>`
}

function nodeHtml(node) {
  if (node.kind === 'turn') return turnCardHtml(node)
  if (node.kind === 'team') return teamCardHtml(node)
  if (node.kind === 'teamRegion') return teamRegionHtml(node)
  if (node.kind === 'memberRegion') return memberRegionHtml(node)
  if (node.kind === 'member') return memberCardHtml(node)
  if (node.kind === 'task') return taskCardHtml(node)
  return draftCardHtml(node)
}

function mountNode(node) {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = nodeHtml(node)
  const element = wrapper.firstElementChild
  if (!(element instanceof HTMLElement)) return element
  const grip = element.querySelector('[data-drag-id]')
  if (grip instanceof HTMLElement) {
    Engine.bindDrag(grip, {
      zoom: () => camera.zoom,
      onMove: (position, cardElement) => {
        state.dragging = true
        cardElement.style.left = `${position.x}px`
        cardElement.style.top = `${position.y}px`
        const live = state.sceneById?.get(node.id)
        if (live !== undefined) {
          live.rect = { x: position.x, y: position.y, w: node.rect.w, h: node.rect.h }
          // Carried subtree: members follow their header, tasks follow their
          // assignee. Recomputing from layout would fight the drag, so only
          // the anchored dependents move, by their original offset.
          for (const child of state.scene.nodes) {
            if (child.anchorParentId !== node.id) continue
            child.rect.x = position.x + child.anchorOffset.dx
            child.rect.y = position.y + child.anchorOffset.dy
            const childElement = document.querySelector(`[data-node="${selectorValue(child.id)}"]`)
            if (childElement instanceof HTMLElement) { childElement.style.left = `${child.rect.x}px`; childElement.style.top = `${child.rect.y}px` }
            refreshEdgesFor(child.id)
          }
        }
        refreshEdgesFor(node.id)
      },
      onDrop: position => {
        state.dragging = false
        if (node.kind === 'turn') turnPositions.set(node.id, position, [node.positionKey])
        else clusterPositions.set(node.id, position)
        deferCanvasRefresh(120)
      },
    })
  }
  return element
}

// Tag subtree anchors once per scene: a member carries its tasks, a header
// carries members that have not been dragged to their own spot.
function tagAnchors() {
  const scene = state.scene
  if (scene === null) return
  for (const node of scene.nodes) {
    if (node.kind === 'team' && !node.summary) {
      for (const other of scene.nodes) {
        if (other.kind !== 'member' || other.teamId !== node.teamId) continue
        if (clusterPositions.get(other.id) !== undefined) continue
        other.anchorParentId = node.id
        other.anchorOffset = { dx: other.rect.x - node.rect.x, dy: other.rect.y - node.rect.y }
      }
    }
    if (node.kind === 'member') {
      const team = state.teams.find(item => String(item.teamId) === String(node.teamId))
      for (const other of scene.nodes) {
        if (other.kind !== 'task' || other.teamId !== node.teamId) continue
        const task = team?.tasks?.find(item => item.id === other.taskId)
        if (task === undefined) continue
        const assignee = task.assignee && task.assignee !== '' ? task.assignee : 'captain'
        if (assignee !== node.laneName) continue
        other.anchorParentId = node.id
        other.anchorOffset = { dx: other.rect.x - node.rect.x, dy: other.rect.y - node.rect.y }
      }
    }
  }
}

// -- Inspector ---------------------------------------------------------------
function processSummary(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140) || '工具调用记录'
}

function processRecordsHtml(process, messageKey) {
  if (process.length === 0) return ''
  const expanded = state.expandedMessageIds.has(messageKey)
  const entries = process.map((entry, index) => {
    const entryKey = `${messageKey}:${index}`
    const entryExpanded = state.expandedMessageIds.has(entryKey)
    const status = entry.error !== null ? '失败' : entry.result === null ? '等待结果' : '完成'
    const body = entryExpanded
      ? `<div class="process-item-body">${entry.arguments === null || entry.arguments === '' ? '' : `<pre>${escapeHtml(entry.arguments)}</pre>`}${entry.error !== null ? `<pre class="process-error">${escapeHtml(entry.error)}</pre>` : entry.result === null ? '' : `<pre>${escapeHtml(entry.result)}</pre>`}</div>`
      : ''
    return `<div class="process-item"><button class="process-item-head" data-action="toggle-message" data-message="${escapeHtml(entryKey)}"><span class="process-item-name">${escapeHtml(entry.name)}</span><span class="process-state ${entry.error !== null ? 'process-state--error' : entry.result === null ? 'process-state--pending' : 'process-state--done'}">${status}</span></button>${body}</div>`
  }).join('')
  return `<section class="process"><button class="process-toggle" data-action="toggle-message" data-message="${escapeHtml(messageKey)}"><span>${expanded ? '收起过程记录' : '过程记录'}</span><span class="process-count">${process.length}</span></button>${expanded ? entries : ''}</section>`
}

function messagesForCard(card) {
  const thread = state.workspace?.threads.find(item => item.id === card.dshThreadId)
  if (thread === undefined) return { thread: null, messages: [] }
  const messages = messagesFor(thread)
  let turnIndex = -1
  let start = -1
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].kind !== 'user') continue
    turnIndex += 1
    if (turnIndex === card.turnIndex) { start = index; break }
  }
  if (start === -1) return { thread, messages: [] }
  const end = messages.findIndex((message, index) => index > start && message.kind === 'user')
  return { thread, messages: messages.slice(start, end === -1 ? undefined : end) }
}

function inspectorProcessEntries(messages) {
  const entries = []
  for (const message of messages) {
    if (Array.isArray(message.process)) { entries.push(...message.process.map(entry => ({ ...entry }))); continue }
    if (message.kind === 'tool') { entries.push({ name: processSummary(message.text), arguments: message.text, result: null, error: null }); continue }
    if (message.kind === 'tool-result') {
      const previous = entries.at(-1)
      if (previous !== undefined && previous.result === null && previous.error === null) previous.result = message.text
      else entries.push({ name: '工具结果', arguments: null, result: message.text, error: null })
    }
  }
  return entries
}

/** A turn is a stream of messages between named participants. */
function turnBubbles(messages) {
  const bubbles = []
  for (const message of messages) {
    if (message.kind === 'user') {
      const agent = relayOf(message)
      if (agent !== null) bubbles.push({ who: 'agent', from: agent.from, to: agent.to, label: agent.title, text: agent.text })
      else bubbles.push({ who: 'user', text: message.text, pending: message.pending === true })
    } else if (message.kind === 'assistant') {
      const relay = relayOf(message)
      if (relay !== null) bubbles.push({ who: 'agent', from: relay.from, to: relay.to, label: relay.title, text: relay.text, pending: message.pending === true })
      else bubbles.push({ who: 'assistant', text: message.text, pending: message.pending === true })
    } else if (message.kind === 'error') bubbles.push({ who: 'error', text: message.text })
  }
  return bubbles
}

function bubbleHtml(bubble, index) {
  const body = bubble.who === 'error'
    ? `<div class="bubble-body"><div class="md">${renderMarkdown(bubble.text)}</div></div>`
    : bubble.text.trim() === ''
      ? '<div class="bubble-body"><span class="inspector-pending">正在回复</span></div>'
      : `<div class="bubble-body"><div class="md">${renderMarkdown(bubble.text)}</div></div>`
  if (bubble.who === 'user') {
    return `<div class="bubble bubble--user${bubble.pending ? ' bubble--pending' : ''}"><span class="avatar" style="--who:var(--panel-2);--who-text:var(--muted)">我</span><div><div class="bubble-who">我</div>${body}</div></div>`
  }
  if (bubble.who === 'agent') {
    const name = bubble.label ?? bubble.from
    const portrait = memberArtUrl(bubble.from, bubble.to)
    const face = portrait !== null
      ? `<img class="bubble-portrait" src="${portrait}" alt="">`
      : `<span class="avatar" style="${whoVars(bubble.from)}">${escapeHtml(bubble.from.slice(0, 1))}</span>`
    return `<div class="bubble bubble--agent">${face}<div><div class="bubble-who">${escapeHtml(name)}${bubble.to ? `<span class="bubble-route">${escapeHtml(bubble.to)}</span>` : ''}</div>${body}</div></div>`
  }
  const label = bubble.who === 'error' ? '本轮失败' : '助手'
  return `<div class="bubble bubble--assistant${bubble.pending ? ' bubble--pending' : ''}"><span class="avatar" style="--who:var(--panel-2);--who-text:var(--muted)">✳</span><div><div class="bubble-who">${label}</div>${body}</div></div>`
}

function renderTurnInspector(node) {
  const card = node.card
  const { thread, messages } = messagesForCard(card)
  if (thread === null) return ''
  const process = inspectorProcessEntries(messages)
  const bubbles = turnBubbles(messages)
  const bubbleStream = bubbles.length === 0 ? '<p class="inspector-pending">等待助手回复</p>' : `<div class="bubble-stream">${bubbles.map(bubbleHtml).join('')}</div>`
  const processHtml = process.length === 0 ? '' : processRecordsHtml(process, `${thread.id}:${card.id}:inspector`)
  const continueAction = card.canContinue === true ? `<button type="button" data-action="open-continue" data-thread="${thread.id}" data-card="${escapeHtml(card.id)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3.5 2.5v-2.5h-1.5Z"/><path d="M8 5.5v3M6.5 7h3"/></svg>继续追问</button>` : ''
  const branch = Number.isInteger(card.answer?.sourceSeq)
    ? `<button type="button" data-action="open-branch" data-thread="${thread.id}" data-card="${escapeHtml(card.id)}" data-seq="${card.answer.sourceSeq}"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M5.5 3.5h2A2.5 2.5 0 0 1 10 6v5"/></svg>创建分支</button>`
    : ''
  const openDsh = `<button class="primary" type="button" data-action="open-dsh" data-thread="${thread.id}" data-seq="${Number.isInteger(card.answer?.sourceSeq) ? card.answer.sourceSeq : ''}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 3.5h3v3M12.4 3.6 7.5 8.5"/></svg>在 DSH 中打开</button>`
  return `<header class="inspector-head"><div><div class="inspector-meta"><span>第 ${card.turnIndex + 1} 轮</span>${card.error === null ? '' : '<span class="meta-fail">失败</span>'}${process.length > 0 ? `<span>工具 ${process.length}</span>` : ''}${bubbles.filter(bubble => bubble.who === 'agent').length > 0 ? `<span>${bubbles.filter(bubble => bubble.who === 'agent').length} 条成员消息</span>` : ''}</div><h2 class="inspector-title">${escapeHtml(card.question)}</h2></div><button class="inspector-close" type="button" data-action="close-inspector" aria-label="关闭详情" title="关闭"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button></header><div class="inspector-scroll">${bubbleStream}${processHtml}</div><footer class="inspector-foot">${continueAction}${branch}${openDsh}</footer>`
}

function renderTeamInspector(node) {
  const team = state.teams.find(item => String(item.teamId) === String(node.teamId))
  if (team === undefined) return ''
  const taskTotal = (team.tasks ?? []).length
  const taskDone = (team.tasks ?? []).filter(task => task.state === 'completed').length
  const captainRow = `<div class="team-member-row"><img class="member-portrait" src="${captainArtUrl()}" alt=""><div class="team-member-info"><div class="team-member-name">队长<span class="team-member-role">拆解 · 派发 · 汇总</span></div><div class="team-member-model">统筹全部任务与成果</div><div class="meter"><div class="meter-track"><div class="meter-fill" style="width:${taskTotal > 0 ? Math.round(taskDone / taskTotal * 100) : 0}%"></div></div><span class="meter-label">${taskDone}/${taskTotal}</span></div></div></div>`
  const members = captainRow + (team.members ?? []).map(member => {
    const pct = member.total > 0 ? Math.round((member.done / member.total) * 100) : 0
    const portrait = memberArtUrl(member.name, member.role ?? '') ?? ''
    const action = memberArtUrl(member.name, member.role ?? '') ? actionArtUrl(member.activity ?? (member.status === 'working' ? 'working' : 'idle')) : null
    const identity = `<div class="team-member-name">${escapeHtml(member.name)}${member.role ? `<span class="team-member-role">${escapeHtml(member.role)}</span>` : ''}</div><div class="team-member-model">${escapeHtml(member.model ?? member.activeModel ?? '')}</div>`
    return `<div class="team-member-row">
      <img class="member-portrait" src="${portrait}" alt="" loading="lazy">
      ${action ? `<img class="member-action" src="${action}" alt="" title="${member.status === 'working' ? '工作中' : '空闲'}">` : ''}
      <div class="team-member-info">${identity}${member.currentTask ? `<div class="team-member-task">正在：${escapeHtml(member.currentTask)}</div>` : ''}<div class="meter"><div class="meter-track"><div class="meter-fill" style="width:${pct}%"></div></div><span class="meter-label">${member.done ?? 0}/${member.total ?? 0}</span></div></div>
    </div>`
  }).join('')
  const tasks = (team.tasks ?? []).map(task => `<div class="task-dep-row"><span class="task-dep-id">${escapeHtml(task.id ?? '')}</span><span class="task-dep-subject">${escapeHtml(task.subject ?? task.id)}</span><span class="chip chip--state-${escapeHtml(task.state)}">${escapeHtml(taskStateLabel(task.state))}</span></div>`).join('')
  // Captain inbox: the member → captain messages still owed to the captain.
  const inbox = Array.isArray(team.captainInbox) ? team.captainInbox.slice(0, 8) : []
  const inboxHtml = inbox.length === 0 ? '' : `<section class="process"><div class="bubble-who">队长收件箱 · 最新 ${inbox.length} 条</div>${inbox.map(item => `<div class="bubble"><img class="bubble-portrait" src="${captainArtUrl()}" alt=""><div style="min-width:0;flex:1"><div class="bubble-who">${escapeHtml(item.from ?? '')}<span class="bubble-route">队长</span></div><div class="bubble-body"><div class="md">${renderMarkdown(item.content ?? '')}</div></div></div></div>`).join('')}</section>`
  return `<header class="inspector-head"><div><div class="inspector-meta"><span>${node.halted ? '已停止' : node.phase === 'running' ? '运行中' : '待确认'}</span><span>${(team.members ?? []).length} 名成员</span><span>${(team.tasks ?? []).filter(task => task.state === 'completed').length}/${(team.tasks ?? []).length} 任务完成</span></div><h2 class="inspector-title">${escapeHtml(team.name ?? team.teamId)}</h2></div><button class="inspector-close" type="button" data-action="close-inspector" aria-label="关闭详情" title="关闭"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button></header><div class="inspector-scroll"><div class="team-member-list">${members}</div>${tasks === '' ? '' : `<section class="process"><div class="bubble-who">任务依赖</div>${tasks}</section>`}${qualityPanelHtml(team)}${inboxHtml}</div><footer class="inspector-foot"></footer>`
}

function renderInspector() {
  if (state.inspectorId === null) return ''
  const node = state.sceneById?.get(state.inspectorId)
  if (node === undefined) return ''
  const body = node.kind === 'turn' ? renderTurnInspector(node) : node.kind === 'team' ? renderTeamInspector(node) : ''
  if (body === '') return ''
  return `<aside class="inspector${state.inspectorOpening ? ' is-opening' : ''}" aria-label="节点详情" data-inspector-node="${escapeHtml(node.id)}">${body}</aside>`
}

// -- Master render -----------------------------------------------------------
function render() {
  if (state.inspectorId !== null) {
    const inspector = document.querySelector('.inspector-scroll')
    if (inspector instanceof HTMLElement) state.inspectorScrollById.set(state.inspectorId, inspector.scrollTop)
  }
  const inspectorScrollTop = state.inspectorId !== null ? state.inspectorScrollById.get(state.inspectorId) ?? null : null
  const cardScrollTops = new Map()
  for (const body of document.querySelectorAll('.card--turn .card-body')) {
    if (body.scrollHeight <= body.clientHeight) continue
    const card = body.closest('[data-node]')
    if (card instanceof HTMLElement && card.dataset.node !== undefined) cardScrollTops.set(card.dataset.node, body.scrollTop)
  }

  const canvas = renderCanvasHtml()
  app.innerHTML = `<main class="stage-root"><header class="stage-topbar"><div class="canvas-toolbar">
    <button class="tool-btn" type="button" data-action="reset-canvas" title="重置画布：恢复自动布局与默认视角"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 1 1.5 3.6M3 8V4.5M3 8h3.5"/></svg></button>
    <span class="tool-sep"></span>
    <button class="tool-btn" type="button" data-action="zoom-out" aria-label="缩小" title="缩小"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"/></svg></button>
    <span class="tool-zoom">${Math.round(camera.zoom * 100)}%</span>
    <button class="tool-btn" type="button" data-action="zoom-in" aria-label="放大" title="放大"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button>
  </div></header><section class="stage-main">${state.error ? `<div class="error-toast" role="alert"><span>${escapeHtml(state.error)}</span><button data-action="dismiss-error" aria-label="关闭" title="关闭">×</button></div>` : ''}${canvas}<button class="follow-chip" type="button" data-action="follow-selection" hidden aria-label="基于所选内容创建追问" title="基于所选内容追问"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 3.5h10v6.25H7.2L4 12.5V9.75H3Z"/><path d="M8 4.9v3.4M6.3 6.6h3.4"/></svg><span>追问</span></button></section></main>`

  const isRegion = node => node.kind === 'teamRegion' || node.kind === 'memberRegion'
  regionVirtualizer = Engine.createVirtualizer({ layer: document.querySelector('.regions-layer'), margin: VIEWPORT_MARGIN, build: mountNode })
  nodeVirtualizer = Engine.createVirtualizer({ layer: document.querySelector('.nodes-layer'), margin: VIEWPORT_MARGIN, build: mountNode })
  tagAnchors()
  const viewport = document.querySelector('.canvas-viewport')
  if (viewport instanceof HTMLElement) {
    Engine.attachGestures({
      viewport,
      camera,
      interactive: target => {
        if (target.closest('button, textarea, select, input, form')) return true
        const node = target.closest('[data-node]')
        if (node === null) return false
        // Region backdrops are containers, not cards: their empty interior
        // pans the canvas; only the header bar acts as a click surface.
        if (node.dataset.nodeKind === 'teamRegion') return false
        if (node.dataset.nodeKind === 'memberRegion') return target.closest('.member-region-head') !== null
        return true
      },
      onGesture: active => { if (active) state.cameraTouched = true },
      allowWheel: event => {
        const card = event.target instanceof Element ? event.target.closest('[data-node]') : null
        if (card === null) { state.cameraTouched = true; return true }
        const body = card.querySelector('.card-body')
        if (body instanceof HTMLElement && body.scrollHeight > body.clientHeight) return false
        event.preventDefault()
        return false
      },
    })
  }
  cacheEdgeIndex()
  camera.apply(document.querySelector('.canvas-content'))
  syncViewport()
  if (state.needsCenter || !state.cameraTouched) {
    state.needsCenter = false
    window.requestAnimationFrame(focusActiveNode)
  }
  for (const [nodeId, scrollTop] of cardScrollTops) {
    const body = app.querySelector(`[data-node="${CSS.escape(nodeId)}"] .card-body`)
    if (body instanceof HTMLElement) body.scrollTop = scrollTop
  }
  if (inspectorScrollTop !== null) window.requestAnimationFrame(() => {
    const inspector = document.querySelector('.inspector-scroll')
    if (inspector instanceof HTMLElement) inspector.scrollTop = inspectorScrollTop
  })
  if (state.inspectorOpening) window.requestAnimationFrame(() => {
    document.querySelector('.inspector')?.classList.remove('is-opening')
    state.inspectorOpening = false
  })
}

function focusActiveNode() {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement) || state.scene === null || state.scene.nodes.length === 0) return
  const draft = state.scene.nodes.find(node => node.kind === 'draft')
  const activeTurns = state.activeId === null || state.activeId === undefined ? [] : state.scene.nodes.filter(node => node.kind === 'turn' && node.card.dshThreadId === state.activeId)
  const focus = draft ?? activeTurns.at(-1) ?? state.scene.nodes.find(node => node.kind === 'turn') ?? state.scene.nodes[0]
  camera.centerOn(focus.rect, viewport)
  syncViewport()
}
function setError(error = '') { state.error = error instanceof Error ? error.message : error; render() }

let inspectorCloseTimer = 0
function openInspector(nodeId) {
  if (inspectorCloseTimer !== 0) { window.clearTimeout(inspectorCloseTimer); inspectorCloseTimer = 0 }
  state.inspectorOpening = state.inspectorId === null
  state.inspectorId = nodeId
}
function closeInspector({ animate = true } = {}) {
  if (state.inspectorId === null) return
  if (inspectorCloseTimer !== 0) window.clearTimeout(inspectorCloseTimer)
  const nodeId = state.inspectorId
  const inspector = document.querySelector('.inspector')
  if (!animate || !(inspector instanceof HTMLElement)) {
    state.inspectorId = null
    state.inspectorOpening = false
    render()
    return
  }
  inspector.classList.add('is-closing')
  inspectorCloseTimer = window.setTimeout(() => {
    inspectorCloseTimer = 0
    if (state.inspectorId !== nodeId) return
    state.inspectorId = null
    state.inspectorOpening = false
    render()
  }, 180)
}

export { camera, render, focusActiveNode, setError, openInspector, closeInspector }
