import { randomUUID } from 'node:crypto'

// Codex app-server v2 account/rateLimits/read. Format only documented display fields.
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max
const label = value => typeof value === 'string' && /^[\p{L}\p{N} ._()/-]{1,72}$/u.test(value) && value.trim() ? value.trim() : undefined
const number = value => typeof value === 'string' && /^-?\d{1,18}(?:\.\d{1,8})?$/.test(value) ? value : undefined
const resetTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
const reset = value => integer(value, 1, 253402300799) ? resetTime.format(value * 1000) : '未返回'
const reached = new Map([
  ['rate_limit_reached', '已达用量上限'],
  ['workspace_owner_credits_depleted', '工作区积分已耗尽（所有者）'],
  ['workspace_member_credits_depleted', '工作区积分已耗尽（成员）'],
  ['workspace_owner_usage_limit_reached', '工作区已达用量上限（所有者）'],
  ['workspace_member_usage_limit_reached', '工作区已达用量上限（成员）'],
])
function duration(mins, fallback) {
  if (!integer(mins, 1)) return fallback
  if (mins % 10080 === 0) return `${mins / 10080} 周窗口`
  if (mins % 1440 === 0) return `${mins / 1440} 天窗口`
  if (mins % 60 === 0) return `${mins / 60} 小时窗口`
  return `${mins} 分钟窗口`
}
function windowLine(window, fallback) {
  if (!object(window) || !integer(window.usedPercent, 0, 2147483647)) return undefined
  return `- ${duration(window.windowDurationMins, fallback)}：已用 ${window.usedPercent}%，约剩 ${Math.max(0, 100 - window.usedPercent)}%；重置：${reset(window.resetsAt)}`
}
function bucketLines(bucket) {
  const lines = [windowLine(bucket.primary, '主窗口'), windowLine(bucket.secondary, '次窗口')].filter(Boolean)
  if (object(bucket.credits)) {
    const credit = bucket.credits
    const balance = number(credit.balance)
    if (credit.unlimited === true) lines.push('- 额外积分：不限量（服务端标记）')
    else if (balance !== undefined) lines.push(`- 额外积分余额：${balance}`)
    else if (credit.hasCredits === false) lines.push('- 额外积分：无可用积分')
    else if (credit.hasCredits === true) lines.push('- 额外积分：可用，未返回余额')
  }
  if (object(bucket.individualLimit) && integer(bucket.individualLimit.remainingPercent, 0, 100)) {
    const limit = number(bucket.individualLimit.limit), used = number(bucket.individualLimit.used)
    lines.push(`- 个人消费控制：剩余 ${bucket.individualLimit.remainingPercent}%${limit !== undefined && used !== undefined ? `（已用 ${used} / 上限 ${limit}）` : ''}；重置：${reset(bucket.individualLimit.resetsAt)}`)
  }
  if (bucket.spendControlReached === true) lines.push('- 已达消费控制上限（服务端标记）')
  if (reached.has(bucket.rateLimitReachedType)) lines.push(`- ${reached.get(bucket.rateLimitReachedType)}`)
  return lines
}
export function formatCodexUsage(response, plan) {
  if (!object(response) || !object(response.rateLimits)) throw new Error('Invalid Codex rate limits response')
  const buckets = object(response.rateLimitsByLimitId)
    ? Object.entries(response.rateLimitsByLimitId).filter(([, value]) => object(value)) : []
  if (!buckets.length) buckets.push([response.rateLimits.limitId ?? '默认额度组', response.rateLimits])
  const lines = [`Codex 订阅用量${label(plan) && plan !== 'unknown' ? `（${label(plan)}）` : ''} · 本次实时查询`]
  let shown = 0
  for (const [key, bucket] of buckets.slice(0, 20)) {
    const data = bucketLines(bucket)
    if (!data.length) continue
    const id = label(bucket.limitId) ?? label(key), name = label(bucket.limitName)
    lines.push(`\n${name && id && name !== id ? `${name}（${id}）` : name ?? id ?? '未命名额度组'}`, ...data)
    shown++
  }
  if (buckets.length > 20) lines.push('仅显示服务端返回的前 20 组。')
  if (integer(response.rateLimitResetCredits?.availableCount, 0)) {
    lines.push(`可用重置次数：${response.rateLimitResetCredits.availableCount}（不是积分余额）`)
    shown++
  }
  if (typeof response.ordinaryUsageAllowed === 'boolean') {
    lines.push(`套餐内用量：服务端当前${response.ordinaryUsageAllowed ? '允许' : '限制'}`)
    shown++
  }
  if (!shown) lines.push('本次未返回可展示的用量或积分余额；不代表已用完或不限量。')
  lines.push('\n数据来自独立登录的 Codex 账号。剩余百分比仅对应各自窗口，不代表 SIWC 文本、独立生图额度或 API 余额。Codex 生图与其他 Codex 活动共用通用用量限制。\nCodex 用量管理：https://chatgpt.com/codex/settings/usage\nChatGPT 订阅用量管理：https://chatgpt.com/settings/usage')
  return lines.join('\n')
}

