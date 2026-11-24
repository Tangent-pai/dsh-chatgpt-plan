import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageRoute, formatCodexUsage, usageCommand, RESET_PATH, USAGE_PATH } from './usage.js'

const snapshot = {
  accountId: 'private-account-id',
  rateLimits: { limitId: 'historical-duplicate', primary: { usedPercent: 42 } },
  rateLimitsByLimitId: {
    codex: { limitName: 'Codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1784300000 }, secondary: { usedPercent: 17, windowDurationMins: 10080 }, credits: { balance: '123.45', hasCredits: true } },
    other: { primary: { usedPercent: 109, windowDurationMins: 15 }, individualLimit: { remainingPercent: 23, used: '77', limit: '100', resetsAt: 1784300000 }, spendControlReached: true },
  },
  ordinaryUsageAllowed: false,
  rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'private-credit-id' }] },
}
test('multi-bucket windows, independent balances, reset counts and backend permission', () => {
  const text = formatCodexUsage(snapshot, 'pro')
  for (const part of ['Codex 订阅用量（pro）', '5 小时窗口：已用 0%，约剩 100%', '1 周窗口：已用 17%，约剩 83%', '15 分钟窗口：已用 109%，约剩 0%', '额外积分余额：123.45', '可用重置次数：2', '个人消费控制：剩余 23%', '服务端当前限制', 'chatgpt.com/codex/settings/usage']) assert.ok(text.includes(part), part)
  assert.doesNotMatch(text, /historical-duplicate|private-account-id|private-credit-id/)
})
test('legacy, empty, malformed and unlimited are distinct', () => {
  assert.match(formatCodexUsage({ rateLimits: { credits: { unlimited: true } }, rateLimitsByLimitId: {} }), /默认额度组[\s\S]*额外积分：不限量/)
  const empty = formatCodexUsage({ rateLimits: { primary: { usedPercent: null } } })
  assert.match(empty, /本次未返回可展示/)
  assert.doesNotMatch(empty, /约剩|已用 0%/)
  assert.throws(() => formatCodexUsage({}), /Invalid Codex/)
})
test('documented RPC uses only Codex ChatGPT auth, errors do not expose payload', async () => {
  let type = 'apiKey'; const calls = []
  const bridge = { connect: async () => ({ request: async (method, params, { signal }) => {
    calls.push([method, params]); assert.ok(signal instanceof AbortSignal)
    if (method === 'account/read') return { account: { email: 'personal@example.com', type, planType: 'pro' } }
    if (type === 'chatgpt') return snapshot
    throw new Error('private-error')
  } }) }
  assert.match((await usageCommand(bridge, [])).text, /image-login/)
  assert.equal(calls.length, 1)
  type = 'chatgpt'
  const result = await usageCommand(bridge, [])
  assert.equal(result.kind, 'success')
  assert.doesNotMatch(result.text, /personal@example.com/)
  assert.deepEqual(calls.slice(1), [['account/read', { refreshToken: false }], ['account/rateLimits/read', { excludeResetCreditDetails: true }]])
  const failure = await usageCommand({ connect: async () => { throw new Error('private-error') } }, [])
  assert.equal(failure.kind, 'error'); assert.doesNotMatch(failure.text, /private-error/)
})
test('caller can cancel during shared startup without any quota RPC', async () => {
  const controller = new AbortController(); let resolve; let requests = 0
  const starting = new Promise(r => { resolve = r })
  const pending = usageCommand({ connect: () => starting }, [controller.signal])
  controller.abort()
  assert.equal((await pending).kind, 'error')
  resolve({ request: () => requests++ })
  await starting
  assert.equal(requests, 0)
})

