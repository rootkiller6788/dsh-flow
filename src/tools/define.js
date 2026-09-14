// Defining a model-facing dsh-flow tool.
//
// The host's `ToolDefinition` requires a canonical `output` declaration —
// `{ schema, render }` — and rejects registration without one. That requirement
// is the reason this helper exists rather than each tool building its own
// object: a tool's output shape is part of its design, not an afterthought, and
// the renderer that turns a value into model-facing content is where a UI gets
// its structure from.
//
// `parameters` is the host's spec map (`name -> { type, required, description }`),
// not raw JSON Schema. A missing `required` means optional.

/**
 * Declare a tool that answers with a JSON object.
 *
 * Most flow tools return structured records, and writing the output schema out
 * per tool invites the schema and the body to drift apart. A `properties`
 * declaration keeps them adjacent.
 *
 * @param options.name - the tool name, e.g. `flow_create`.
 * @param options.description - what the model reads to decide whether to call it.
 * @param options.parameters - the argument spec map.
 * @param options.properties - the output object's property types.
 * @param options.required - output properties that are always present.
 * @param options.render - `(args, value) => [{ type: 'text', text }]`; defaults
 *   to the pretty-printed value, which is what most of these want.
 * @param options.execute - `async (args, exec) => value`.
 * @param options.isConcurrencySafe - `(args) => boolean`; default exclusive.
 * @returns a `ToolDefinition`.
 */
export function defineFlowTool(options) {
  const { name, description, parameters, properties, required, execute, isConcurrencySafe } = options
  if (typeof name !== 'string' || name === '') throw new Error('a flow tool needs a name')
  if (typeof description !== 'string' || description === '') {
    throw new Error(`${name} needs a description; the model reads it to decide whether to call`)
  }
  if (typeof execute !== 'function') throw new Error(`${name} needs an execute function`)

  const definition = {
    name,
    description,
    parameters: parameters ?? {},
    output: {
      schema: {
        type: 'object',
        ...properties === undefined ? {} : { properties },
        ...required === undefined ? {} : { required },
      },
      render: options.render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]),
    },
    async execute(args, exec) {
      return execute(args, exec)
    },
  }
  if (typeof isConcurrencySafe === 'function') definition.isConcurrencySafe = isConcurrencySafe
  return definition
}

/**
 * Declare a tool that answers with a single string.
 *
 * Reports and error explanations are text; making them carry a JSON envelope
 * would only make the model unwrap it.
 */
export function defineTextTool(options) {
  const { name, description, parameters, execute } = options
  return {
    name,
    description,
    parameters: parameters ?? {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return execute(args, exec)
    },
  }
}

/**
 * A refusal that reads as an instruction.
 *
 * A tool that only says "no" leaves the model guessing; the flow tools refuse
 * by naming the rule that rejected the call, so the next attempt has somewhere
 * to go.
 */
export class FlowToolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FlowToolError'
  }
}
