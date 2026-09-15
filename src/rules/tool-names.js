// Who may call what, and what each role is told.
//
// Ported in substance from agent-teams' `tool-names.ts` and the presentation
// half of `capabilities.ts`, with dsh-flow's own tool vocabulary. The names
// differ deliberately: the host's convention is to namespace your own services,
// and two plugins both registering `agent_teams_*` would collide. The
// *capability set* is what has to match — a member that could create teams
// would be a captain, whatever the tool is called.
//
// This module is pure: it decides a role from a record and a session id, and
// what that role must not reach. Installing the decision into a live agent is
// the runner's job.

/**
 * Every model-facing tool this plugin exposes.
 *
 * In the order a captain meets them: make a team, shape its plan, start it,
 * change who is on it, define the work, hand it out, report on it, talk, and
 * end it. The order is not cosmetic — it is what the registration order is
 * checked against, so the list and the registrations cannot disagree.
 */
export const FLOW_TOOL_NAMES = Object.freeze([
  'flow_create', 'flow_edit_plan', 'flow_approve',
  'flow_add_member', 'flow_remove_member',
  'flow_create_task', 'flow_reassign_task', 'flow_claim_task', 'flow_update_task',
  'flow_send_message', 'flow_status',
  'flow_resume', 'flow_delete',
])

/**
 * The subset a member may call: its own work, and nothing that shapes the team.
 *
 * Membership is a smaller job than captaincy, not a rank — a member claims,
 * updates, talks, and asks. Creating, approving, editing, reassigning, removing
 * and resuming all decide what the team *is*, which only the captain does.
 */
export const FLOW_MEMBER_TOOL_NAMES = Object.freeze([
  'flow_claim_task', 'flow_update_task', 'flow_send_message', 'flow_status',
])

/** The complement: tools a member must not reach. */
export const FLOW_CAPTAIN_TOOL_NAMES = Object.freeze(
  FLOW_TOOL_NAMES.filter(name => !FLOW_MEMBER_TOOL_NAMES.includes(name)),
)

/** What a session is, relative to one team. */
export const FLOW_ROLES = Object.freeze(['captain', 'member', 'unrelated'])

/**
 * The role a session plays in a team.
 *
 * Membership is by durable child session id, not by name: names are display
 * text a user may change, while the id is what the host routes by. A session
 * that is neither the captain nor a listed member is `unrelated` — not an
 * error, because most sessions on a machine have nothing to do with this team.
 *
 * @param team - the team record, or undefined.
 * @param sessionId - the agent's session id.
 * @returns one of `FLOW_ROLES`.
 */
export function roleInTeam(team, sessionId) {
  if (team === undefined || team === null) return 'unrelated'
  if (typeof sessionId !== 'string' || sessionId === '') return 'unrelated'
  if (team.captainSessionId === sessionId) return 'captain'
  const member = (team.members ?? []).find(item => item.id === sessionId)
  return member === undefined ? 'unrelated' : 'member'
}

/**
 * Tools a role must not reach.
 *
 * @param role - one of `FLOW_ROLES`.
 * @returns the denied names; empty for the captain and for unrelated sessions.
 */
export function deniedToolsFor(role) {
  return role === 'member' ? [...FLOW_CAPTAIN_TOOL_NAMES] : []
}

/** Whether a role is a member of any team, and so needs the member contract. */
export function isMemberRole(role) {
  return role === 'member'
}

/**
 * What a captain is told, once, at install time.
 *
 * The activation text names the trigger explicitly, including what is *not* a
 * request — mentioning or discussing the capability is not asking for it. That
 * distinction is the difference between a prompt and a trap.
 */
export const FLOW_ACTIVATION_PROMPT = 'dsh-flow provides multi-agent team collaboration. Apply these rules when the user requests it (including /dsh-flow) or when continuing an existing team. Mentioning, quoting, discussing, or declining dsh-flow alone is not a request to start work.'

/**
 * What a member is told, in place of the captain's instructions.
 *
 * A member is told to report a missing membership rather than invent a
 * replacement: the failure mode this prevents is a member that cannot see its
 * own team deciding to create a second one.
 */
export const FLOW_MEMBER_PROMPT = 'You are a dsh-flow member. Follow your assigned member persona and task contract. Use flow_claim_task, flow_update_task, flow_send_message and flow_status for your own work. Include the current attempt_id in updates; report completion or failure to the captain. Do not create, approve, edit or resume a team. If your durable membership is unavailable, report that to the parent instead of creating a replacement.'

/**
 * The prompt a session receives, given its role.
 *
 * @param role - one of `FLOW_ROLES`.
 * @param captainPrompt - the deployment's own captain instructions.
 * @returns the text for that role.
 */
export function promptForRole(role, captainPrompt) {
  if (role === 'member') return FLOW_MEMBER_PROMPT
  return `${FLOW_ACTIVATION_PROMPT}\n\n${captainPrompt}`
}
