import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { accountSpec, createSpecCache } from './specs.js'
import { ImageBridge, IMAGE_MODEL, CODEX_VERSION } from './image-bridge.js'
import { createUsageRoute, usageCommand } from './usage.js'
import { codexDevicePage, createAuthSettings } from './auth-settings.js'

export const name = 'chatgpt-plan'
export const inject = ['authorization', 'credentials', 'commands', 'llm', 'tools']
export const ROUTE = 'chatgpt-plan'
const NATIVE = 'openai'
const ORIGIN = 'https://api.openai.com/v1'
const APP_NAME = 'DSH ChatGPT Plan'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const COMMAND = 'chatgpt-plan'
export const CATALOG_REFRESH_MS = 5 * 60 * 1000

// The bundled adapter surface this bridge compiles against: the 0.2.x line that
// ships @earendil-works/pi-ai 1.3.0. A new 0.2.x release (rc.4, rc.5, ...) keeps
// that surface, so accept the whole line instead of one exact prerelease tag.
const DSH_VERSION = /^0\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function supportsDsh(manifest) {
  return manifest?.name === '@deepseek-ai/dsh' && DSH_VERSION.test(String(manifest.version ?? ''))
}

export async function loadBundled(installDir = process.env.DSH_INSTALL_DIR) {
  // DSH_INSTALL_DIR is set for agent tools, not necessarily in the Desktop Host.
  const anchor = typeof process.resourcesPath === 'string' && isAbsolute(process.resourcesPath)
    ? join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    : installDir
  if (!anchor || !isAbsolute(anchor)) throw new Error('DSH installation path is unavailable')
  const manifestPath = join(anchor, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!supportsDsh(manifest)) {
    throw new Error(`This subscription bridge requires a DSH 0.2.x runtime (found ${manifest.name} ${manifest.version})`)
  }
  const require = createRequire(manifestPath)
  const adapterPath = require.resolve('@deepseek-ai/dsh-llm-pi-ai')
  const root = resolve(dirname(adapterPath), '../../..', '@earendil-works', 'pi-ai', 'dist')
  const load = file => import(pathToFileURL(file).href)
  const [{ PiAiAdapter }, { credentialKey }, { LlmError, resolveImageAttachmentAccess }, { openaiProvider }, { createModels }, { defineTool }] = await Promise.all([
    load(adapterPath), load(require.resolve('@deepseek-ai/dsh-credentials')), load(require.resolve('@deepseek-ai/dsh-llm')),
    load(join(root, 'providers', 'openai.js')), load(join(root, 'models.js')), load(require.resolve('@deepseek-ai/dsh-tools')),
  ])
  return { PiAiAdapter, credentialKey, LlmError, resolveImageAttachmentAccess, createModels, openaiProvider, defineTool }
}

export function isPlanGrant(value) {
  return value?.type === 'oauth' && typeof value.access === 'string' && value.access.length > 0 && !value.access.startsWith('sk-')
    && typeof value.refresh === 'string' && value.refresh.length > 0 && Number.isFinite(value.expires)
    && typeof value.clientId === 'string' && value.clientId.length > 0
    && Array.isArray(value.scopes) && value.scopes.includes(PLAN_SCOPE)
}

const validCatalogId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,150}$/.test(id)
const validCatalogLabel = label => typeof label === 'string' && label.length > 0 && label.length <= 200
const MAX_SNAPSHOT_MODELS = 256
const MAX_SNAPSHOT_AGE = 7 * 24 * 60 * 60 * 1000
const MAX_SNAPSHOT_BYTES = 192 * 1024

function grantRecord(record) {
  return record?.kind === 'grant' && isPlanGrant(record.payload) ? record.payload : undefined
}

function unpackCatalog(payload) {
  const snap = payload?.dshCatalog
  if (snap?.version !== 1 || !Array.isArray(snap.models) || snap.models.length > MAX_SNAPSHOT_MODELS) return undefined
  if (Buffer.byteLength(JSON.stringify(snap)) > MAX_SNAPSHOT_BYTES) return undefined
  const age = Date.now() - Date.parse(snap.refreshedAt)
  if (!Number.isFinite(age) || age < 0 || age > MAX_SNAPSHOT_AGE) return undefined
  const ids = new Map()
  const specs = new Map()
  for (const row of snap.models) {
    if (!Array.isArray(row) || row.length !== 3) return undefined
    const [id, label, spec] = row
    if (!validCatalogId(id) || !validCatalogLabel(label) || ids.has(id)) return undefined
    ids.set(id, label)
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      const capabilities = accountSpec({ context_window: spec.contextWindow, max_input_tokens: spec.maxInputTokens,
        max_output_tokens: spec.maxOutputTokens, input_modalities: spec.inputModalities, supported_reasoning_levels: spec.reasoningEfforts })
      specs.set(id, { ...spec, contextWindow: undefined, maxInputTokens: undefined, maxOutputTokens: undefined,
        inputModalities: undefined, reasoningEfforts: undefined, ...capabilities, stale: true })
    }
  }
  return { ids, specs, refreshedAt: snap.refreshedAt }
}

