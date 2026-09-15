// dsh-flow canvas — see src/canvas/canvas.js for the module map.
import { state, Engine, CLUSTER_GAP, TURN_W, TURN_H } from './core.js'
import { conversationCards, conversationGraphView, draftPlacement } from './session.js'
import { buildTeamHierarchy, buildFallbackCluster } from './teams.js'


// ---------------------------------------------------------------------------
// Unified scene: requirement timeline + nested team regions + typed edges
// ---------------------------------------------------------------------------
function buildScene() {
  const threads = state.workspace?.threads ?? []
  const turnCards = conversationCards(threads)
  const graph = conversationGraphView(turnCards)
  const nodes = []
  const edges = []
  let maxX = 86 + TURN_W
  // Link each team to its owning session; the linked thread's turns are
  // re-composed into the hierarchy (human turns on the main row, agent turns
  // inside their member sub-regions) before any node is built.
  const hierarchies = []
  const unanchored = []
  const claimedThreads = new Set()
  for (const team of state.teams) {
    const thread = threads.find(item => item.dshSessionId === team.captainSessionId)
    // One thread composes with ONE team: a second team reusing the same
    // session would fight over the same turns' geometry, so it falls back
    // to a standalone cluster beside the timeline.
    if (thread !== undefined && claimedThreads.has(thread.id)) { unanchored.push(team); continue }
    const threadCards = thread === undefined ? [] : graph.cards.filter(card => card.dshThreadId === thread.id)
    if (threadCards.length > 0) { claimedThreads.add(thread.id); hierarchies.push({ team, threadCards, built: buildTeamHierarchy(team, threadCards, graph.cards) }) }
    else unanchored.push(team)
  }
  for (const { threadCards, built } of hierarchies) {
    for (const card of threadCards) card.position = built.cardPositions.get(card.id) ?? card.position
  }
  for (const card of graph.cards) {
    nodes.push({ id: card.id, kind: 'turn', rect: { x: card.position.x, y: card.position.y, w: TURN_W, h: TURN_H }, card })
    maxX = Math.max(maxX, card.position.x + TURN_W)
  }
  for (const card of graph.cards) {
    if (card.parentId === null) continue
    if (!graph.cards.some(candidate => candidate.id === card.parentId)) continue
    edges.push({ from: card.parentId, to: card.id, cls: `edge--fork${card.dshThreadId === state.activeId ? ' is-active' : ''}` })
  }
  const placement = draftPlacement(graph.cards)
  if (placement !== null) {
    nodes.push({
      id: 'draft', kind: 'draft', rect: { x: placement.position.x, y: placement.position.y, w: TURN_W, h: 224 },
      draft: state.draft, parentId: placement.parent.id,
    })
    edges.push({ from: placement.parent.id, to: 'draft', cls: 'edge--draft' })
  }
  if (state.draft?.kind === 'new') {
    nodes.push({ id: 'draft', kind: 'draft', rect: { x: 86, y: 82, w: TURN_W, h: 224 }, draft: state.draft, parentId: null })
  }
  const regionNodes = []
  for (const { built } of hierarchies) {
    regionNodes.push(...built.regionNodes)
    nodes.push(...built.nodes)
    edges.push(...built.edges)
    const outer = built.regionNodes[0]
    maxX = Math.max(maxX, outer.rect.x + outer.rect.w)
  }
  // Regions go to the back so their contents sit above them.
  nodes.unshift(...regionNodes)
  let cursorY = 82
  for (const team of unanchored) {
    const built = buildFallbackCluster(team, { x: maxX + CLUSTER_GAP, y: cursorY })
    nodes.push(...built.nodes)
    edges.push(...built.edges)
    cursorY = cursorY + built.height + 60
  }
  return { nodes, edges, graph, turnCards }
}

// ---------------------------------------------------------------------------
// Edge geometry: horizontal chains get a horizontal bezier; vertically
// stacked nodes (cluster header → member) get a vertical one.
// ---------------------------------------------------------------------------
function edgePathFor(a, b) {
  const horizontalOverlap = a.x < b.x + b.w && b.x < a.x + a.w
  if (!horizontalOverlap) return Engine.edgePath(a, b)
  const x1 = a.x + a.w / 2
  const y1 = a.y + a.h
  const x2 = b.x + b.w / 2
  const y2 = b.y
  const bend = Math.min(110, Math.max(30, Math.abs(y2 - y1) * 0.3))
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`
}

export { buildScene, edgePathFor }