async function queryCodexUsage(bridge, signal) {
  signal?.throwIfAborted()
  // Stop waiting on cancellation without interrupting a shared bridge startup.
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  let rpc
  try { rpc = await Promise.race([aborted, bridge.connect()]) }
  finally { signal?.removeEventListener('abort', onAbort) }
  signal?.throwIfAborted()
  const { account } = await rpc.request('account/read', { refreshToken: false }, { signal })
  if (account?.type !== 'chatgpt') return undefined
  // Do not opt into experimental reserve/fallback or retrieve reset credit IDs.
  const result = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true }, { signal })
  // Account identity is used internally to bind an offered reset to the same
  // account and app-server instance; it is never included in a web response.
  return { result, plan: account.planType, rpc, email: account.email }
}

export async function readCodexUsage(bridge, signal) {
  const data = await queryCodexUsage(bridge, signal)
  return data && formatCodexUsage(data.result, data.plan)
}

export function codexUsageSnapshot(response, fetchedAt) {
  if (!object(response) || !object(response.rateLimits)) throw new Error('Invalid Codex rate limits response')
  const entries = object(response.rateLimitsByLimitId)
    ? Object.entries(response.rateLimitsByLimitId).filter(([, value]) => object(value)) : []
  if (!entries.length) entries.push([response.rateLimits.limitId, response.rateLimits])
  const buckets = []
  for (const [key, bucket] of entries.slice(0, 20)) {
    const windows = []
    for (const kind of ['primary', 'secondary']) {
      const value = bucket[kind]
      if (!object(value) || !integer(value.usedPercent, 0, 2147483647)) continue
      windows.push({ kind, usedPercent: value.usedPercent,
        durationMins: integer(value.windowDurationMins, 1) ? value.windowDurationMins : undefined,
        resetsAt: integer(value.resetsAt, 1, 253402300799) ? value.resetsAt : undefined })
    }
    const credits = object(bucket.credits) ? {
      balance: number(bucket.credits.balance),
      hasCredits: typeof bucket.credits.hasCredits === 'boolean' ? bucket.credits.hasCredits : undefined,
      unlimited: typeof bucket.credits.unlimited === 'boolean' ? bucket.credits.unlimited : undefined,
    } : undefined
    const hasCreditsData = credits && Object.values(credits).some(value => value !== undefined)
    if (windows.length || hasCreditsData) buckets.push({ id: label(bucket.limitId) ?? label(key),
      name: label(bucket.limitName), windows, credits: hasCreditsData ? credits : undefined })
  }
  return { state: 'ready', fetchedAt, buckets,
    resetCount: integer(response.rateLimitResetCredits?.availableCount, 0) ? response.rateLimitResetCredits.availableCount : undefined }
}

export const USAGE_PATH = '/api/chatgpt-plan/usage'
export const RESET_PATH = `${USAGE_PATH}/reset`
const RESET_METHOD = 'account/rateLimitResetCredit/consume'
const resetOutcomes = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'])
const OFFER_TTL_MS = 120_000
const resetCount = result => result?.rateLimitResetCredits?.availableCount
const hasIdentity = data => [data.result.accountId, data.email].some(value => typeof value === 'string' && value.trim())
const sameAccount = (offer, data) => offer.rpc === data.rpc && offer.accountId === data.result.accountId && offer.email === data.email
const reply = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
const outcome = (value, status) => reply({ outcome: value }, status)