test('sidebar endpoint returns a narrow quota snapshot, coalesces and clears on auth change', async () => {
  let count = 0, now = 1000, account = { type: 'chatgpt', email: 'private@example.com' }
  const bridge = { connect: async () => ({ request: async method => {
    if (method === 'account/read') return { account }
    count++
    return snapshot
  } }) }
  const lifetime = new AbortController()
  const { route, invalidate } = createUsageRoute(bridge, lifetime.signal, () => now)
  const request = () => route.fetch(new Request(`https://dsh.example${USAGE_PATH}`))
  const [a, b] = await Promise.all([request(), request()])
  assert.equal(count, 1)
  assert.equal(a.headers.get('cache-control'), 'no-store')
  const first = await a.json()
  assert.deepEqual(first, await b.json())
  assert.equal(first.fetchedAt, 1000)
  assert.equal(first.buckets[0].windows[0].usedPercent, 0)
  assert.equal(first.buckets[0].credits.balance, '123.45')
  assert.equal(first.resetCount, 2)
  assert.doesNotMatch(JSON.stringify(first), /private|historical-duplicate/)
  now = 2000; assert.equal((await (await request()).json()).fetchedAt, 1000)
  now = 11000; assert.equal((await (await request()).json()).fetchedAt, 11000)
  assert.equal(count, 2)
  account = { type: 'apiKey' }; invalidate()
  assert.deepEqual(await (await request()).json(), { state: 'signed-out' })
  assert.equal(count, 2)
  lifetime.abort(); assert.equal((await request()).status, 503)
})

test('an invalidated pending query cannot publish an earlier account snapshot', async () => {
  let release, reached
  const waiting = new Promise(resolve => { reached = resolve })
  const oldAnswer = new Promise(resolve => { release = resolve })
  let type = 'chatgpt'
  const bridge = { connect: async () => ({ request: async method => {
    if (method === 'account/read') return { account: { type } }
    reached(); return oldAnswer
  } }) }
  const { route, invalidate } = createUsageRoute(bridge, new AbortController().signal)
  const request = () => route.fetch(new Request(`https://dsh.example${USAGE_PATH}`))
  const oldResult = request()
  await waiting
  type = 'apiKey'; invalidate()
  assert.deepEqual(await (await request()).json(), { state: 'signed-out' })
  release(snapshot)
  const response = await oldResult
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { state: 'error' })
  assert.deepEqual(await (await request()).json(), { state: 'signed-out' })
})

