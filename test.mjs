import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { apply, catalogKind, CATALOG_REFRESH_MS, listPlanModels, loadBundled, isPlanGrant, loopbackOnlyPrompt, oauthOnlyStore, planProvider } from './index.js'

const grant = { type: 'oauth', access: 'synthetic-test-token', refresh: 'synthetic-refresh', expires: Date.now() + 3600000, clientId: 'synthetic-client', scopes: ['chatgpt.tokens.use.direct'] }
assert(isPlanGrant(grant))
assert(!isPlanGrant({ ...grant, access: 'sk-key' }))
assert(!isPlanGrant({ ...grant, scopes: [] }))
const bundled = await loadBundled()
const records = new Map()
const locks = new Map()
function locked(key, task) {
  const next = (locks.get(key) ?? Promise.resolve()).then(task)
  locks.set(key, next.catch(() => {}))
  return next
}
const credentials = {
  describeRecord: async key => ({ configured: records.has(key) }),
  readRecord: async key => records.get(key),
  modifyRecord: (key, mutate) => locked(key, async () => { const next = await mutate(records.get(key)); if (next) records.set(key, next); return records.get(key) }),
  deleteRecord: key => locked(key, () => { records.delete(key) }),
}
const key = bundled.credentialKey('chatgpt-plan', 'subscription')
const store = oauthOnlyStore(credentials, key)
assert.equal(await store.read('openai'), undefined)
assert.equal(await store.read('other'), undefined)
assert.equal(await store.modify('openai', async () => grant), grant)
assert.equal(await store.modify('openai', async () => undefined), grant)
await credentials.deleteRecord(key)

