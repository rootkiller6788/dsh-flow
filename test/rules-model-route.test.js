// Contract for choosing a member's model route.
//
// `members.ts` cannot be imported here (it depends on `@deepseek-ai/dsh-agent`),
// so these expectations are transcribed from the rule in the source, not from
// this implementation. The rule is fully determined, which is what makes that
// transcription checkable rather than circular.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMemberRoute, DEFAULT_EFFORT_SENTINEL } from '../src/rules/index.js'

const CAPTAIN = { provider: 'deepseek', model: 'v4-pro', reasoningEffort: 'high' }
const route = (request, current = CAPTAIN) => resolveMemberRoute(request, current)

test('an ordinary member inherits the captain route and effort', () => {
  // source: provider = explicit ?? current; model = explicit ?? default ?? current
  //         effort  = sameRoute ? current effort : undefined
  assert.deepEqual(route({}), { route: { provider: 'deepseek', model: 'v4-pro', reasoningEffort: 'high' }, sameRoute: true })
})

test('an explicit provider without a model is refused', () => {
  assert.match(route({ provider: 'other' }).error, /requires an explicit member model/)
})

test('an explicit pair is used as given', () => {
  assert.deepEqual(route({ provider: 'other', model: 'small' }),
    { route: { provider: 'other', model: 'small' }, sameRoute: false })
})

test('changing the route drops the captain effort', () => {
  // The captain's effort id belongs to the captain's model; handing it to a
  // different model is at best ignored and at worst a rejected call.
  const changed = route({ provider: 'other', model: 'small' })
  assert.ok(!('reasoningEffort' in changed.route))
  const sameProviderNewModel = route({ model: 'v4-lite' })
  assert.ok(!('reasoningEffort' in sameProviderNewModel.route))
})

test('the configured default model sits between explicit and inherited', () => {
  assert.deepEqual(route({ defaultModel: 'v4-lite' }).route, { provider: 'deepseek', model: 'v4-lite' })
  assert.deepEqual(route({ model: 'v4-turbo', defaultModel: 'v4-lite' }).route, { provider: 'deepseek', model: 'v4-turbo' })
})

test('an explicit effort always wins, even on an unchanged route', () => {
  assert.deepEqual(route({ reasoningEffort: 'low' }).route,
    { provider: 'deepseek', model: 'v4-pro', reasoningEffort: 'low' })
})

test('the default sentinel asks the target model, even without a route change', () => {
  assert.equal(DEFAULT_EFFORT_SENTINEL, 'default')
  const sentinel = route({ reasoningEffort: 'default' })
  assert.ok(!('reasoningEffort' in sentinel.route), 'the sentinel means "no effort chosen here"')
  assert.equal(sentinel.sameRoute, true)
})

test('an explicit effort on a changed route is still honoured', () => {
  assert.deepEqual(route({ provider: 'other', model: 'small', reasoningEffort: 'low' }).route,
    { provider: 'other', model: 'small', reasoningEffort: 'low' })
})

test('blank explicit values are refused rather than treated as unset', () => {
  // An empty string reads as "unset" and would fall through to the captain's
  // route, which is never what someone who set the field meant.
  for (const [field, message] of [
    ['provider', /provider must not be empty/],
    ['model', /model must not be empty/],
    ['defaultModel', /memberModel must not be empty/],
    ['reasoningEffort', /reasoning effort must not be empty/],
  ]) {
    assert.match(route({ [field]: '   ' }).error, message)
  }
})

test('surrounding whitespace is trimmed, not significant', () => {
  assert.deepEqual(route({ provider: '  other  ', model: '  small  ' }).route,
    { provider: 'other', model: 'small' })
})

test('a captain with no route at all is refused', () => {
  assert.match(resolveMemberRoute({}, {}).error, /cannot resolve the member LLM route/)
  assert.match(resolveMemberRoute({}, { provider: 'deepseek' }).error, /cannot resolve/)
  assert.match(resolveMemberRoute({}, { model: 'v4' }).error, /cannot resolve/)
})

test('a captain route with no effort propagates no effort', () => {
  // sameRoute is true but there is nothing to carry over.
  const result = resolveMemberRoute({}, { provider: 'p', model: 'm' })
  assert.deepEqual(result, { route: { provider: 'p', model: 'm' }, sameRoute: true })
})
