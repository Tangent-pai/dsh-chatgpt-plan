import { createRequire } from 'node:module'
import { mkdir, realpath, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { CodexRpc } from './codex-rpc.js'
import { PNG } from 'pngjs'

export const CODEX_VERSION = '0.169.0'
export const IMAGE_MODEL = 'gpt-image-2'
export function codexExecutable() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('生图桥当前仅验收 Windows x64。')
  const require = createRequire(import.meta.url)
  const codexRequire = createRequire(require.resolve('@openai/codex/package.json'))
  const manifest = codexRequire.resolve('@openai/codex-win32-x64/package.json')
  return join(dirname(manifest), 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
}
export function isolatedCodexEnv(home, env = process.env) {
  const next = { ...env, CODEX_HOME: home }
  for (const name of Object.keys(next)) {
    if (/^(?:OPENAI|CODEX)_.*(?:KEY|TOKEN|BASE_URL|API_BASE)$/i.test(name)) delete next[name]
  }
  return next
}
export async function verifiedImage(savedPath, home, signal) {
  signal?.throwIfAborted()
  if (typeof savedPath !== 'string' || !isAbsolute(savedPath)) throw new Error('生成事件没有返回本机图片路径。')
  const root = await realpath(join(home, 'generated_images'))
  const source = await realpath(savedPath)
  const rel = relative(root, source)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('图片路径不在本桥接生成目录内。')
  const info = await stat(source)
  if (!info.isFile() || info.size < 33 || info.size > 50 * 1024 * 1024) throw new Error('生成图片文件大小异常。')
  const bytes = await readFile(source, { signal })
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('生成结果不是 PNG 图片。')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32000000) throw new Error('生成图片尺寸超出交付界限。')
  try { PNG.sync.read(bytes, { checkCRC: true }) } catch { throw new Error('生成图片解码校验失败。') }
  const out = join(home, 'deliveries')
  await mkdir(out, { recursive: true })
  signal?.throwIfAborted()
  const destination = join(out, `${randomUUID()}.png`)
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o600, signal })
  signal?.throwIfAborted()
  return destination
}