export function oauthOnlyStore(credentials, key) {
  const grant = record => {
    const payload = grantRecord(record)
    if (!payload) return undefined
    const { dshCatalog, dshBinding, ...oauth } = payload
    return dshCatalog === undefined && dshBinding === undefined ? payload : oauth
  }
  return {
    read: async (provider, options) => {
      options?.signal?.throwIfAborted()
      if (provider !== NATIVE) return undefined
      return grant(await credentials.readRecord(key))
    },
    modify: async (provider, mutate, options) => {
      if (provider !== NATIVE) throw new Error('Unexpected subscription provider')
      options?.signal?.throwIfAborted()
      const record = await credentials.modifyRecord(key, async current => {
        options?.signal?.throwIfAborted()
        const next = await mutate(grant(current))
        if (next === undefined) return undefined
        if (!isPlanGrant(next)) throw new Error('Invalid subscription credential')
        const payload = grantRecord(current)
        if (!payload?.dshBinding && !payload?.dshCatalog) return { kind: 'grant', payload: next }
        return { kind: 'grant', payload: { ...next,
          ...(payload?.dshBinding ? { dshBinding: payload.dshBinding } : {}),
          ...(payload?.dshCatalog ? { dshCatalog: payload.dshCatalog } : {}),
        } }
      })
      return grant(record)
    },
    delete: async () => { throw new Error('Use the plugin disconnect command') },
  }
}

const noAmbientAuth = { env: async () => undefined, fileExists: async () => false }

// Model listing is not an entitlement or endpoint-capability guarantee.
export function catalogKind(id) {
  if (/^(?:gpt-image(?:-|$)|dall-e(?:-|$)|chatgpt-image(?:-|$))/.test(id)) return 'image'
  if (/(?:^|[-_])(?:audio|realtime|transcribe|tts|embedding|moderation|whisper)(?:[-_]|$)/.test(id)
      || /^(?:sora|babbage|davinci)(?:-|$)/.test(id)) return 'other'
  return 'text'
}

export function planProvider(bundled, ids = new Map(), specs = new Map()) {
  const upstream = bundled.openaiProvider()
  if (upstream.id !== NATIVE || upstream.baseUrl !== ORIGIN || !upstream.auth.oauth?.isSubscription) {
    throw new Error('Bundled subscription provider is incompatible')
  }
  const known = new Map(upstream.getModels().map(model => [model.id, model]))
  // The account catalog, not the bundled library's release date, owns membership and order.
  const models = [...ids].filter(([id]) => catalogKind(id) === 'text').map(([id, name]) => {
    const metadata = known.get(id)
    const spec = specs.get(id)
    const levels = spec?.reasoningEfforts
    const thinkingLevelMap = Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level =>
      [level, levels?.includes(level === 'off' ? 'none' : level) ? (level === 'off' ? undefined : level) : null]))
    return {
      // SDK-required internal budgets are never advertised as verified specifications.
      ...metadata, type: 'chat', reasoning: Boolean(levels?.length), thinkingLevelMap,
      contextWindow: spec?.contextWindow ?? 32768, maxTokens: spec?.maxOutputTokens ?? 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      id, name, api: 'openai-responses', provider: NATIVE, baseUrl: ORIGIN,
      input: spec?.inputModalities?.filter(mode => mode === 'text' || mode === 'image') ?? ['text'], compat: {
        ...metadata?.compat, supportsMidConvoSystemMessages: false, supportsToolSearch: false,
        supportsMidConvoEffort: false, supportsDeveloperRole: true,
      },
    }
  })
  return { ...upstream, auth: { oauth: upstream.auth.oauth }, getModels: () => models, getAllModels: () => models }
}

