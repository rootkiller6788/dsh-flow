// Registering the model-facing tools.
//
// Every registration is an effect on `ctx`, so unloading the plugin removes its
// tools the way the host expects. The tool bodies read and write only through
// the injected `deps`, which is what keeps them testable without a store and
// keeps the store free of tool-shaped logic.
import { approveTeamTool, createTeamTool, editPlanTool } from './lifecycle.js'

/**
 * Register every dsh-flow tool.
 *
 * @param ctx - the plugin context; `ctx.tools.register` must exist.
 * @param deps - the operations the tools use. See the call sites below for the
 *   exact set; each is injected rather than imported so a test can supply a
 *   recording double.
 * @returns the registered tool names, in registration order.
 */
export function installFlowTools(ctx, deps) {
  const definitions = [
    createTeamTool(deps),
    editPlanTool(deps),
    approveTeamTool(deps),
  ]
  for (const definition of definitions) ctx.tools.register(definition)
  return definitions.map(definition => definition.name)
}

export { createTeamTool, editPlanTool, approveTeamTool }
