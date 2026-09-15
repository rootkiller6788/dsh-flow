// dsh-flow canvas — see src/canvas/canvas.js for the module map.
import { state, api, clusterPositions, canReplaceView, CLUSTER_GAP, TEAMS_URL, TURN_W, TURN_H, TEAM_W, TEAM_H, MEMBER_W, MEMBER_H, MEMBER_GAP, TASK_W, TASK_H, TASK_GAP_X, TASK_GAP_Y } from './core.js'
import { render } from './view.js'


// ---------------------------------------------------------------------------
// Team layer (dsh-flow's own team store)
// ---------------------------------------------------------------------------
/**
 * Read the teams from dsh-flow's own store.
 *
 * This used to poll agent-teams' live feed and mirror a copy into local
 * storage, because the canvas was a view of somebody else's state. The store
 * has been the source since the kernel was mounted, so it is one read now —
 * and one read is the point: a mirror is a second record of the same team, and
 * the two could disagree about what happened.
 */
async function pollTeams() {
  let body
  try {
    body = await api(TEAMS_URL)
    state.teamsError = false
  } catch {
    // The route is served by this same plugin, so this failing means the
    // server is not answering rather than that a dependency is missing.
    state.teamsError = true
    state.teamsLoaded = true
    if (canReplaceView()) render()
    return
  }
  state.teamsLoaded = true
  const snapshots = Array.isArray(body?.teams) ? body.teams : []
  // The signature decides whether anything a view reads has changed, so an idle
  // poll costs one render and no DOM work.
  const signature = JSON.stringify(snapshots.map(team => [
    team.teamId, team.name, team.phase, team.halted, team.archived,
    (team.members ?? []).map(member => [member.name, member.status, member.done, member.total, member.unread, member.currentTask]),
    (team.tasks ?? []).map(task => [task.id, task.state, task.assignee, task.depth]),
  ]))
  if (signature === state.teamsSignature) return
  state.teamsSignature = signature
  state.teams = snapshots
  if (canReplaceView()) render()
}

const TASK_STATE_LABEL = { open: '待办', running: '进行中', completed: '完成', failed: '失败', blocked: '阻塞', cancelled: '取消' }
function taskStateLabel(value) { return TASK_STATE_LABEL[value] ?? String(value ?? '') }

/**
 * The unified composition: the owning conversation's turns are WOVEN into the
 * team's member lanes. Time flows left→right (one column per turn); the
 * vertical axis is the speaker (对话 / 队长 / each member). A member speech
 * turn sits on that member's lane at its own time position, so the dialogue
 * chain zigzags across lanes and "who said what when" is the layout itself —
 * hierarchy and time in one figure, not two stacked views.
 */
const HEAD_H = 48
const REGION_PAD = 14

/**
 * Hierarchical composition: the user's requirement stays on the main
 * timeline; the team becomes a REGION nested under it, and each agent gets a
 * SUB-REGION inside the team that contains its tasks and its own speech
 * turns in time order. Assignment is expressed by containment (no wires),
 * dependency by arrows, dialogue flow by the turn chain weaving across
 * regions. Hierarchy first, time second — not two parallel strips.
 */