export class ImageBridge {
  constructor({ home = join(homedir(), '.dsh-chatgpt-plan', 'codex'), executable, rpcFactory = options => new CodexRpc(options) } = {}) {
    this.home = home; this.executable = executable; this.rpcFactory = rpcFactory
    this.rpc = undefined; this.starting = undefined; this.busy = false; this.closed = false
  }
  async connect() {
    if (this.closed) throw new Error('生图桥已停止。')
    if (this.rpc && !this.rpc.closed) return this.rpc
    this.rpc = undefined
    if (this.starting) return this.starting
    this.starting = (async () => {
      await mkdir(join(this.home, 'workspace'), { recursive: true })
      const rpc = this.rpcFactory({ executable: this.executable ?? codexExecutable(),
        args: ['app-server', '--stdio', '-c', 'features.image_generation=true', '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"'],
        cwd: join(this.home, 'workspace'), env: isolatedCodexEnv(this.home) })
      try {
        await rpc.start()
        await rpc.request('initialize', { clientInfo: { name: 'dsh_chatgpt_plan_images', title: 'DSH ChatGPT Plan Images', version: '0.1.4' }, capabilities: { experimentalApi: false, requestAttestation: false } })
        rpc.notify('initialized', {})
        if (this.closed) throw new Error('生图桥已停止。')
        this.rpc = rpc
        return rpc
      } catch (error) { rpc.close(); throw error }
    })().finally(() => { this.starting = undefined })
    return this.starting
  }
  async account(signal) {
    const rpc = await this.connect()
    const result = await rpc.request('account/read', { refreshToken: false }, { signal })
    // Deliberately never return email or any credential-bearing account fields.
    return { connected: result.account?.type === 'chatgpt', plan: result.account?.type === 'chatgpt' ? result.account.planType : undefined,
      route: 'official-codex-app-server', imageModel: IMAGE_MODEL, imageModelSelectable: false }
  }
  async login(signal, onComplete) {
    const rpc = await this.connect()
    if (this.busy) throw new Error('生图进行中，请完成后再登录。')
    let loginId
    const observed = new Map()
    const unsubscribe = onComplete ? rpc.onNotification((method, event) => {
      if (method !== 'account/login/completed' || typeof event?.loginId !== 'string' || typeof event.success !== 'boolean') return
      if (event.loginId === loginId) onComplete(event.success)
      else if (loginId === undefined && observed.size < 8) observed.set(event.loginId, event.success)
    }) : undefined
    try {
      const result = await rpc.request('account/login/start', { type: 'chatgptDeviceCode' }, { signal })
      if (result.type !== 'chatgptDeviceCode' || typeof result.verificationUrl !== 'string' || typeof result.userCode !== 'string') throw new Error('官方登录未返回设备验证码。')
      this.loginId = loginId = result.loginId
      const url = new URL(result.verificationUrl)
      if (!['https://auth.openai.com', 'https://chatgpt.com'].includes(url.origin) || url.username || url.password) throw new Error('登录地址校验失败。')
      if (observed.has(loginId)) onComplete(observed.get(loginId))
      observed.clear()
      return { verificationUrl: url.href, userCode: result.userCode, ...(unsubscribe && { unsubscribe }) }
    } catch (error) { unsubscribe?.(); throw error }
  }
  async cancelLogin(signal) {
    if (this.loginId && this.rpc) await this.rpc.request('account/login/cancel', { loginId: this.loginId }, { signal })
    this.loginId = undefined
  }
  async logout(signal) {
    if (this.busy) throw new Error('生图进行中，请先取消或等待结束。')
    const rpc = await this.connect()
    await rpc.request('account/logout', {}, { signal })
    this.loginId = undefined
  }
  async models(signal) {
    const rpc = await this.connect()
    if (!(await this.account(signal)).connected) throw new Error('请先运行 /chatgpt-plan image-login 完成独立的 Codex ChatGPT 登录。')
    const items = []; let cursor, pages = 0, total = 0
    const cursors = new Set()
    do {
      if (++pages > 20) throw new Error('官方模型目录分页异常。')
      const page = await rpc.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) }, { signal })
      if (!Array.isArray(page.data)) throw new Error('官方 Codex 模型目录格式异常。')
      items.push(...page.data.filter(model => Array.isArray(model.inputModalities) && model.inputModalities.includes('image')))
      total += page.data.length; cursor = page.nextCursor
      if (total > 1000 || (cursor && (typeof cursor !== 'string' || cursors.has(cursor)))) throw new Error('官方模型目录分页异常。')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return items
  }
  async generate(prompt, { signal, coordinator } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw new Error('图片描述需为 1–16000 个字符。')
    if (this.busy) throw new Error('已有生图请求进行中，请等待该请求结束。')
    this.busy = true
    const active = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10 * 60 * 1000)])
    let unsubscribe, stopListening, threadId, turnId, rpc, done, rejectDone, abortListener
    const events = []; const images = []
    try {
      rpc = await this.connect()
      const choices = await this.models(active)
      const model = coordinator ? choices.find(item => item.id === coordinator || item.model === coordinator) : choices.find(item => item.isDefault) ?? choices[0]
      if (!model) throw new Error('官方目录暂无可用于生图调度的图像输入模型。')
      const thread = await rpc.request('thread/start', { cwd: join(this.home, 'workspace'), modelProvider: 'openai', model: model.model ?? model.id,
        approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
        developerInstructions: 'Generate exactly one still PNG image with image_gen.imagegen. Do not invoke shell commands, read unrelated files, edit files, browse, or delegate. If image_gen.imagegen is unavailable, say so rather than inventing a generated file.' }, { signal: active })
      threadId = thread.thread?.id
      if (typeof threadId !== 'string') throw new Error('官方桥未创建生图会话。')
      // Notifications may precede the turn/start response; buffer until the turn ID is known.
      const finished = new Promise((resolve, reject) => { done = resolve; rejectDone = reject })
      finished.catch(() => {})
      stopListening = rpc.onClose?.(() => rejectDone(new Error('官方生图进程已退出，请重试。')))
      const consume = event => {
        const p = event.params
        if (!p || p.threadId !== threadId) return
        if (event.method !== 'turn/completed' && !(event.method === 'item/completed' && p.item?.type === 'imageGeneration')) return
        const eventTurn = p.turnId ?? p.turn?.id
        if (!turnId) { events.push(event); return }
        if (eventTurn !== turnId || active.aborted) return
        if (event.method === 'item/completed' && p.item?.type === 'imageGeneration' && p.item.status === 'completed' && !p.item.failure) images.push(p.item)
        if (event.method === 'turn/completed') {
          if (p.turn?.status === 'completed') done()
          else rejectDone(new Error('官方生图调度未正常结束。'))
        }
      }
      unsubscribe = rpc.onNotification((method, params) => consume({ method, params }))
      abortListener = () => { rejectDone(active.reason); if (turnId) void rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }).catch(() => {}) }
      active.addEventListener('abort', abortListener, { once: true })
      active.throwIfAborted()
      const started = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: `Generate one image using image_gen.imagegen. Image description:\n${prompt}`, text_elements: [] }] }, { signal: active })
      turnId = started.turn?.id
      if (typeof turnId !== 'string') throw new Error('官方桥未开始生图调度。')
      for (const event of events) consume(event)
      await finished
      active.throwIfAborted()
      if (!images.length) throw new Error('调度结束但未返回成功图片；该账号或模型可能尚未开放原生生图。')
      const path = await verifiedImage(images[0].savedPath, this.home, active)
      return { path, imageModel: IMAGE_MODEL, coordinator: model.model ?? model.id, route: 'official-codex-app-server', modelSelection: 'Codex 0.169.0 固定图像后端，非可选 image2.6' }
    } finally {
      unsubscribe?.(); stopListening?.(); if (abortListener) active.removeEventListener('abort', abortListener)
      if (active.aborted && rpc) { rpc.close(); if (this.rpc === rpc) this.rpc = undefined }
      this.busy = false
    }
  }
  close() { this.closed = true; this.rpc?.close(); this.rpc = undefined }
}