export function routeAdapter(adapter, getSpecs = () => new Map()) {
  const describe = model => {
    const spec = getSpecs().get(model.id)
    const result = { ...model, provider: ROUTE }
    // Missing official metadata is unknown, not a 32k model specification.
    if (spec?.contextWindow) result.context = { contextWindow: spec.contextWindow }
    else delete result.context
    if (!spec?.reasoningEfforts?.length) delete result.reasoning
    return result
  }
  const nativeOptions = (options) => ({
    ...options, provider: NATIVE,
    messages: options.messages.map(message => {
      const source = message.role === 'assistant' && message.source
      return source?.provider !== ROUTE ? message : { ...message, source: { ...source, provider: NATIVE } }
    }),
  })
  const stream = async function* (options, read) {
    for await (const chunk of read(nativeOptions(options))) yield chunk
  }
  return {
    providerInfo: () => ({ id: ROUTE, name: 'ChatGPT 订阅' }),
    providerRetryPolicy: () => undefined,
    listModels: async () => (await adapter.listModels(NATIVE)).map(model => ({ ...model, provider: ROUTE })),
    resolveModel: async (_provider, model, signal) => describe(await adapter.resolveModel(NATIVE, model, signal)),
    imageRequestPricing: (_provider, model) => adapter.imageRequestPricing(NATIVE, model),
    imageRequestTarget: (_provider, model, image) => adapter.imageRequestTarget(NATIVE, model, image),
    prepareCall: async (_provider, model, signal) => {
      const prepared = await adapter.prepareCall(NATIVE, model, signal)
      return { model: describe(prepared.model), stream: options => stream(options, prepared.stream) }
    },
    stream: options => stream(options, inner => adapter.stream(inner)),
  }
}

function openBrowser(url, signal) {
  const parsed = new URL(url)
  if (parsed.origin !== 'https://auth.openai.com' || parsed.pathname !== '/api/accounts/authorize' || parsed.username || parsed.password) {
    return Promise.reject(new Error('Unexpected OpenAI authorization address'))
  }
  return openDesktopBrowser(parsed, signal)
}

function openDesktopBrowser(parsed, signal) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Use the Windows desktop host'))
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return new Promise((accept, reject) => {
    execFile(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:DSH_PLAN_AUTH_URL'],
      { env: { SystemRoot: root, WINDIR: root, DSH_PLAN_AUTH_URL: parsed.href }, windowsHide: true, timeout: 10000, signal },
      error => error ? reject(new Error('Browser launch failed')) : accept())
  })
}

export function loopbackOnlyPrompt(prompt, signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Authorization stopped'))
    const rejectPrompt = () => reject(prompt.signal.reason ?? new Error('Callback prompt closed'))
    if (signal.aborted) return abort()
    if (prompt.signal?.aborted) return rejectPrompt()
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      prompt.signal?.removeEventListener('abort', onPrompt)
    }
    const onAbort = () => { cleanup(); abort() }
    const onPrompt = () => { cleanup(); rejectPrompt() }
    signal.addEventListener('abort', onAbort, { once: true })
    prompt.signal?.addEventListener('abort', onPrompt, { once: true })
  })
}

export async function listPlanModels(access, signal, request = fetch) {
  const response = await request(`${ORIGIN}/models`, { headers: { Authorization: `Bearer ${access}` }, redirect: 'error', signal })
  if (!response.ok) throw Object.assign(new Error('OpenAI model discovery failed'), { status: response.status })
  const body = await response.json()
  if (!Array.isArray(body?.models)) throw new Error('Unexpected subscription model catalog')
  const visible = body.models.filter(model => model?.visibility === 'list' && validCatalogId(model.slug) && validCatalogLabel(model.display_name))
  const result = new Map(visible.map(model => [model.slug, model.display_name]))
  Object.defineProperty(result, 'accountSpecs', { value: new Map(visible.map(model => [model.slug, accountSpec(model)])) })
  return result
}