const catalog = { models: [{ slug: 'gpt-6.1-sol', display_name: 'Fixture model', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }] }
assert.deepEqual([...await listPlanModels(grant.access, undefined, async () => Response.json(catalog))], [['gpt-6.1-sol', 'Fixture model']])
assert.equal(catalogKind('gpt-image-2'), 'image')
assert.equal(catalogKind('gpt-audio'), 'other')
assert.equal(catalogKind('gpt-6.2-sol-fixture-unknown'), 'text')
const discovered = new Map([['gpt-6.2-sol-fixture-unknown', 'New model'], ['gpt-image-2', 'Image'], ['gpt-6.1-sol', 'Known model'], ['text-embedding-3-small', 'Embedding']])
const discoveredModels = planProvider(bundled, discovered).getModels()
assert.deepEqual(discoveredModels.map(x => x.id), ['gpt-6.2-sol-fixture-unknown', 'gpt-6.1-sol'])
assert.equal(discoveredModels[0].api, 'openai-responses')
assert.equal(discoveredModels[0].contextWindow, 32768)
assert.equal(discoveredModels[0].provider, 'openai')
assert.equal(discoveredModels[0].baseUrl, 'https://api.openai.com/v1')
const calls = []
let truncate = false
let holdCatalog
let holdRefresh
let discoveryStatus = 200
let requestedModel = 'gpt-6.1-sol'
let refreshStarted
let periodic
let periodicCleared = false
const originalInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
globalThis.setInterval = (fn, milliseconds, ...args) => {
  if (milliseconds !== CATALOG_REFRESH_MS) return originalInterval(fn, milliseconds, ...args)
  periodic = fn
  return { unref() {}, fixtureTimer: true }
}
globalThis.clearInterval = timer => { if (timer?.fixtureTimer) periodicCleared = true; else originalClearInterval(timer) }
let liveGrant = grant
let refreshes = 0
let codeExchanges = 0
let authorizeUrl
const originalFetch = globalThis.fetch
const completed = { type: 'response.completed', response: { id: 'r1', object: 'response', created_at: 1, model: 'gpt-6.1-sol', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }, error: null } }
const message = { id: 'msg1', type: 'message', role: 'assistant', status: 'in_progress', content: [] }
const sse = events => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? input.href)
  const headers = new Headers(init?.headers ?? input.headers)
  if (url.href === 'https://auth.openai.com/api/accounts/oauth/token') {
    const params = new URLSearchParams(init?.body)
    assert.equal(init?.method, 'POST')
    if (params.get('grant_type') === 'authorization_code') {
      assert.equal(params.get('code'), 'fixture-code')
      assert.equal(params.get('client_id'), grant.clientId)
      assert.equal(params.get('redirect_uri'), authorizeUrl.searchParams.get('redirect_uri'))
      assert.equal(params.get('resource'), 'https://api.openai.com/v1')
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorizeUrl.searchParams.get('code_challenge'))
      codeExchanges++
      return Response.json({ access_token: grant.access, refresh_token: grant.refresh, scope: grant.scopes.join(' '), expires_in: 3600, id_token: 'synthetic-unused-id-token' })
    }
    assert.equal(params.get('grant_type'), 'refresh_token')
    assert.equal(params.get('client_id'), grant.clientId)
    assert.equal(params.get('refresh_token'), grant.refresh)
    refreshes++
    refreshStarted?.()
    if (holdRefresh) await holdRefresh
    liveGrant = { ...grant, access: 'synthetic-rotated-access', refresh: 'synthetic-rotated-refresh' }
    return Response.json({ access_token: liveGrant.access, refresh_token: liveGrant.refresh, scope: liveGrant.scopes.join(' '), expires_in: 3600 })
  }
  assert.equal(url.origin, 'https://api.openai.com')
  assert.equal(headers.get('authorization'), `Bearer ${liveGrant.access}`)
  calls.push(url.pathname)
  if (url.pathname === '/v1/models') {
    if (holdCatalog) await holdCatalog
    if (discoveryStatus !== 200) return Response.json({ error: 'Fixture failure' }, { status: discoveryStatus })
    return Response.json(catalog)
  }
  assert.equal(url.pathname, '/v1/responses')
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : await input.text())
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.model, requestedModel)
  assert(!('max_output_tokens' in body))
  assert(!('temperature' in body))
  assert(!body.input.some(i => i.role === 'system'))
  return sse([
    { type: 'response.output_item.added', output_index: 0, item: message },
    { type: 'response.content_part.added', item_id: 'msg1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg1', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item: { ...message, status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] } },
    ...truncate ? [] : [{ ...completed, response: { ...completed.response, model: requestedModel } }],
  ])
}
const cleanups = []
let adapter, command, flow, recordUpdated, replaced = 0
let imageTool
const ctx = {
  tools: { register: definition => { imageTool = definition; return () => {} } },
  inject: (keys, use) => {
    assert.deepEqual(keys, ['connection'])
    use({ connection: { fetch: { register: route => assert(['/api/chatgpt-plan/usage', '/api/chatgpt-plan/usage/reset', '/api/chatgpt-plan/auth',
       ...['text/start', 'text/cancel', 'codex/start', 'codex/cancel'].map(path => `/api/chatgpt-plan/auth/${path}`)].includes(route.path)) } } })
  },
  credentials,
  authorization: { registerFlow: v => { flow = v; return () => {} }, describe: () => ({ inFlight: false }) },
  commands: { register: v => { command = v; return () => {} } },
  effect: run => cleanups.push(run()), on: (event, callback) => { assert.equal(event, 'credentials/record-updated'); recordUpdated = callback },
  llm: {
    registerAdapter: (routes, value) => { assert.deepEqual(routes, ['chatgpt-plan']); adapter = value; return Object.assign(() => {}, { replace: () => { replaced++ } }) },
    stream: async function* (options) {
      const prepared = await adapter.prepareCall(options.provider, options.model, options.signal)
      assert.equal(prepared.model.provider, 'chatgpt-plan')
      yield* prepared.stream({ ...options, temperature: 0, maxTokens: 16 })
    },
  },
}
try {
  // An ambient API key must never service a subscription request.
  process.env.OPENAI_API_KEY = 'sk-fixture-never-used'
  await apply(ctx)
  assert.equal(imageTool.name, 'chatgpt_plan_image')
  assert.equal(flow.methods[0].id, 'oauth')
  assert.equal(command.recordInput, false)
  assert.deepEqual(await adapter.listModels(), [])
  const run = rawInput => command.handler({ rawInput, signal: new AbortController().signal })
  ctx.invocation = { peer: { principal: { kind: 'share-viewer' } } }
  assert.equal((await run('models')).kind, 'error')
  assert.equal(calls.length, 0)
  ctx.invocation = undefined
  assert.equal((await run('models')).kind, 'success')
  assert.equal(calls.length, 0)
  const loginSignal = AbortSignal.timeout(5000)
  let callback
  const hostKey = bundled.credentialKey('chatgpt-plan', 'installation')
  await flow.run({
    signal: loginSignal,
    notify(notice) {
      authorizeUrl = new URL(notice.url)
      assert.equal(authorizeUrl.origin, 'https://auth.openai.com')
      assert.equal(authorizeUrl.searchParams.get('response_type'), 'code')
      assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')
      assert(authorizeUrl.searchParams.get('scope').split(' ').includes('chatgpt.tokens.use.direct'))
      assert.equal(authorizeUrl.searchParams.get('ext_agent_host_id'), `urn:uuid:${records.get(hostKey).payload.id}`)
      const target = new URL(authorizeUrl.searchParams.get('redirect_uri'))
      assert.equal(target.origin, 'http://127.0.0.1:1455')
      target.search = new URLSearchParams({ code: 'fixture-code', state: 'fixture-wrong-state', client_id: grant.clientId })
      callback = (async () => {
        const mismatch = await originalFetch(target, { signal: loginSignal })
        assert.equal(mismatch.status, 400)
        await mismatch.text()
        assert.equal(codeExchanges, 0)
        target.searchParams.set('state', authorizeUrl.searchParams.get('state'))
        const accepted = await originalFetch(target, { signal: loginSignal })
        assert.equal(accepted.status, 200)
        await accepted.text()
      })()
      callback.catch(() => {})
    },
    prompt(prompt) { return loopbackOnlyPrompt(prompt, loginSignal) },
    async commit(record) { records.set(key, record) },
  })
  await callback
  assert.equal(codeExchanges, 1)
  assert.equal(records.get(key).payload.access, grant.access)
  records.set(key, { kind: 'grant', payload: { ...grant, expires: Date.now() - 1 } })
  assert.match((await run('models')).text, /1 个/)
  assert.equal(refreshes, 1)
  assert.equal(records.get(key).payload.access, liveGrant.access)
  assert.equal(records.get(key).payload.refresh, liveGrant.refresh)
  assert.equal(replaced >= 1, true)
  assert.deepEqual(await adapter.listModels(), [{ provider: 'chatgpt-plan', id: 'gpt-6.1-sol', name: 'Fixture model', inputModalities: ['text'] }])
  assert.equal((await run('test')).kind, 'success')
  truncate = true
  assert.equal((await run('test')).kind, 'error')
  assert.equal(calls.filter(x => x === '/v1/responses').length, 2)
  truncate = false
  catalog.models.unshift({ slug: 'gpt-6.2-sol-fixture-unknown', display_name: 'Newest fixture', visibility: 'list' })
  catalog.models.push({ slug: 'gpt-image-2', display_name: 'Image fixture', visibility: 'list' })
  assert.equal(typeof periodic, 'function')
  await periodic()
  assert.deepEqual((await adapter.listModels()).map(x => x.id), ['gpt-6.2-sol-fixture-unknown', 'gpt-6.1-sol'])
  assert.match((await run('status')).text, /每五分钟自动刷新/)
  assert.match((await run('images')).text, /gpt-image-2/)
  assert.match((await run('images')).text, /SIWC/)
  requestedModel = 'gpt-6.2-sol-fixture-unknown'
  assert.equal((await run('test')).kind, 'success')
  discoveryStatus = 503
  assert.equal((await run('models')).kind, 'error')
  assert.equal((await adapter.listModels()).length, 2)
  assert.match((await run('status')).text, /暂保留上次目录/)
  discoveryStatus = 401
  assert.equal((await run('models')).kind, 'error')
  assert.deepEqual(await adapter.listModels(), [])
  discoveryStatus = 200
  assert.equal((await run('models')).kind, 'success')
  assert.equal((await adapter.listModels()).length, 2)
  discoveryStatus = 403
  assert.equal((await run('models')).kind, 'error')
  assert.deepEqual(await adapter.listModels(), [])
  discoveryStatus = 200
  assert.equal((await run('models')).kind, 'success')
  let releaseCatalog
  holdCatalog = new Promise(resolve => { releaseCatalog = resolve })
  const pending = run('models')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await run('logout')).kind, 'success')
  releaseCatalog()
  await pending
  assert.deepEqual(await adapter.listModels(), [])
  assert.equal(records.has(key), false)
  // Rotation holds the credential lock: logout must win even when the refresh reply is late.
  holdCatalog = undefined
  records.set(key, { kind: 'grant', payload: { ...grant, expires: Date.now() - 1 } })
  let releaseRefresh
  holdRefresh = new Promise(resolve => { releaseRefresh = resolve })
  const startedRefresh = new Promise(resolve => { refreshStarted = resolve })
  const pendingRotation = run('models')
  await startedRefresh
  const pendingLogout = run('logout')
  releaseRefresh()
  await Promise.all([pendingRotation, pendingLogout])
  assert.equal(records.has(key), false)
  assert.deepEqual(await adapter.listModels(), [])
  await periodic()
  assert.deepEqual(await adapter.listModels(), [])
  records.set(key, { kind: 'grant', payload: liveGrant })
  await run('models')
  assert.equal((await adapter.listModels()).length, 2)
  // Dispose the old Host; a new Host must resolve its saved id before network returns.
  const savedBinding = records.get(key).payload.dshBinding
  const savedSnapshot = records.get(key).payload.dshCatalog
  assert(savedBinding)
  assert(savedSnapshot.models.some(([id]) => id === requestedModel))
  for (const dispose of cleanups.splice(0).reverse()) dispose?.()
  discoveryStatus = 503
  holdCatalog = new Promise(resolve => { releaseCatalog = resolve })
  await apply(ctx)
  assert.equal((await adapter.resolveModel('chatgpt-plan', requestedModel, AbortSignal.timeout(100))).id, requestedModel)
  assert.equal((await adapter.listModels()).length, 2)
  releaseCatalog()
  await new Promise(resolve => setImmediate(resolve))
  await credentials.deleteRecord(key)
  recordUpdated(key)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await adapter.listModels(), [])
  console.log('PASS: OAuth state/PKCE, token rotation, API-key isolation, unknown-model inference, server order, image separation, periodic discovery, stale recovery, auth rejection, SSE completion/interruption, catalog and refresh/logout races')
} finally {
  globalThis.fetch = originalFetch
  for (const dispose of cleanups.reverse()) dispose?.()
  globalThis.setInterval = originalInterval
  globalThis.clearInterval = originalClearInterval
}
assert.equal(periodicCleared, true)
console.log('PASS: periodic refresh timer disposed')