const RESET_METHOD = 'account/rateLimitResetCredit/consume'
function resetFixture() {
  let now = 1_000, account = { type: 'chatgpt', email: 'private@example.com' }, data = snapshot
  let mutate = () => ({ outcome: 'reset' })
  const calls = [], lifetime = new AbortController()
  const rpc = { request: async (method, params, options) => {
    calls.push({ method, params, options })
    if (method === 'account/read') return { account }
    if (method === 'account/rateLimits/read') return data
    if (method === RESET_METHOD) return mutate(options)
    assert.fail(`Unexpected RPC: ${method}`)
  } }
  const { route, resetRoute, invalidate } = createUsageRoute({ connect: async () => rpc }, lifetime.signal, () => now)
  const read = async (force = false) => (await route.fetch(new Request(`https://dsh.example${USAGE_PATH}${force ? '?refresh=1' : ''}`))).json()
  const submit = (resetToken, init = {}) => resetRoute.fetch(new Request(`https://dsh.example${RESET_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, resetToken }), ...init,
  }))
  return { read, submit, calls, resetRoute, invalidate, lifetime, advance: time => { now += time },
    setAccount: value => { account = value }, setData: value => { data = value }, setMutation: action => { mutate = action } }
}

test('reset route validates POST, JSON confirmation and current offer before any mutation', async () => {
  const fx = resetFixture()
  assert.equal(fx.resetRoute.path, RESET_PATH)
  assert.deepEqual(fx.resetRoute.methods, ['POST'])
  assert.equal(fx.resetRoute.requestBody, 'buffered')
  const { resetToken } = await fx.read()
  assert.match(resetToken, /^[a-f0-9-]{36}$/)
  assert.equal((await fx.read(true)).resetToken, resetToken)
  assert.equal((await fx.submit(resetToken, { method: 'GET', body: undefined })).status, 405)
  for (const init of [
    { headers: { 'content-type': 'text/plain' } }, { body: '{' },
    { body: JSON.stringify({ resetToken }) }, { body: JSON.stringify({ confirm: false, resetToken }) },
    { body: JSON.stringify({ confirm: true, resetToken, creditId: 'caller-chosen' }) },
    { body: JSON.stringify({ confirm: true, resetToken }) + ' '.repeat(200) },
  ]) assert.equal((await fx.submit(resetToken, init)).status, 400)
  assert.equal((await fx.submit('00000000-0000-4000-8000-000000000000')).status, 409)
  fx.advance(120_000)
  assert.equal((await fx.submit(resetToken)).status, 409)
  assert.notEqual((await fx.read()).resetToken, resetToken)
  assert.equal(fx.calls.filter(call => call.method === RESET_METHOD).length, 0)
})

test('one confirmed offer uses one official idempotency key, rejects in-flight duplicates, refreshes cache', async () => {
  const fx = resetFixture()
  let arrived, release
  const atMutation = new Promise(resolve => { arrived = resolve })
  const backend = new Promise(resolve => { release = resolve })
  fx.setMutation(options => { assert.equal(options.signal, fx.lifetime.signal); arrived(); return backend })
  const first = await fx.read()
  assert.doesNotMatch(JSON.stringify(first), /private@example.com|private-account-id|private-credit-id/)
  const browser = new AbortController()
  const call = fx.submit(first.resetToken, { signal: browser.signal })
  await atMutation
  assert.deepEqual(await fx.read(), { state: 'resetting' })
  const duplicate = await fx.submit(first.resetToken)
  assert.equal(duplicate.status, 409)
  assert.deepEqual(await duplicate.json(), { outcome: 'pending' })
  browser.abort()
  fx.setData({ ...snapshot, rateLimitResetCredits: { availableCount: 1 } })
  release({ outcome: 'reset', backstageValue: 'private' })
  const sent = await call
  assert.equal(sent.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await sent.json(), { outcome: 'reset' })
  assert.deepEqual(await (await fx.submit(first.resetToken)).json(), { outcome: 'reset' })
  const fresh = await fx.read()
  assert.equal(fresh.resetCount, 1)
  assert.notEqual(fresh.resetToken, first.resetToken)
  assert.deepEqual(fx.calls.filter(c => c.method === RESET_METHOD).map(c => c.params), [{ idempotencyKey: first.resetToken }])
})

test('a stale account or no remaining credit prevents ever dispatching reset', async () => {
  const fx = resetFixture()
  const first = await fx.read()
  fx.invalidate()
  assert.deepEqual(await (await fx.submit(first.resetToken)).json(), { outcome: 'stale' })
  const second = await fx.read()
  fx.setAccount({ type: 'chatgpt', email: 'different@example.com' })
  assert.deepEqual(await (await fx.submit(second.resetToken)).json(), { outcome: 'stale' })
  const third = await fx.read()
  fx.setData({ ...snapshot, rateLimitResetCredits: { availableCount: 0 } })
  assert.deepEqual(await (await fx.submit(third.resetToken)).json(), { outcome: 'noCredit' })
  const zero = await fx.read()
  assert.equal(zero.resetCount, 0)
  assert.equal(zero.resetToken, undefined)
  fx.setData({ ...snapshot, rateLimitResetCredits: null })
  const unknown = await fx.read(true)
  assert.equal(unknown.resetCount, undefined)
  assert.equal(unknown.resetToken, undefined)
  fx.setAccount({ type: 'apiKey' })
  assert.deepEqual(await fx.read(true), { state: 'signed-out' })
  assert.equal(fx.calls.filter(c => c.method === RESET_METHOD).length, 0)
})

test('Codex decides eligibility and replay outcomes; transport uncertainty stops all further submissions', async () => {
  const fx = resetFixture()
  for (const value of ['nothingToReset', 'alreadyRedeemed', 'noCredit']) {
    fx.setMutation(() => ({ outcome: value }))
    assert.deepEqual(await (await fx.submit((await fx.read()).resetToken)).json(), { outcome: value })
  }
  fx.setMutation(() => { throw new Error('private transport error') })
  const { resetToken } = await fx.read()
  const result = await fx.submit(resetToken)
  assert.equal(result.status, 503)
  assert.deepEqual(await result.json(), { outcome: 'uncertain' })
  fx.invalidate()
  assert.deepEqual(await (await fx.submit(resetToken)).json(), { outcome: 'uncertain' })
  const blocked = await fx.read()
  assert.equal(blocked.resetBlocked, 'uncertain')
  assert.equal(blocked.resetToken, undefined)
  assert.equal(fx.calls.filter(c => c.method === RESET_METHOD).length, 4)
})

test('a method-not-found reply redirects to the official workflow without leaking error details', async () => {
  const fx = resetFixture()
  fx.setMutation(() => { throw Object.assign(new Error('private'), { code: -32601 }) })
  const response = await fx.submit((await fx.read()).resetToken)
  assert.deepEqual(await response.json(), { outcome: 'unsupported' })
  const next = await fx.read()
  assert.equal(next.resetToken, undefined)
  assert.equal(next.resetBlocked, 'unsupported')
})
