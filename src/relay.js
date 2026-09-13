// dsh-flow canvas — see src/canvas.js for the module map.
// Agent-injected message parsing (mirror of index.js' projection rules).


// ---------------------------------------------------------------------------
// Agent-injected messages
//
// The projection (index.js) strips the harness/agent-teams envelopes into
// message.agent for new events; this parser is the same rules applied lazily
// to messages stored before that existed. Shapes:
//   Agent <uuid> sent a message:【A → B】body   /  without the route
//   AgentTeams message from member <name>: body
//   Background subagent <uuid> … Its closing message: body
// ---------------------------------------------------------------------------
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

function agentTitle(agent) {
  if (agent.kind === 'notice') return agent.label ?? '子代理通知'
  if (agent.to && agent.to !== 'parent') return `${agent.from} → ${agent.to}`
  return agent.from
}

/** {kind, from, to, label, text, title} | null — agent traffic carried by this message. */
function relayOf(message) {
  const stored = message?.agent
  if (stored && typeof stored === 'object') {
    const agent = { kind: stored.kind ?? 'relay', agentId: stored.agentId ?? null, from: stored.from ?? '成员', to: stored.to ?? '', label: stored.label, text: typeof message.text === 'string' ? message.text : '' }
    return { ...agent, title: agentTitle(agent) }
  }
  const parsed = classifyAgentText(message?.text)
  if (parsed === null) return null
  return { ...parsed, title: agentTitle(parsed) }
}


export { relayOf }
