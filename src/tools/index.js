// Registering the model-facing tools.
//
// Every registration is an effect on `ctx`, so unloading the plugin removes its
// tools the way the host expects. The tool bodies read and write only through
// the injected `deps`, which is what keeps them testable without a store and
// keeps the store free of tool-shaped logic.
//
// The tools are grouped by what they change. Lifecycle decides what a team *is*;
// members decides who is on it; tasks decides what the work is and whether it is
// done; comms is how anyone finds out. The grouping is not decoration — it is
// the same split the role rules use, and a member is denied exactly the groups
// that shape rather than do.
import { approveTeamTool, createTeamTool, deleteTeamTool, editPlanTool, resumeTeamTool } from './lifecycle.js'
import { addMemberTool, removeMemberTool } from './members.js'
import { claimTaskTool, createTaskTool, reassignTaskTool, updateTaskTool } from './tasks.js'
import { sendMessageTool, statusTool } from './comms.js'

/**
 * Register every dsh-flow tool.
 *
 * @param ctx - the plugin context; `ctx.tools.register` must exist.
 * @param deps - the operations the tools use. See the call sites in each module
 *   for the exact set; each is injected rather than imported so a test can
 *   supply a recording double.
 * @param host - the two things only a live host can answer: whether a captain
 *   is online, and what a member is doing right now. Absent in a test, which is
 *   why every use of it is optional at the call site.
 * @returns the registered tool names, in registration order.
 */
export function installFlowTools(ctx, deps, host = {}) {
  const definitions = [
    createTeamTool(deps),
    editPlanTool(deps),
    approveTeamTool(deps),
    addMemberTool(deps),
    removeMemberTool(deps),
    createTaskTool(deps),
    reassignTaskTool(deps),
    claimTaskTool(deps),
    updateTaskTool(deps),
    sendMessageTool(deps, host),
    statusTool(deps, host),
    resumeTeamTool(deps),
    deleteTeamTool(deps),
  ]
  for (const definition of definitions) ctx.tools.register(definition)
  return definitions.map(definition => definition.name)
}

export {
  createTeamTool, editPlanTool, approveTeamTool, resumeTeamTool, deleteTeamTool,
  addMemberTool, removeMemberTool,
  createTaskTool, reassignTaskTool, claimTaskTool, updateTaskTool,
  sendMessageTool, statusTool,
}
