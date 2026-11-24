// Public documentation only. Never execute page JavaScript or send account credentials here.
export const SPEC_TTL_MS = 60 * 60 * 1000
const DOC_ROOT = 'https://developers.openai.com/api/docs/models/'
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 20_000_000 ? value : undefined
const number = value => positive(Number(value?.replaceAll(',', '')))
const section = (text, title) => text.match(new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1] ?? ''
const bullets = text => [...text.matchAll(/^\s*- ([a-z][a-z0-9_]*)\s*$/gm)].map(match => match[1])

export function parseOfficialSpec(id, text, source = `${DOC_ROOT}${encodeURIComponent(id)}.md`) {
  if (!text.includes(`Model ID: \`${id}\``)) throw new Error('Official specification model identity mismatch')
  const detail = section(text, 'Model details')
  const contextWindow = number(detail.match(/([\d,]+) context window/i)?.[1])
  const maxInputTokens = number(detail.match(/Maximum input tokens:\s*([\d,]+)/i)?.[1])
  const maxOutputTokens = number(detail.match(/([\d,]+) max output tokens/i)?.[1])
  const modalities = label => detail.match(new RegExp(`${label} modalities:\\s*([^\\r\\n]+)`, 'i'))?.[1]
    ?.split(/,\s*/).filter(item => ['text', 'image', 'audio', 'video'].includes(item))
  const prices = section(text, 'Pricing')
  const price = label => { const value = Number(prices.match(new RegExp(`^\\| ${label} \\| \\$([\\d.]+) \\| 1M tokens \\|`, 'm'))?.[1]); return Number.isFinite(value) ? value : undefined }
  return {
    id, source, fetchedAt: new Date().toISOString(),
    contextWindow, maxInputTokens, maxOutputTokens,
    inputModalities: modalities('Input'), outputModalities: modalities('Output'),
    reasoningSupported: /Reasoning token support/i.test(detail) ? true : undefined,
    rejectsReasoningNone: /rejects requests that set reasoning effort to `none`/i.test(text),
    knowledgeCutoff: detail.match(/^- (.+) knowledge cutoff\s*$/m)?.[1],
    features: bullets(section(text, 'Supported features')),
    unsupportedFeatures: bullets(section(text, 'Unsupported features')),
    tools: bullets(section(text, 'Supported tools')),
    endpoints: [...section(text, 'Endpoints').matchAll(/^\| ([^|]+) \| `([^`]+)` \| (Supported|Not supported) \|/gm)]
      .map(([, name, route, support]) => ({ name: name.trim(), route, supported: support === 'Supported' })),
    apiPricingPerMillion: { input: price('Input'), output: price('Output'), cachedInput: price('Cached input'), cacheWrite: price('Cache writes') },
    pricingBasis: 'Public API standard list rates, not ChatGPT subscription billing',
  }
}

export function accountSpec(model) {
  // Preserve only validated capability fields, never spread an untrusted account object into a provider.
  const contextWindow = positive(model.context_window)
  const maxInputTokens = positive(model.max_input_tokens)
  const maxOutputTokens = positive(model.max_output_tokens)
  const inputModalities = Array.isArray(model.input_modalities) ? model.input_modalities.filter(item => ['text', 'image', 'audio', 'video'].includes(item)) : undefined
  const reasoningEfforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.map(item => typeof item === 'string' ? item : item?.effort).filter(item => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(item)) : undefined
  const data = { contextWindow, maxInputTokens, maxOutputTokens, inputModalities, reasoningEfforts }
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
}

export function createSpecCache(request = (...args) => fetch(...args)) {
  const cached = new Map()
  return {
    async load(ids, signal) {
      const results = new Map()
      const requested = [...ids]
      const queue = [...requested]
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length && !signal?.aborted) {
          const id = queue.shift()
          if (!/^[a-z0-9][a-z0-9._-]{0,150}$/.test(id)) continue
          const previous = cached.get(id)
          if (previous && previous.expires > Date.now()) { if (previous.spec) results.set(id, previous.spec); continue }
          try {
            const url = `${DOC_ROOT}${encodeURIComponent(id)}.md`
            const response = await request(url, { redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]) })
            if (!response.ok) throw new Error('Official specification unavailable')
            const text = await response.text()
            if (text.length > 500_000) throw new Error('Official specification too large')
            const spec = parseOfficialSpec(id, text, url)
            cached.set(id, { spec, expires: Date.now() + SPEC_TTL_MS })
            results.set(id, spec)
          } catch {
            if (signal?.aborted) break
            // Keep last verified data with its original fetch timestamp; never fabricate new limits.
            const stale = previous?.spec ? { ...previous.spec, stale: true } : undefined
            cached.set(id, { spec: stale, expires: Date.now() + 5 * 60 * 1000 })
            if (stale) results.set(id, stale)
          }
        }
      }))
      // A total refresh timeout may leave queued or in-flight IDs untouched.
      // Preserve their last verified specification rather than downgrading it to unknown.
      for (const id of requested) {
        const previous = cached.get(id)
        if (!results.has(id) && previous?.spec) results.set(id, { ...previous.spec, stale: true })
      }
      return results
    },
  }
}
