import assert from 'node:assert/strict'
import { parseOfficialSpec, accountSpec, createSpecCache, SPEC_TTL_MS } from './specs.js'
import { planProvider, routeAdapter, loadBundled } from './index.js'
const id = 'gpt-6.2-sol'
const doc = `# GPT-6.2 Sol
Model ID: \`${id}\`
The API rejects requests that set reasoning effort to \`none\`.
## Model details
- Input modalities: text, image
- Output modalities: text
- 1,050,000 context window
- Maximum input tokens: 922,000
- 128,000 max output tokens
- Jun 01, 2026 knowledge cutoff
- Reasoning token support
## Pricing
### Text tokens
| Metric | Price | Unit |
| Input | $2 | 1M tokens |
| Cached input | $0.1 | 1M tokens |
| Output | $10 | 1M tokens |
## Endpoints
| Responses | \`v1/responses\` | Supported |
| Image generation | \`v1/images/generations\` | Not supported |
## Supported features
- streaming
- function_calling
- image_input
## Unsupported features
- fine_tuning
## Supported tools
- image_generation
- web_search
## Model IDs
- \`${id}\`
`
const spec = parseOfficialSpec(id, doc)
assert.equal(spec.contextWindow, 1050000)
assert.equal(spec.maxInputTokens, 922000)
assert.equal(spec.maxOutputTokens, 128000)
assert.deepEqual(spec.inputModalities, ['text', 'image'])
assert.equal(spec.reasoningSupported, true)
assert.equal(spec.reasoningEfforts, undefined)
assert.equal(spec.rejectsReasoningNone, true)
assert.equal(spec.apiPricingPerMillion.input, 2)
assert.equal(spec.apiPricingPerMillion.cachedInput, 0.1)
assert.deepEqual(spec.features, ['streaming', 'function_calling', 'image_input'])
assert.equal(spec.endpoints[1].supported, false)
assert.throws(() => parseOfficialSpec('different-model', doc), /identity mismatch/)
assert.equal(parseOfficialSpec('unknown', 'Model ID: `unknown`\n## Model details\n- Not specified\n').contextWindow, undefined)
assert.deepEqual(accountSpec({ context_window: 500000, max_input_tokens: -1, input_modalities: ['text', 'image', 'script'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] }), {
  contextWindow: 500000, inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'max'],
})
let calls = 0
let fail = false
const cache = createSpecCache(async (url, options) => {
  assert.equal(new URL(url).origin, 'https://developers.openai.com')
  assert.equal(options.headers, undefined)
  calls++
  return fail ? new Response('', { status: 503 }) : new Response(doc)
})
const clock = Date.now
let time = clock()
Date.now = () => time
try {
  assert.equal((await cache.load([id])).get(id).contextWindow, 1050000)
  assert.equal((await cache.load([id])).get(id).maxOutputTokens, 128000)
  assert.equal(calls, 1)
  time += SPEC_TTL_MS + 1
  fail = true
  assert.equal((await cache.load([id])).get(id).stale, true)
  assert.equal((await cache.load([id])).get(id).stale, true, 'negative cache preserves the stale marker')
} finally { Date.now = clock }
// An aggregate deadline must retain verified specs for both in-flight and queued models.
const ids = [id, 'gpt-6.2-astra', 'extra-1', 'extra-2', 'extra-3']
let abortFetch = false
const deadline = new AbortController()
const abortCache = createSpecCache(async url => {
  if (abortFetch) { deadline.abort(); throw new Error('Total deadline reached') }
  return new Response(doc.replaceAll(id, decodeURIComponent(new URL(url).pathname.split('/').at(-1).replace(/\.md$/, ''))))
})
time = clock()
Date.now = () => time
try {
  assert.equal((await abortCache.load(ids)).size, ids.length)
  time += SPEC_TTL_MS + 1
  abortFetch = true
  const retained = await abortCache.load(ids, deadline.signal)
  assert.equal(retained.size, ids.length)
  for (const value of retained.values()) { assert.equal(value.contextWindow, 1050000); assert.equal(value.stale, true) }
} finally { Date.now = clock }
const bundled = await loadBundled()
const provider = planProvider(bundled, new Map([[id, 'GPT-6.2 Sol']]), new Map([[id, spec]]))
const model = provider.getModels()[0]
assert.equal(model.contextWindow, 1050000)
assert.equal(model.maxTokens, 128000)
assert.deepEqual(model.input, ['text', 'image'])
const native = {
  resolveModel: async () => ({ id, context: { contextWindow: 32768 }, reasoning: { efforts: [{ id: 'minimal' }] } }),
}
const decorated = routeAdapter(native, () => new Map([[id, spec]]))
assert.equal((await decorated.resolveModel('chatgpt-plan', id)).context.contextWindow, 1050000)
assert.equal((await decorated.resolveModel('chatgpt-plan', id)).reasoning, undefined)
assert.equal((await routeAdapter(native).resolveModel('chatgpt-plan', id)).context, undefined)
console.log('PASS: official spec identity, exact limits/modalities/features/pricing, account overrides, cache/stale handling, verified GUI context and unknown-field suppression')
