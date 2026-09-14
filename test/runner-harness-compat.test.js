// Contract for the host-contract probe.
//
// There is no live harness in the test process, so the tests supply fake
// services. What they check is the discipline the probe exists for: a gap is
// named rather than tolerated, every gap is named at once, and a property that
// exists but is not callable counts as missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UnsupportedHarnessError, probeSubagentRuntime, probeAgentRuntime,
  requireOperations, requireExecutorContracts, describeContracts,
} from '../src/runner/harness-compat.js'

const noop = () => {}
const full = () => ({
  subagents: {
    startContinuable: noop, followup: noop, interrupt: noop,
    drainContinuableDescendants: noop, listChildren: noop, registerContinuableSetup: noop,
  },
  agents: { get: noop },
})

test('a complete host probes clean', () => {
  const probe = probeSubagentRuntime(full())
  assert.equal(probe.present, true)
  for (const name of ['startContinuable', 'followup', 'interrupt', 'drainDescendants', 'listChildren', 'registerContinuableSetup']) {
    assert.equal(typeof probe[name], 'function', `${name} should probe as callable`)
  }
  assert.equal(typeof probeAgentRuntime(full()).get, 'function')
})

test('an absent service probes as absent rather than throwing', () => {
  // Probing is how the plugin decides what it can do; it must be safe to ask.
  const probe = probeSubagentRuntime({})
  assert.equal(probe.present, false)
  assert.equal(probe.startContinuable, undefined)
  assert.equal(requireOperations(probe, [], 'ctx.subagents'), probe)
})

test('a present-but-not-callable property counts as missing', () => {
  // The failure mode the original warns about: a version bump renames a method
  // and leaves the old name as a truthy non-function, so `if (x.followup)`
  // passes and the call throws somewhere less informative.
  const probe = probeSubagentRuntime({ subagents: { followup: 'yes', startContinuable: noop } })
  assert.equal(probe.followup, undefined)
  assert.throws(() => requireOperations(probe, ['startContinuable', 'followup'], 'ctx.subagents'), /missing followup/)
})

test('every missing operation is named at once', () => {
  assert.throws(
    () => requireOperations(probeSubagentRuntime({ subagents: { interrupt: noop } }), ['startContinuable', 'followup', 'interrupt'], 'ctx.subagents'),
    error => {
      assert.ok(error instanceof UnsupportedHarnessError)
      assert.match(error.message, /startContinuable, followup/)
      assert.doesNotMatch(error.message, /interrupt,/)
      return true
    },
  )
})

test('the executor requirement covers both services', () => {
  requireExecutorContracts(full())
  assert.throws(() => requireExecutorContracts({ subagents: full().subagents }), /ctx.agents is missing get/)
  assert.throws(() => requireExecutorContracts({ agents: { get: noop } }), /ctx.subagents is missing/)
})

test('the report answers what the deployment can do, without throwing', () => {
  const fullReport = describeContracts(full())
  assert.equal(fullReport.canDispatch, true)
  assert.equal(fullReport.canDeliver, true)
  assert.equal(fullReport.canInterrupt, true)
  assert.equal(fullReport.canDrain, true)

  const bare = describeContracts({})
  assert.equal(bare.canDispatch, false)
  assert.equal(bare.subagentsPresent, false)
  assert.deepEqual(Object.keys(bare.operations).sort(), [
    'drainContinuableDescendants', 'followup', 'interrupt', 'listChildren', 'registerContinuableSetup', 'startContinuable',
  ])
})

test('a half-capable host reports which half is missing', () => {
  // A host with delivery but no spawn is a real shape — it can keep an existing
  // member talking but cannot create one.
  const report = describeContracts({ subagents: { followup: noop }, agents: { get: noop } })
  assert.equal(report.canDeliver, true)
  assert.equal(report.canDispatch, false)
})

test('the error names dsh-flow and the harness, so the fix is not ambiguous', () => {
  try {
    requireExecutorContracts({})
    assert.fail('should have thrown')
  } catch (error) {
    assert.equal(error.name, 'UnsupportedHarnessError')
    assert.match(error.message, /^dsh-flow: unsupported Harness subagent contract/)
    assert.match(error.message, /ctx\.subagents/)
  }
})