function buildTeamHierarchy(team, threadCards, allCards) {
  const nodes = []
  const edges = []
  const teamId = team.teamId
  const headerKey = `team:${teamId}`
  const members = team.members ?? []
  const taskList = team.tasks ?? []
  const captainName = team.captainName ?? '队长'
  const roster = [{ name: captainName, isCaptain: true, member: null }, ...members.map(member => ({ name: member.name, isCaptain: false, member }))]

  // Split the thread: human-driven turns remain on the main timeline, agent
  // speech turns drop into their speaker's sub-region.
  const mainTurns = []
  const turnsByMember = new Map(roster.map(entry => [entry.name, []]))
  for (const card of threadCards) {
    if (card.agentEvent === null) { mainTurns.push(card); continue }
    const bucket = turnsByMember.get(card.agentEvent.from) ?? turnsByMember.get(captainName)
    bucket.push(card)
  }

  // Per-member geometry: tasks block on the left of the region, speech turns
  // to the right in time order.
  const assigneeOf = task => {
    const assignee = task.assignee && task.assignee !== '' ? task.assignee : 'captain'
    if (assignee === 'captain') return captainName
    return assignee
  }
  // Turns wrap into a grid inside each member region, so a member with many
  // turns grows DOWN, not sideways — regions stay about one screen wide.
  const GRID_COLS = 4
  const memberGeom = roster.map(entry => {
    const tasks = taskList.filter(task => assigneeOf(task) === entry.name)
    const maxDepth = tasks.reduce((max, task) => Math.max(max, Number.isInteger(task.depth) ? task.depth : 0), 0)
    const tasksW = tasks.length === 0 ? 0 : (maxDepth + 1) * (TASK_W + TASK_GAP_X)
    const turns = turnsByMember.get(entry.name)
    const rows = (tasks.length === 0 ? 0 : 1) + Math.max(1, Math.ceil(turns.length / GRID_COLS))
    return { ...entry, tasks, turns, tasksW, rows }
  })
  const memberW = Math.max(...memberGeom.map(geom => Math.max(geom.tasksW, GRID_COLS * (TURN_W + 30))), 340)
  const memberHOf = geom => HEAD_H + 10 + geom.rows * (TURN_H + 18) + 8
  const regionW = REGION_PAD * 2 + Math.max(memberW, 520)
  const teamBarH = 48
  const regionH = teamBarH + 12 + memberGeom.reduce((sum, geom) => sum + memberHOf(geom) + 12, 0) + REGION_PAD

  // The region grows under the last human-driven turn of the conversation,
  // sliding below any other thread's cards in its footprint.
  const anchor = mainTurns.length > 0 ? mainTurns[mainTurns.length - 1] : threadCards[0]
  let origin = { x: anchor.position.x, y: anchor.position.y + TURN_H + 60 }
  while (Array.isArray(allCards) && allCards.some(card => card.dshThreadId !== firstThreadId(threadCards) && origin.x < card.position.x + TURN_W && origin.x + regionW > card.position.x && origin.y < card.position.y + TURN_H && origin.y + regionH > card.position.y)) origin.y += 64

  function firstThreadId(cards) { return cards[0]?.dshThreadId }

  // Team title bar inside the region.
  nodes.push({
    id: headerKey, kind: 'team', teamId, fixed: true,
    rect: { x: origin.x + REGION_PAD, y: origin.y + 12, w: regionW - REGION_PAD * 2, h: teamBarH - 8 },
    name: team.name ?? teamId, phase: team.phase, halted: team.halted === true,
    memberCount: members.length, taskCount: taskList.length,
    taskDone: taskList.filter(task => task.state === 'completed').length,
  })

  const cardPositions = new Map()
  // Main timeline: compact the human-driven turns to their own row.
  const mainY = mainTurns[0]?.position.y ?? anchor.position.y
  mainTurns.forEach((card, index) => cardPositions.set(card.id, { x: anchor.position.x + index * (TURN_W + 60), y: mainY }))

  // Member sub-regions stacked inside the team region.
  const regionNodes = [{
    id: `${headerKey}:region`, kind: 'teamRegion', teamId,
    rect: { x: origin.x - 14, y: origin.y - 12, w: regionW + 28, h: regionH + 12 },
  }]
  let memberY = origin.y + teamBarH + 12
  for (const geom of memberGeom) {
    const memberX = origin.x + REGION_PAD
    const memberH = memberHOf(geom)
    regionNodes.push({
      id: `${headerKey}:member:${geom.name}`, kind: 'memberRegion', teamId,
      name: geom.name, isCaptain: geom.isCaptain, member: geom.member,
      rect: { x: memberX, y: memberY, w: regionW - REGION_PAD * 2, h: memberH },
    })
    const contentY = memberY + HEAD_H + 10
    // Tasks: depth columns inside the region.
    const byDepth = new Map()
    for (const task of geom.tasks) {
      const depth = Number.isInteger(task.depth) ? task.depth : 0
      if (!byDepth.has(depth)) byDepth.set(depth, [])
      byDepth.get(depth).push(task)
    }
    for (const [depth, group] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      group.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      group.forEach((task, row) => {
        const key = `${headerKey}:task:${task.id}`
        nodes.push({
          id: key, kind: 'task', teamId, rect: clusterPositions.get(key) ?? { x: memberX + REGION_PAD + depth * (TASK_W + TASK_GAP_X), y: contentY + row * (TASK_H + TASK_GAP_Y), w: TASK_W, h: TASK_H },
          subject: task.subject ?? task.id, state: task.state ?? 'open', taskKind: task.kind, verdict: task.verdict, taskId: task.id,
        })
      })
    }
    // Dependency arrows inside the region (assignment is containment here).
    const taskById = new Map(geom.tasks.map(task => [task.id, task]))
    for (const task of geom.tasks) {
      for (const depId of task.dependencies ?? []) {
        const fromId = `${headerKey}:task:${depId}`
        const toId = `${headerKey}:task:${task.id}`
        if (taskById.has(depId)) edges.push({ from: fromId, to: toId, cls: 'edge--dep' })
      }
    }
    // This member's speech turns: a wrap-around grid below the task row,
    // time order preserved left→right then top→bottom.
    const turnRow0 = geom.tasks.length === 0 ? 0 : 1
    geom.turns.forEach((card, index) => {
      const gridRow = turnRow0 + Math.floor(index / GRID_COLS)
      const col = index % GRID_COLS
      cardPositions.set(card.id, { x: memberX + REGION_PAD + col * (TURN_W + 30), y: contentY + gridRow * (TURN_H + 18) })
    })
    memberY += memberH + 12
  }
  return { nodes, edges, regionNodes, cardPositions, height: regionH }
}

