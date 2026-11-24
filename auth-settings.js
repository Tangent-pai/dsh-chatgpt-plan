export const AUTH_PATH = '/api/chatgpt-plan/auth'
const reply = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } })

export function codexDevicePage(value) {
  const url = new URL(value)
  if (!['https://auth.openai.com', 'https://chatgpt.com'].includes(url.origin) || url.username || url.password) {
    throw new Error('Unexpected Codex verification address')
  }
  return url.href
}

// Only the owner's settings carrier calls these routes. Operations are scoped
// to the plugin lifetime, not to a tab's fetch: closing Settings is not Cancel.
export function createAuthSettings({ lifetime, textStatus, loginText, loginCodex, cancelCodex, codexStatus,
  openDevicePage, invalidateUsage, cancelText = () => {}, textTimeout = 180_000, codexTimeout = 15 * 60_000 }) {
  const text = { state: 'signedOut' }, codex = { state: 'signedOut' }
  let textJob, codexJob, code, codexRead, codexBusy, textRevision = 0, codexRevision = 0
  const snapshot = () => ({ text: { state: text.state }, codex: { state: codex.state,
    ...(codex.state === 'pending' && code ? code : {}) } })
  async function startText(signal = lifetime) {
    if (textJob) return { kind: 'error', text: '已有文字登录进行中。' }
    const controller = new AbortController()
    const timeout = AbortSignal.timeout(textTimeout)
    const active = AbortSignal.any([lifetime, signal, controller.signal, timeout])
    textJob = controller
    textRevision++
    text.state = 'pending'
    try {
      const result = await loginText(active)
      const configured = await textStatus().then(s => s.configured, () => false)
      text.state = result.browserFailed ? 'failed' : configured ? 'connected' : timeout.aborted ? 'expired'
        : active.aborted || result.cancelled ? 'cancelled' : 'failed'
      return result.command
    } catch {
      text.state = timeout.aborted ? 'expired' : active.aborted ? 'cancelled' : 'failed'
      return { kind: 'error', text: '文字登录未完成。请稍后重试。' }
    } finally { textJob = undefined; textRevision++ }
  }
  function stopText() { textJob?.abort() }
  function clearCode() {
    code = undefined
    clearTimeout(codexJob?.timer)
    codexJob?.unsubscribe?.()
    codexJob = undefined
    codexRevision++
  }
  async function stopCodex(signal = lifetime, state = 'cancelled') {
    if (codexBusy) throw new Error('Codex login operation in progress')
    codexBusy = true
    try {
      await cancelCodex(signal)
      clearCode()
      codex.state = state
      invalidateUsage()
    } catch (error) {
      clearCode()
      codex.state = 'failed'
      throw error
    } finally { codexBusy = false }
  }
  async function runCodexLogout(logout) {
    if (codexBusy) throw new Error('Codex login operation in progress')
    codexBusy = true
    ++codexRevision
    try {
      if (codexJob) await cancelCodex(AbortSignal.any([lifetime, AbortSignal.timeout(10_000)]))
      await logout()
      clearCode()
      codex.state = 'signedOut'
    } catch (error) {
      clearCode()
      codex.state = 'failed'
      throw error
    } finally { codexBusy = false }
  }
  async function startCodex(signal = lifetime, open = true) {
    if (codexBusy || codexJob) throw new Error('Codex login already in progress')
    codexBusy = true
    ++codexRevision
    codex.state = 'checking'
    invalidateUsage()
    const active = AbortSignal.any([lifetime, signal, AbortSignal.timeout(35_000)])
    let unsubscribe
    try {
      const preexisting = await codexStatus(active).then(result => result.connected, () => true)
      let completion
      const applyCompletion = success => {
        completion = success
        if (!codexJob || lifetime.aborted) return
        clearCode()
        codex.state = success ? 'connected' : 'failed'
        invalidateUsage()
      }
      const data = await loginCodex(active, applyCompletion)
      unsubscribe = data.unsubscribe
      const verificationUrl = codexDevicePage(data.verificationUrl)
      if (typeof data.userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(data.userCode)) throw new Error('Invalid device code')
      active.throwIfAborted()
      code = { verificationUrl, userCode: data.userCode }
      const issued = code
      const job = { unsubscribe, preexisting, timer: setTimeout(() => {
        if (codexJob !== job || lifetime.aborted) return
        void stopCodex(AbortSignal.any([lifetime, AbortSignal.timeout(20_000)]), 'expired').catch(() => {})
      }, codexTimeout) }
      job.timer.unref?.()
      codexJob = job
      codex.state = 'pending'
      // The still-visible official link is the fallback when Windows cannot open its browser.
      if (completion !== undefined) applyCompletion(completion)
      if (open && completion === undefined) void Promise.resolve().then(() => {
        if (codexJob === job && !active.aborted) return openDevicePage(verificationUrl, active)
      }).catch(() => {})
      return issued
    } catch (error) {
      if (!codexJob) unsubscribe?.()
      clearCode()
      codex.state = 'failed'
      await cancelCodex(AbortSignal.any([lifetime, AbortSignal.timeout(5_000)])).catch(() => {})
      throw error
    } finally { codexBusy = false; invalidateUsage() }
  }
  async function refresh(signal, refreshCodex = true) {
    const rev = textRevision
    const first = async () => {
      if (textJob) return
      try {
        const s = await textStatus()
        if (rev !== textRevision || textJob) return
        if (s.inFlight) text.state = 'pending'
        else if (s.configured) text.state = 'connected'
        else if (['connected', 'pending', 'checking', 'statusUnavailable'].includes(text.state)) text.state = 'signedOut'
      } catch { if (rev === textRevision && !textJob) text.state = 'statusUnavailable' }
    }
    const second = async () => {
      if (!refreshCodex || codexBusy) return
      if (codexRead) return codexRead
      const revision = codexRevision
      codexRead = (async () => {
        try {
          const result = await codexStatus(AbortSignal.any([lifetime, AbortSignal.timeout(12_000)]))
          if (revision !== codexRevision || codexBusy || lifetime.aborted) return
          if (result.connected && !codexJob?.preexisting) {
            if (codexJob) { clearCode(); invalidateUsage() }
            codex.state = 'connected'
          } else if (!result.connected && !codexJob && ['connected', 'checking', 'statusUnavailable'].includes(codex.state)) codex.state = 'signedOut'
        } catch { if (revision === codexRevision && !codexJob && !codexBusy) codex.state = 'statusUnavailable' }
      })().finally(() => { codexRead = undefined })
      return codexRead
    }
    await Promise.all([first(), second()])
    signal.throwIfAborted()
    lifetime.throwIfAborted()
    return snapshot()
  }
  async function validPost(request) {
    if (new URL(request.url).search || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return false
    try {
      const body = await request.text()
      if (body.length > 64) return false
      const parsed = JSON.parse(body)
      return parsed?.confirm === true && Object.keys(parsed).length === 1
    } catch { return false }
  }
  const post = (suffix, handle) => ({ path: `${AUTH_PATH}/${suffix}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return reply({ error: 'method' }, 405)
      if (!(await validPost(request))) return reply({ error: 'invalid' }, 400)
      if (request.signal.aborted || lifetime.aborted) return reply({ error: 'unavailable' }, 503)
      try { await handle(); return reply(snapshot()) }
      catch { return reply({ error: 'unavailable' }, 503) }
    },
  })
  const routes = [
    { path: AUTH_PATH, methods: ['GET'], requestBody: 'buffered', async fetch(request) {
      if (request.method !== 'GET') return reply({ error: 'method' }, 405)
      try { return reply(await refresh(request.signal)) } catch { return reply({ error: 'unavailable' }, 503) }
    } },
    post('text/start', () => { if (!textJob) void startText() }),
    post('text/cancel', () => { stopText(); cancelText() }),
    post('codex/start', () => { if (!codexJob && !codexBusy) void startCodex().catch(() => {}) }),
    post('codex/cancel', () => {
      if (!codexJob || codexBusy) throw new Error('No cancellable login')
      codex.state = 'checking'
      void stopCodex(AbortSignal.any([lifetime, AbortSignal.timeout(20_000)])).catch(() => {})
    }),
  ]
  lifetime.addEventListener('abort', () => { stopText(); clearCode() }, { once: true })
  return { routes, startText, stopText, startCodex, stopCodex, runCodexLogout }
}
