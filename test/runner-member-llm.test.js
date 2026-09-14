// Contract for resolving a member's route against a (faked) host.
//
// What this can prove: the captain's live route is read from the right place,
// the adapter is asked to validate exactly the route that was decided, and a
// rejection from the adapter is not swallowed. What it cannot prove: that a real
// adapter validates the way the fake does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captainRoute, resolveMemberLlmSelection } from '../src/runner/member-llm.js'

const captain = options => ({
  options,
  session: options?.requestConfig === undefined ? {} : { requestHeader: () => ({ config: options.requestConfig }) },
})

const ctxWith = answer => ({
  llm: {
    calls: [],
    async resolveCallConfig(config, signal) {
      this.calls.push({ config, signal })
      if (typeof answer === 'function') return answer(config)
      return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
    },
  },
})

test('the live request config wins over the creation options', () => {
  // The captain may have been switched to another model since it was created,
  // and the newer statement of intent is the one in flight.
  assert.deepEqual(
    captainRoute(captain({ provider: 'old', model: 'old-model', requestConfig: { provider: 'new', model: 'new-model', reasoningEffort: 'high' } })),
    { provider: 'new', model: 'new-model', reasoningEffort: 'high' },
  )
})

test('creation options are the fallback when no request is in flight', () => {
  assert.deepEqual(captainRoute(captain({ provider: 'p', model: 'm' })), { provider: 'p', model: 'm', reasoningEffort: undefined })
  assert.deepEqual(captainRoute({ options: {} }), { provider: undefined, model: undefined, reasoningEffort: undefined })
  // A session that cannot answer at all must not throw here.
  assert.deepEqual(captainRoute({ options: { provider: 'p', model: 'm' }, session: { requestHeader: () => undefined } }),
    { provider: 'p', model: 'm', reasoningEffort: undefined })
})

test('the adapter is asked to validate exactly the decided route', async () => {
  const ctx = ctxWith()
  const result = await resolveMemberLlmSelection(ctx, captain({ provider: 'p', model: 'm', requestConfig: { provider: 'p', model: 'm', reasoningEffort: 'high' } }), {})
  assert.deepEqual(ctx.llm.calls[0].config, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(result, { provider: 'p', model: 'm', reasoningEffort: 'high' })
})

test('the adapter finalises the answer, including effort it chose itself', async () => {
  // The adapter may resolve a provider alias or fill in a default effort, so the
  // result must come from its answer rather than from the request.
  const ctx = ctxWith(config => ({ provider: `resolved-${config.provider}`, model: `resolved-${config.model}`, reasoningEffort: 'medium' }))
  const result = await resolveMemberLlmSelection(ctx, captain({ provider: 'p', model: 'm' }), {})
  assert.deepEqual(result, { provider: 'resolved-p', model: 'resolved-m', reasoningEffort: 'medium' })
})

test('an effort the adapter rejects is surfaced, not swallowed', async () => {
  // This is the boundary that validates the effort id: pure JS cannot brand it,
  // and an id belonging to another model must fail here rather than later.
  const ctx = ctxWith(() => { throw new Error('UNSUPPORTED_REASONING_EFFORT') })
  await assert.rejects(
    () => resolveMemberLlmSelection(ctx, captain({ provider: 'p', model: 'm' }), { reasoningEffort: 'turbo' }),
    /UNSUPPORTED_REASONING_EFFORT/,
  )
})

test('a route that cannot be decided never reaches the adapter', async () => {
  const ctx = ctxWith()
  await assert.rejects(() => resolveMemberLlmSelection(ctx, captain({}), {}), /cannot resolve/)
  assert.equal(ctx.llm.calls.length, 0, 'no call is made for a route we could not decide')
})

test('the fallback route is carried through, not resolved', async () => {
  const ctx = ctxWith()
  const fallback = { provider: 'backup', model: 'small' }
  const result = await resolveMemberLlmSelection(ctx, captain({ provider: 'p', model: 'm' }), { fallback })
  assert.deepEqual(result.fallback, fallback)
  assert.deepEqual(ctx.llm.calls[0].config, { provider: 'p', model: 'm' }, 'the fallback is not the route being validated')
})

test('the cancellation signal reaches the adapter', async () => {
  const ctx = ctxWith()
  const controller = new AbortController()
  await resolveMemberLlmSelection(ctx, captain({ provider: 'p', model: 'm' }), {}, controller.signal)
  assert.equal(ctx.llm.calls[0].signal, controller.signal)
})