async function waitFor(promise, signal) {
  signal.throwIfAborted()
  let abort
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

function loginError(error) {
  if (error?.code === 'ALREADY_IN_FLIGHT') return '已有授权进行中。可在原浏览器标签页完成，或运行 /chatgpt-plan cancel。'
  const text = typeof error?.message === 'string' ? error.message : ''
  if (text.includes('Port 1455 is in use')) return '本机 1455 端口正被占用。结束其他正在进行的 Codex 或 ChatGPT 登录，再重试。'
  if (text.includes('access_denied')) return '本次未授予 ChatGPT 订阅权限。'
  if (text.includes('chatgpt.tokens.use.direct')) return '该授权没有返回 ChatGPT 订阅使用权限。'
  if (text.includes('requires a loopback callback')) return '本机 OAuth 回调必须绑定到 127.0.0.1。请检查 PI_OAUTH_CALLBACK_HOST 设置。'
  if (text.includes('Browser launch failed')) return '默认浏览器未打开，请检查 Windows 的默认浏览器设置后重试。'
  return 'ChatGPT 授权未完成。请在 Windows 本机重试，并检查浏览器中的 OpenAI 页面。'
}

export async function apply(ctx) {
  const bundled = await loadBundled()
  const upstream = planProvider(bundled)
  const key = bundled.credentialKey(name, 'subscription')
  const hostKey = bundled.credentialKey(name, 'installation')
  const { authorization, credentials, commands, llm } = ctx
  const auth = { credentials: oauthOnlyStore(credentials, key), authContext: noAmbientAuth }
  const models = bundled.createModels(auth)
  models.setProvider(upstream)
  let catalog = new Map()
  let specs = new Map()
  const specCache = createSpecCache()
  let refreshedAt
  let refreshError = false
  let profile = makeProfile(catalog)
  let registration
  let generation = 0
  let disconnecting = false
  const lifetime = new AbortController()
  const imageBridge = new ImageBridge()
  const sidebarUsage = createUsageRoute(imageBridge, lifetime.signal)
  const authSettings = createAuthSettings({ lifetime: lifetime.signal,
    async textStatus() { return { ...await credentials.describeRecord(key), inFlight: authorization.describe(key)?.inFlight } },
    loginText, cancelText: () => authorization.cancel(key), loginCodex: (signal, complete) => imageBridge.login(signal, complete), cancelCodex: signal => imageBridge.cancelLogin(signal),
    codexStatus: signal => imageBridge.account(signal),
    openDevicePage: (url, signal) => openDesktopBrowser(new URL(codexDevicePage(url)), signal),
    invalidateUsage: sidebarUsage.invalidate,
  })
  ctx.inject(['connection'], scope => {
    scope.connection.fetch.register(sidebarUsage.route)
    scope.connection.fetch.register(sidebarUsage.resetRoute)
    for (const route of authSettings.routes) scope.connection.fetch.register(route)
  })
  ctx.effect(() => () => imageBridge.close())
  ctx.effect(() => ctx.tools.register(bundled.defineTool({
    name: 'chatgpt_plan_image', timeoutMs: 10 * 60 * 1000,
    description: '通过本机官方 Codex ChatGPT 订阅桥生成一张 PNG，返回文件路径。需先 /chatgpt-plan image-login；独立于文本 SIWC 授权，不使用 API Key。当前官方桥固定 gpt-image-2，不支持选择 image2.6。成功后用 present 交付返回的 path。',
    parameters: { prompt: { type: 'string', required: true, description: '图片内容、风格与期望构图；比例等作为自然语言要求，非严格尺寸参数。' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, imageModel: { type: 'string', required: true },
      coordinator: { type: 'string', required: true }, route: { type: 'string', required: true }, modelSelection: { type: 'string', required: true },
    } }, render: (_args, result) => [{ type: 'text', text: `已生成图片：${result.path}\n图像后端：${result.imageModel}\n请用 present 交付此文件。` }] },
    async execute(args, exec) {
      const principal = ctx.invocation?.peer?.principal
      if (principal && principal.kind !== 'owner') throw new Error('仅主机所有者可以调用本机订阅生图。')
      return imageBridge.generate(args.prompt, { signal: AbortSignal.any([exec.signal, lifetime.signal]) })
    },
  })))
  function makeProfile(ids) {
    return new Map([[NATIVE, {
      provider: NATIVE, displayName: 'ChatGPT 订阅', piProvider: planProvider(bundled, ids, specs),
      streamIdleTimeoutMs: 90000, timeoutMs: 90000, transport: 'sse',
      maxRequestImageBytes: 5_000_000, maxRequestImages: 1, imageOffloadCountQuantum: 1,
      requestImagePixelBudget: 1_000_000, requestImageMaxBytes: 5_000_000,
      configuredMaxTokens: new Map(), modelErrors: new Map(),
    }]])
  }
  const nativeAdapter = new bundled.PiAiAdapter({
    profiles: () => profile, resolveApiKey: async () => undefined, auth,
    resolveAttachments: () => ctx.get?.('attachments'),
    resolveImageAccess: (attachments, ref) => bundled.resolveImageAttachmentAccess(attachments,
      hostPath => ctx.get?.('fs')?.processPathFromHostPath(hostPath), ref),
  })
  const innerAdapter = routeAdapter(nativeAdapter, () => specs)
  let initialLoad
  let releaseInitial
  let binding
  let retryTimer
  let retryIndex = 0
  const readyCatalog = async signal => {
    if (initialLoad && !catalog.size) await (signal ? waitFor(initialLoad, signal) : initialLoad)
  }
  const adapter = {
    ...innerAdapter,
    async listModels() { await readyCatalog(); return innerAdapter.listModels() },
    async resolveModel(provider, model, signal) { await readyCatalog(signal); return innerAdapter.resolveModel(provider, model, signal) },
    async prepareCall(provider, model, signal) { await readyCatalog(signal); return innerAdapter.prepareCall(provider, model, signal) },
  }
  async function ensureBinding() {
    const current = grantRecord(await credentials.readRecord(key))
    if (!current || typeof current.dshBinding === 'string') return current
    return grantRecord(await credentials.modifyRecord(key, async record => {
      const payload = grantRecord(record)
      if (!payload || typeof payload.dshBinding === 'string') return undefined
      return { kind: 'grant', payload: { ...payload, dshBinding: randomUUID() } }
    }))
  }
  async function persistCatalog(bound, epoch, next, timestamp, savedSpecs, startedAt) {
    if (typeof bound !== 'string') return
    if (next.size > MAX_SNAPSHOT_MODELS) return
    const serialized = timestamp && JSON.stringify({ version: 1, refreshedAt: timestamp,
      models: [...next].map(([id, label]) => [id, label, savedSpecs.get(id) ?? null]) })
    if (serialized && Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) return
    const snap = serialized ? JSON.parse(serialized) : undefined
    await credentials.modifyRecord(key, async record => {
      const payload = grantRecord(record)
      if (epoch !== generation || disconnecting || lifetime.signal.aborted || payload?.dshBinding !== bound) return undefined
      const { dshCatalog, ...rest } = payload
      if (Date.parse(dshCatalog?.refreshedAt) > (snap ? Date.parse(snap.refreshedAt) : startedAt)) return undefined
      if (!snap && !dshCatalog) return undefined
      return { kind: 'grant', payload: snap ? { ...rest, dshCatalog: snap } : rest }
    })
  }
  const publish = next => {
    catalog = next
    profile = makeProfile(next)
    registration?.replace([ROUTE])
  }
  const describeCatalog = () => {
    const text = [...catalog.keys()].filter(id => catalogKind(id) === 'text').length
    const image = [...catalog.keys()].filter(id => catalogKind(id) === 'image').length
    return `文本模型 ${text} 个；图像目录条目 ${image} 个。${refreshedAt ? `最近拉取：${refreshedAt}。` : ''}${refreshError ? (catalog.size ? '最近刷新失败，暂保留上次目录。' : '最近刷新失败，当前没有可用目录。') : ''}当前 SIWC 通道暂未开放生图；图像条目仅作目录展示，不进入对话模型选择器。`
  }
  async function syncCatalog(signal = lifetime.signal) {
    if (disconnecting) return 0
    const epoch = ++generation
    const startedAt = Date.now()
    const activeSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(25000)])
    let bound
    try {
      bound = (await ensureBinding())?.dshBinding
      if (epoch !== generation || disconnecting) return (await innerAdapter.listModels()).length
      if (binding !== bound) {
        binding = bound
        specs = new Map()
        refreshedAt = undefined
        publish(new Map())
      }
      const resolved = bound ? await models.getAuth(NATIVE, { signal: activeSignal }) : undefined
      const token = resolved?.auth.apiKey
      if (bound && !token) throw new Error('Subscription authorization temporarily unavailable')
      const next = token ? await listPlanModels(token, activeSignal) : new Map()
      const valid = () => epoch === generation && !disconnecting && !signal.aborted && !lifetime.signal.aborted && bound === binding
      if (bound !== grantRecord(await credentials.readRecord(key))?.dshBinding || !valid() || activeSignal.aborted) return (await innerAdapter.listModels()).length
      const timestamp = token ? new Date().toISOString() : undefined
      const withAccountSpecs = source => new Map([...next].flatMap(([id]) => {
        const spec = source.get(id)
        const fields = next.accountSpecs?.get(id)
        if (fields && Object.keys(fields).length) return [[id, { ...spec, ...fields, accountFields: Object.keys(fields), accountSource: `${ORIGIN}/models`, accountFetchedAt: timestamp }]]
        return spec ? [[id, spec]] : []
      }))
      const previous = specs
      // Publish membership together with capabilities: downstream context caches
      // must not see the SDK fallback window while official specs are in flight.
      const nextSpecs = await specCache.load(next.keys(), AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(12000)]))
      if (valid()) {
        for (const id of next.keys()) {
          if (!nextSpecs.has(id) && previous.has(id)) nextSpecs.set(id, { ...previous.get(id), stale: true })
        }
        specs = withAccountSpecs(nextSpecs)
        refreshedAt = timestamp
        refreshError = false
        retryIndex = 0
        clearTimeout(retryTimer)
        publish(next)
        releaseInitial?.()
        await persistCatalog(bound, epoch, next, timestamp, specs, startedAt).catch(() => {})
      }
      return (await innerAdapter.listModels()).length
    } catch (error) {
      if (epoch === generation && !disconnecting && !lifetime.signal.aborted) {
        refreshError = true
        // A transient outage must not erase a previously discovered catalog.
        if (error?.status === 401 || error?.status === 403) {
          refreshedAt = undefined
          specs = new Map()
          publish(new Map())
          await persistCatalog(bound, epoch, new Map(), undefined, specs, startedAt).catch(() => {})
        }
      }
      throw error
    }
  }

  function recoverCatalog() {
    if (lifetime.signal.aborted || disconnecting) return
    if (!catalog.size && !initialLoad) initialLoad = new Promise(resolve => { releaseInitial = resolve })
    void syncCatalog().catch(error => {
      if (!catalog.size && !lifetime.signal.aborted && !disconnecting && binding && error?.status !== 401 && error?.status !== 403 && retryIndex < 3) {
        retryTimer = setTimeout(recoverCatalog, [2000, 5000, 15000][retryIndex++])
        retryTimer.unref?.()
      }
    }).finally(() => { releaseInitial?.(); initialLoad = undefined; releaseInitial = undefined })
  }
  ctx.effect(() => () => { lifetime.abort(); clearTimeout(retryTimer) })
  const saved = grantRecord(await credentials.readRecord(key).catch(() => undefined))
  if (saved && !lifetime.signal.aborted) {
    binding = saved.dshBinding
    const snapshot = binding && unpackCatalog(saved)
    if (snapshot) {
      specs = snapshot.specs
      refreshedAt = snapshot.refreshedAt
      publish(snapshot.ids)
    }
    recoverCatalog()
  }
  ctx.effect(() => {
    const current = llm.registerAdapter([ROUTE], adapter)
    registration = current
    return () => { registration = undefined; current() }
  })
  ctx.effect(() => authorization.registerFlow({
    key, label: 'ChatGPT 订阅', methods: [{ id: 'oauth', label: 'Continue with ChatGPT' }],
    async run(session) {
      const callbackHost = process.env.PI_OAUTH_CALLBACK_HOST
      if (callbackHost && callbackHost !== '127.0.0.1') throw new Error('Subscription OAuth requires a loopback callback')
      const host = await credentials.modifyRecord(hostKey, current => Promise.resolve(current ? undefined : { kind: 'grant', payload: { id: randomUUID() } }))
      const id = host?.payload?.id
      if (host?.kind !== 'grant' || typeof id !== 'string') throw new Error('Installation identifier unavailable')
      session.signal.throwIfAborted()
      const grant = await upstream.auth.oauth.login({
        signal: session.signal,
        notify(event) { if (event.type === 'auth_url') session.notify({ message: 'OpenAI browser authorization', url: event.url }) },
        prompt(prompt) { return session.prompt({ kind: 'secret', message: '本机浏览器回调', signal: prompt.signal }) },
      }, { agentName: APP_NAME, getDeviceId: () => id })
      if (!isPlanGrant(grant)) throw new Error('Missing chatgpt.tokens.use.direct grant')
      await session.commit({ kind: 'grant', payload: { ...grant, dshBinding: randomUUID() } })
    },
  }))

  async function loginText(activeSignal) {
    const failure = (text, fields = {}) => ({ ...fields, command: { kind: 'error', text } })
    if (disconnecting) return failure('正在断开订阅，请稍后重试。')
    if (process.platform !== 'win32') return failure('请在 Windows DSH 主机上发起首次授权。')
    const cancelled = new AbortController()
    const signal = AbortSignal.any([activeSignal, cancelled.signal])
    let browserFailed = false
    try {
      const result = await authorization.begin({ key, method: 'oauth', signal, interaction: {
        notify(notice) {
          if (notice.url) void Promise.resolve().then(() => openBrowser(notice.url, signal)).catch(() => { browserFailed = true; cancelled.abort() })
        },
        prompt(prompt) { return loopbackOnlyPrompt(prompt, signal) },
      } })
      if (browserFailed) return failure(loginError(new Error('Browser launch failed')), { browserFailed })
      if (result.status !== 'authorized') return failure('授权已取消或超时。请在三分钟内完成浏览器授权。', { cancelled: true })
    } catch (error) { return failure(loginError(browserFailed ? new Error('Browser launch failed') : error), { browserFailed }) }
    // Authentication is complete; directory refresh should not hold up Settings.
    recoverCatalog()
    return { command: { kind: 'success', text: '授权已保存，正在刷新模型列表。也可输入 /chatgpt-plan models 手动刷新。' } }
  }

  ctx.effect(() => commands.register({
    name: COMMAND, description: '连接或管理 ChatGPT 订阅', recordInput: false,
    input: { hint: 'login | status | usage | models | info MODEL_ID | images | image-login | image-status | image-models | image-cancel | image-logout | test | cancel | logout' },
    async handler({ rawInput, signal }) {
      const principal = ctx.invocation?.peer?.principal
      if (principal && principal.kind !== 'owner') return { kind: 'error', text: '仅主机所有者可以管理订阅。' }
      const [action = 'status', modelId] = rawInput.trim().split(/\s+/).filter(Boolean)
      if (action === 'usage') return usageCommand(imageBridge, [signal, lifetime.signal])
      if (action.startsWith('image-')) {
        try {
          if (action === 'image-login') {
            const login = await authSettings.startCodex(signal, false)
            return { kind: 'success', text: `请在浏览器打开 ${login.verificationUrl}，输入一次性代码 ${login.userCode}。完成后运行 /chatgpt-plan image-status。此登录由本机官方 Codex 管理，与文本订阅授权独立。` }
          }
          if (action === 'image-cancel') { await authSettings.stopCodex(signal); return { kind: 'success', text: '已取消生图登录。' } }
          if (action === 'image-logout') {
            sidebarUsage.invalidate()
            try { await authSettings.runCodexLogout(() => imageBridge.logout(signal)) } finally { sidebarUsage.invalidate() }
            return { kind: 'success', text: '已退出本桥接的 Codex 登录，文本订阅连接保持不变。' }
          }
          if (action === 'image-status') {
            const state = await imageBridge.account(signal)
            return { kind: 'success', text: `官方 Codex ${CODEX_VERSION} 生图桥：${state.connected ? `ChatGPT 已登录（${state.plan ?? '套餐未返回'}）` : '尚未登录，请运行 /chatgpt-plan image-login'}。图像后端 ${IMAGE_MODEL} 固定，不支持手动选择 image2.6；登录状态不等于生图额度或首次生成验收。` }
          }
          if (action === 'image-models') {
            const items = await imageBridge.models(signal)
            return { kind: 'success', text: `官方 Codex 生图后端：${IMAGE_MODEL}（桥接固定，非动态图片型号选择）。以下为账户实时目录中的图像输入调度模型，不是图片后端型号：\n${items.map(item => `- ${item.model ?? item.id}`).join('\n')}` }
          }
        } catch { return { kind: 'error', text: '官方生图桥操作未完成。请检查网络及独立 Codex 登录状态；没有切换到 API Key，也没有改动文本订阅授权。' } }
      }
      if (disconnecting) return { kind: 'error', text: '正在断开订阅，请稍后重试。' }
      if (action === 'cancel') { authorization.cancel(key); return { kind: 'success', text: '已请求取消授权。' } }
      if (action === 'status') {
        const status = await credentials.describeRecord(key)
        return { kind: 'success', text: status.configured ? `本机已保存订阅授权。${describeCatalog()}每五分钟自动刷新。` + ' 查 Codex 配额：/chatgpt-plan usage。' : '尚未连接 SIWC 文本。请在 Windows 本机输入 /chatgpt-plan login。查 Codex 配额：/chatgpt-plan usage。' }
      }
      if (action === 'logout') {
        if (authorization.describe(key)?.inFlight) return { kind: 'error', text: '请先结束正在进行的登录，再断开连接。' }
        disconnecting = true
        ++generation
        try {
          await credentials.deleteRecord(key)
          clearTimeout(retryTimer)
          retryIndex = 0
          binding = undefined
          specs = new Map()
          refreshedAt = undefined
          refreshError = false
          publish(new Map())
          releaseInitial?.()
          return { kind: 'success', text: '已移除本机订阅凭据。若也要取消 OpenAI 端授权，请在 ChatGPT 的连接设置中撤销。' }
        } finally { disconnecting = false }
      }
      if (action === 'login') {
        if (process.platform !== 'win32') return { kind: 'error', text: '请在 Windows DSH 主机上发起首次授权。' }
        return authSettings.startText(signal)
      }
      if (action === 'info') {
        const id = modelId ?? [...catalog.keys()].find(id => catalogKind(id) === 'text')
        if (!id || !catalog.has(id)) return { kind: 'error', text: '请先加载账户目录，然后用 /chatgpt-plan info MODEL_ID 查询。' }
        const spec = specs.get(id)
        return { kind: 'success', text: JSON.stringify({
          id, officialSpecification: spec ?? null,
          contextWindowSource: spec?.contextWindow ? (spec.accountFields?.includes('contextWindow') ? `${ORIGIN}/models` : spec.source) : 'unknown',
          reasoningEfforts: spec?.reasoningEfforts ?? 'unknown; provider default only',
          routeRestrictions: ['SIWC supported fields only; no max_output_tokens', 'SIWC image generation unavailable', 'API pricing is not subscription billing'],
          note: 'Public API specifications describe model capabilities, not a guarantee of subscription entitlement or every tool being enabled.',
        }, null, 2) }
      }
      if (action === 'models') {
        try {
          const count = await syncCatalog(signal)
          const names = [...catalog].filter(([id]) => catalogKind(id) === 'text').map(([id, label]) => {
            const spec = specs.get(id)
            return `- ${id} (${label}) — 上下文 ${spec?.contextWindow ?? '未知'}；最大输入 ${spec?.maxInputTokens ?? '未知'}；最大输出 ${spec?.maxOutputTokens ?? '未知'}${spec?.stale ? '（上次核验数据）' : ''}`
          }).join('\n')
          return { kind: 'success', text: `模型选择器当前有 ${count} 个账户文本模型。${describeCatalog()}${names ? `\n${names}` : ''}` }
        } catch { return { kind: 'error', text: `订阅模型列表刷新失败，请确认网络与授权状态。${describeCatalog()}` } }
      }
      if (action === 'images') {
        try { await syncCatalog(signal) } catch { /* report stale state explicitly below */ }
        const images = [...catalog].filter(([id]) => catalogKind(id) === 'image').map(([id, label]) => `- ${id} (${label})`).join('\n')
        return { kind: 'success', text: `${describeCatalog()}\n${images || '账户目录未返回可展示的图片模型；这不等于 ChatGPT 应用没有图片权益。'}\n本插件已新增独立官方 Codex 生图桥；用 /chatgpt-plan image-login 连接，/chatgpt-plan image-status 核实状态。该桥的图片后端固定 gpt-image-2，与本目录条目不等价。` }
      }
      if (action === 'test') {
        const items = await adapter.listModels()
        const model = items[0]
        if (!model) return { kind: 'error', text: '还没有可测试的模型。请先登录并加载模型。' }
        try {
          let visible = false
          let stopped = false
          for await (const chunk of llm.stream({ provider: ROUTE, model: model.id, signal,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
          })) {
            if (chunk.type === 'text-delta' && chunk.text.trim()) visible = true
            if (chunk.type === 'finish') stopped = chunk.reason.kind === 'stop'
          }
          if (visible && stopped) return { kind: 'success', text: `订阅推理测试通过：${model.id} 返回文本并正常结束。` }
        } catch { /* keep transport or credential detail out of the session log */ }
        return { kind: 'error', text: `订阅推理测试未收到正常完成的响应（${model.id}）。` }
      }
      return { kind: 'error', text: '用法：/chatgpt-plan login | status | usage | models | info MODEL_ID | images | test | cancel | logout' }
    },
  }))
  ctx.on('credentials/record-updated', changed => {
    if (changed !== key || disconnecting) return
    void credentials.readRecord(key).then(record => {
      const grant = grantRecord(record)
      const next = grant?.dshBinding
      if (lifetime.signal.aborted || disconnecting || (grant && (binding === undefined || binding === next))) return
      if (binding === undefined && !catalog.size) return
      ++generation
      clearTimeout(retryTimer)
      retryIndex = 0
      binding = next
      specs = new Map()
      refreshedAt = undefined
      refreshError = false
      releaseInitial?.()
      publish(new Map())
    }).catch(() => {})
  })
  ctx.effect(() => {
    // Every attempt has a 25-second budget, shorter than the refresh interval.
    const timer = setInterval(() => syncCatalog().catch(() => {}), CATALOG_REFRESH_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  })
}