// Connection exact routes enforce browser trust, authentication, and owner-only access.
// Never serve a cached value or accept a previously offered reset after auth invalidation.
export function createUsageRoute(bridge, lifetime, now = Date.now) {
  let cached, pending, offer, resetPending, lastAttempt, resetBlocked, revision = 0
  const invalidate = () => {
    revision++
    cached = undefined
    offer = undefined
    pending?.controller.abort()
    pending = undefined
    // Keep the mutating lock through completion. Auth changes do not imply
    // that an already-dispatched reset was rolled back.
  }
  function load(force) {
    lifetime.throwIfAborted()
    if (resetPending) return { state: 'resetting' }
    if (!force && cached && now() - cached.fetchedAt < 10_000) return cached
    if (pending) return pending.task
    const entry = { controller: new AbortController() }
    const signal = AbortSignal.any([lifetime, entry.controller.signal, AbortSignal.timeout(20_000)])
    entry.task = (async () => {
      const data = await queryCodexUsage(bridge, signal)
      signal.throwIfAborted()
      if (!data) { offer = undefined; cached = undefined; return { state: 'signed-out' } }
      const snapshot = codexUsageSnapshot(data.result, now())
      if (resetBlocked) snapshot.resetBlocked = resetBlocked
      else if (integer(snapshot.resetCount, 1) && hasIdentity(data)) {
        if (!offer || offer.expiresAt <= now() || !sameAccount(offer, data)) {
          offer = { key: randomUUID(), expiresAt: now() + OFFER_TTL_MS, rpc: data.rpc,
            accountId: data.result.accountId, email: data.email }
        }
        snapshot.resetToken = offer.key
      } else offer = undefined
      return cached = snapshot
    })().finally(() => { if (pending === entry) pending = undefined })
    pending = entry
    return entry.task
  }
  const route = {
    path: USAGE_PATH, methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      try {
        request.signal.throwIfAborted()
        const startedAtRevision = revision
        const data = await load(new URL(request.url).searchParams.get('refresh') === '1')
        request.signal.throwIfAborted()
        lifetime.throwIfAborted()
        if (startedAtRevision !== revision) throw new Error('Usage state changed')
        return reply(data)
      } catch { return reply({ state: 'error' }, 503) }
    },
  }
  const resetRoute = {
    path: RESET_PATH, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== 'POST') return outcome('invalid', 405)
      if (url.search || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return outcome('invalid', 400)
      let input
      try {
        const body = await request.text()
        if (body.length > 128) return outcome('invalid', 400)
        input = JSON.parse(body)
      } catch { return outcome('invalid', 400) }
      if (!object(input) || Object.keys(input).length !== 2 || input.confirm !== true ||
        typeof input.resetToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.resetToken)) return outcome('invalid', 400)
      if (request.signal.aborted || lifetime.aborted) return outcome('notSent', 503)
      const key = input.resetToken
      if (resetPending) return outcome('pending', 409)
      if (lastAttempt?.key === key) return outcome(lastAttempt.value, lastAttempt.status)
      if (resetBlocked) return outcome(resetBlocked, 503)
      const granted = offer
      if (granted?.key !== key || granted.expiresAt <= now()) return outcome('stale', 409)
      const startedAtRevision = revision
      resetPending = true
      // Spend the snapshot offer synchronously, abort stale GETs and clear the
      // cache before the first await. A replay never sends another mutation.
      cached = undefined
      offer = undefined
      pending?.controller.abort()
      pending = undefined
      let dispatched = false
      const finish = (value, status = 200) => {
        lastAttempt = { key, value, status }
        return outcome(value, status)
      }
      try {
        const signal = AbortSignal.any([request.signal, lifetime, AbortSignal.timeout(20_000)])
        const data = await queryCodexUsage(bridge, signal)
        signal.throwIfAborted()
        if (startedAtRevision !== revision || !data || !sameAccount(granted, data)) return finish('stale', 409)
        if (resetCount(data.result) === 0) return finish('noCredit')
        if (!integer(resetCount(data.result), 1)) return finish('notSent', 503)
        // Backend chooses the next credit and decides which windows (if any)
        // qualify. Never infer eligibility from a plan or displayed percentage.
        // After dispatch, a closed tab must not prevent recording the outcome.
        dispatched = true
        const result = await data.rpc.request(RESET_METHOD, { idempotencyKey: key }, { signal: lifetime, timeoutMs: 20_000 })
        if (resetOutcomes.has(result?.outcome)) return finish(result.outcome)
        throw new Error('Invalid Codex reset response')
      } catch (error) {
        if (!dispatched) return finish('notSent', 503)
        // There is no documented reset-status read. With an ambiguous reply,
        // keep all plugin resets blocked for this host lifetime; use Codex UI.
        resetBlocked = error?.code === -32601 ? 'unsupported' : 'uncertain'
        return finish(resetBlocked, 503)
      } finally { resetPending = false }
    },
  }
  return { invalidate, route, resetRoute }
}

export async function usageCommand(bridge, signals) {
  const signal = AbortSignal.any([...signals.filter(Boolean), AbortSignal.timeout(20000)])
  try {
    signal.throwIfAborted()
    const text = await readCodexUsage(bridge, signal)
    signal.throwIfAborted()
    return text === undefined
      ? { kind: 'error', text: '尚未登录 Codex。请先运行 /chatgpt-plan image-login；现有 SIWC 文本登录与此独立。' }
      : { kind: 'success', text }
  } catch {
    return { kind: 'error', text: '本次未能读取 Codex 订阅用量。请检查网络和 /chatgpt-plan image-status 后重试。未返回余额不等于零。' }
  }
}