/** Teams whose owning session is not on this canvas keep a standalone cluster. */
function buildFallbackCluster(team, origin) {
  const nodes = []
  const edges = []
  const teamId = team.teamId
  const headerKey = `team:${teamId}`
  const members = team.members ?? []
  const taskList = team.tasks ?? []
  const captainName = team.captainName ?? '队长'
  nodes.push({
    id: headerKey, kind: 'team', teamId,
    rect: { x: origin.x, y: origin.y, w: TEAM_W, h: TEAM_H },
    name: team.name ?? teamId, phase: team.phase, halted: team.halted === true,
    memberCount: members.length, taskCount: taskList.length,
    taskDone: taskList.filter(task => task.state === 'completed').length,
  })
  const memberNodesByKey = new Map()
  ;[{ name: captainName, laneName: 'captain', isCaptain: true, member: null }, ...members.map(member => ({ name: member.name, laneName: member.name, isCaptain: false, member }))].forEach((lane, index) => {
    const key = `${headerKey}:member:${lane.laneName}`
    const position = clusterPositions.get(key) ?? { x: origin.x, y: origin.y + TEAM_H + 26 + index * (MEMBER_H + MEMBER_GAP) }
    const member = lane.member
    const node = {
      id: key, kind: 'member', teamId, laneName: lane.laneName, rect: { x: position.x, y: position.y, w: MEMBER_W, h: MEMBER_H },
      name: lane.name, isCaptain: lane.isCaptain,
      role: lane.isCaptain ? '队长' : (member?.role ?? ''),
      status: lane.isCaptain ? 'captain' : (member?.status ?? 'idle'),
      model: member?.model ?? member?.activeModel ?? '',
      currentTask: member?.currentTask ?? '',
      done: member?.done ?? 0, total: member?.total ?? 0, unread: member?.unread ?? 0,
    }
    memberNodesByKey.set(lane.laneName, node)
    nodes.push(node)
    edges.push({ from: headerKey, to: key, cls: 'edge--kin' })
  })
  const assigneeOf = task => {
    const assignee = task.assignee && task.assignee !== '' ? task.assignee : 'captain'
    return assignee === 'captain' ? captainName : assignee
  }
  let cursorY = origin.y + TEAM_H + 26 + (members.length + 1) * (MEMBER_H + MEMBER_GAP)
  const taskNodes = []
  const byAssignee = new Map()
  for (const task of taskList) {
    const owner = assigneeOf(task)
    if (!byAssignee.has(owner)) byAssignee.set(owner, [])
    byAssignee.get(owner).push(task)
  }
  for (const [owner, tasks] of byAssignee) {
    const laneNode = memberNodesByKey.get(owner)
    const baseX = (laneNode?.rect.x ?? origin.x) + MEMBER_W + 64
    const baseY = laneNode?.rect.y ?? cursorY
    const byDepth = new Map()
    for (const task of tasks) {
      const depth = Number.isInteger(task.depth) ? task.depth : 0
      if (!byDepth.has(depth)) byDepth.set(depth, [])
      byDepth.get(depth).push(task)
    }
    for (const [depth, group] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      group.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      group.forEach((task, row) => {
        const key = `${headerKey}:task:${task.id}`
        const node = {
          id: key, kind: 'task', teamId, rect: clusterPositions.get(key) ?? { x: baseX + depth * (TASK_W + TASK_GAP_X), y: baseY + row * (TASK_H + TASK_GAP_Y), w: TASK_W, h: TASK_H },
          subject: task.subject ?? task.id, state: task.state ?? 'open', taskKind: task.kind, verdict: task.verdict, taskId: task.id,
        }
        taskNodes.push(node)
        nodes.push(node)
        edges.push({ from: (laneNode ?? nodes[0]).id, to: key, cls: 'edge--assign' })
      })
    }
  }
  const taskById = new Map(taskNodes.map(node => [node.taskId, node]))
  for (const task of taskNodes) {
    for (const depId of taskList.find(item => item.id === task.taskId)?.dependencies ?? []) {
      const from = taskById.get(depId)
      if (from === undefined) continue
      edges.push({ from: from.id, to: task.id, cls: 'edge--dep' })
    }
  }
  return { nodes, edges, height: cursorY - origin.y + taskNodes.reduce((max, node) => Math.max(max, node.rect.y + node.rect.h - origin.y), TEAM_H) }
}

export { pollTeams, buildTeamHierarchy, buildFallbackCluster, taskStateLabel }
