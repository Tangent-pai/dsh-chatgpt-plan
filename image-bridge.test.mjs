import nodeTest from 'node:test'
import { PNG } from 'pngjs'
const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn)
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ImageBridge, IMAGE_MODEL, isolatedCodexEnv, verifiedImage } from './image-bridge.js'

// Offline protocol contract suite. No Codex subprocess, credentials, network or real generation.
// This deliberately small draft-07 structural checker covers the keywords used by our fixtures;
// it is not advertised as a general JSON Schema implementation (formats are annotations).
const schemas = new Map()
async function schema(name) {
  if (!schemas.has(name)) schemas.set(name, JSON.parse(await readFile(new URL(`./codex-protocol/${name}.json`, import.meta.url), 'utf8')))
  return schemas.get(name)
}
function deref(s, root) {
  return s.$ref ? s.$ref.slice(2).split('/').reduce((v, k) => v[k], root) : s
}
function check(value, s, root = s, path = '$') {
  s = deref(s, root)
  for (const child of s.allOf ?? []) check(value, child, root, path)
  for (const union of ['anyOf', 'oneOf']) if (s[union]) {
    const matches = s[union].filter(child => { try { check(value, child, root, path); return true } catch { return false } }).length
    assert.ok(union === 'oneOf' ? matches === 1 : matches >= 1, `${path}: ${union} (${matches} matches)`)
  }
  if (s.enum) assert.ok(s.enum.some(v => JSON.stringify(v) === JSON.stringify(value)), `${path}: enum`)
  if ('const' in s) assert.deepEqual(value, s.const, `${path}: const`)
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    assert.ok(types.some(t => t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : t === 'integer' ? Number.isInteger(value) : typeof value === t), `${path}: type ${types}`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of s.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key}: required`)
    for (const [key, v] of Object.entries(value)) {
      if (s.properties?.[key]) check(v, s.properties[key], root, `${path}.${key}`)
      else if (s.additionalProperties === false) assert.fail(`${path}.${key}: additional property`)
    }
  }
  if (Array.isArray(value) && s.items) value.forEach((v, i) => check(v, s.items, root, `${path}[${i}]`))
}
// Build all mandatory response fields from the checked-in official schema, then specialize IDs.
function minimal(s, root = s) {
  s = deref(s, root)
  if (s.enum) return s.enum[0]
  if ('const' in s) return s.const
  const branch = s.oneOf?.[0] ?? s.anyOf?.[0]
  if (branch) { const value = minimal(branch, root); return s.properties ? { ...minimalObject(s, root), ...asObject(value) } : value }
  if (s.allOf) { const values = s.allOf.map(child => minimal(child, root)); return s.properties ? Object.assign(minimalObject(s, root), ...values.map(asObject)) : values[0] }
  if (s.type === 'object' || s.properties) return minimalObject(s, root)
  const type = Array.isArray(s.type) ? s.type[0] : s.type
  return type === 'array' ? [] : type === 'boolean' ? false : type === 'integer' || type === 'number' ? 0 : type === 'null' ? null : ''
}
function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
function minimalObject(s, root) { return Object.fromEntries((s.required ?? []).map(k => [k, minimal(s.properties[k], root)])) }
async function valid(name, value) { const s = await schema(name); check(value, s); return value }
async function response(name, change = x => x) { const s = await schema(name); return valid(name, change(minimal(s))) }
const THREAD = 'thread-fixture', TURN = '019a93b1-0000-7000-8000-000000000001'
const png = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) })
const model = (id, inputModalities = ['text', 'image']) => ({ id, model: id, displayName: id, description: 'offline fixture', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [], inputModalities })
const turn = (status = 'completed', id = TURN, items = []) => ({ id, items, status, ...(status === 'failed' ? { error: { message: 'fixture turn failure' } } : {}) })
function image(savedPath, overrides = {}) { return { id: 'image-fixture', type: 'imageGeneration', status: 'completed', result: '', savedPath, ...overrides } }
class FakeRpc {
  constructor(options, hooks = {}) { this.options = options; this.hooks = hooks; this.log = []; this.listeners = new Set(); this.initialized = false; this.closed = false }
  start() { this.log.push('start'); return this }
  notify(method, params) { assert.equal(method, 'initialized'); assert.deepEqual(params, {}); this.log.push(method); this.initialized = true }
  onNotification(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  onClose(fn) { this.closeListeners ??= new Set(); this.closeListeners.add(fn); return () => this.closeListeners.delete(fn) }
  close() { if (this.closed) return; this.closed = true; for (const fn of this.closeListeners ?? []) fn(new Error('fixture RPC close')); this.closeListeners?.clear(); this.listeners.clear() }
  async emit(method, params) {
    await valid(method === 'account/login/completed' ? 'v2/AccountLoginCompletedNotification'
      : method === 'item/completed' ? 'v2/ItemCompletedNotification' : 'v2/TurnCompletedNotification', params)
    for (const listener of this.listeners) listener(method, params) // Real CodexRpc contract: two args.
  }
  async item(savedPath, { threadId = THREAD, turnId = TURN, ...overrides } = {}) { await this.emit('item/completed', { completedAtMs: 0, threadId, turnId, item: image(savedPath, overrides) }) }
  async completed(status = 'completed', threadId = THREAD, id = TURN) { await this.emit('turn/completed', { threadId, turn: turn(status, id) }) }
  async request(method, params, options = {}) {
    this.log.push(method)
    if (method !== 'initialize') assert.ok(this.initialized, `${method} before initialized`)
    const contracts = {
      initialize: ['v1/InitializeParams', 'v1/InitializeResponse'],
      'account/read': ['v2/GetAccountParams', 'v2/GetAccountResponse'],
      'account/login/start': ['v2/LoginAccountParams', 'v2/LoginAccountResponse'],
      'model/list': ['v2/ModelListParams', 'v2/ModelListResponse'],
      'thread/start': ['v2/ThreadStartParams', 'v2/ThreadStartResponse'],
      'turn/start': ['v2/TurnStartParams', 'v2/TurnStartResponse'],
      'turn/interrupt': ['v2/TurnInterruptParams', 'v2/TurnInterruptResponse'],
    }
    const pair = contracts[method]; assert.ok(pair, `unexpected method ${method}`)
    await valid(pair[0], params)
    options.signal?.throwIfAborted()
    let result
    if (this.hooks[method]) result = await this.hooks[method](params, options, this)
    else if (method === 'account/read') result = { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true }
    else if (method === 'model/list') result = { data: [model('fixture-coordinator')], nextCursor: null }
    else if (method === 'thread/start') result = await response(pair[1], r => { r.thread.id = THREAD; return r })
    else if (method === 'turn/start') result = { turn: turn('inProgress') }
    else result = await response(pair[1])
    return valid(pair[1], result)
  }
}
async function fixture(t, hooks = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-image-bridge-test-'))
  const root = join(home, 'generated_images'); await mkdir(root)
  const saved = join(root, 'fixture.png'); await writeFile(saved, png)
  let rpc
  const bridge = new ImageBridge({ home, executable: 'FAKE-NOT-EXECUTED', rpcFactory: options => (rpc = new FakeRpc(options, hooks)) })
  const generate = bridge.generate.bind(bridge)
  bridge.generate = (prompt, options = {}) => generate(prompt, { ...options, signal: AbortSignal.any([AbortSignal.timeout(1500), ...(options.signal ? [options.signal] : [])]) })
  t.after(async () => { bridge.close(); await rm(home, { recursive: true, force: true }) })
  return { home, saved, bridge, get rpc() { return rpc } }
}
async function delivered(home) { try { return await readdir(join(home, 'deliveries')) } catch (e) { if (e.code === 'ENOENT') return []; throw e } }
function success(saved, before = async () => {}) { return { 'turn/start': async (p, o, rpc) => { await before(rpc); await rpc.item(saved()); await rpc.completed(); return { turn: turn('inProgress') } } } }

test('initialize ordering; connect is single flight; env is isolated', async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([f.bridge.connect(), f.bridge.connect()])
  assert.equal(a, b); assert.deepEqual(a.log, ['start', 'initialize', 'initialized'])
  assert.equal(a.options.executable, 'FAKE-NOT-EXECUTED'); assert.equal(a.options.env.CODEX_HOME, f.home)
  assert.ok(a.options.args.includes('forced_login_method="chatgpt"'))
  const original = { OPENAI_API_KEY: 'fake', CODEX_API_KEY: 'fake', OPENAI_ACCESS_TOKEN: 'fake', OPENAI_BASE_URL: 'fake', CODEX_API_BASE: 'fake', PATH: 'fixture-path' }
  assert.deepEqual(isolatedCodexEnv(f.home, original), { PATH: 'fixture-path', CODEX_HOME: f.home })
  assert.equal(original.OPENAI_API_KEY, 'fake')
})
test('account only accepts chatgpt and strips email; no model request for other accounts', async t => {
  for (const account of [null, { type: 'apiKey' }, { type: 'amazonBedrock' }, { type: 'gcp' }, { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' }]) {
    const f = await fixture(t, { 'account/read': () => ({ account, requiresOpenaiAuth: true }) })
    const result = await f.bridge.account(); assert.equal(result.connected, account?.type === 'chatgpt')
    assert.ok(!JSON.stringify(result).includes('fixture@example.invalid'))
    if (!result.connected) { await assert.rejects(f.bridge.models(), /image-login/); assert.ok(!f.rpc.log.includes('model/list')) }
  }
})
test('device code return is explicit; fixed gpt-image-2 is not image2.6', async t => {
  const f = await fixture(t, { 'account/login/start': () => ({ type: 'chatgptDeviceCode', loginId: 'fixture-login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' }) })
  assert.deepEqual(await f.bridge.login(), { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' })
  assert.equal(IMAGE_MODEL, 'gpt-image-2'); assert.equal((await f.bridge.account()).imageModelSelectable, false)
})
test('device login completion only reports the matching attempt, including early notification', async t => {
  const f = await fixture(t, { 'account/login/start': async (_p, _o, rpc) => {
    await rpc.emit('account/login/completed', { loginId: 'other-login', success: false })
    await rpc.emit('account/login/completed', { loginId: 'fixture-login', success: true })
    return { type: 'chatgptDeviceCode', loginId: 'fixture-login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' }
  } })
  const results = []
  const login = await f.bridge.login(undefined, success => results.push(success))
  assert.deepEqual(results, [true])
  login.unsubscribe()
  await f.rpc.emit('account/login/completed', { loginId: 'fixture-login', success: false })
  assert.deepEqual(results, [true])
})
test('model/list pagination filters image INPUT modality and carries cursor', async t => {
  const cursors = []
  const f = await fixture(t, { 'model/list': p => { cursors.push(p.cursor); return p.cursor ? { data: [model('vision')], nextCursor: null } : { data: [model('text-only', ['text'])], nextCursor: 'page2' } } })
  assert.deepEqual((await f.bridge.models()).map(x => x.id), ['vision']); assert.deepEqual(cursors, [undefined, 'page2'])
})
test('repeated immediate pagination cursor is rejected', async t => {
  const f = await fixture(t, { 'model/list': () => ({ data: [], nextCursor: 'same' }) })
  await assert.rejects(f.bridge.models(), /分页异常/)
})
test('early notifications are buffered; mismatched thread/turn ignored; valid PNG copied', async t => {
  let f
  f = await fixture(t, success(() => f.saved, async rpc => {
    await rpc.item(join(f.home, 'wrong.png'), { threadId: 'other-thread' })
    await rpc.completed('failed', 'other-thread')
    await rpc.item(join(f.home, 'wrong.png'), { turnId: 'other-turn' })
    await rpc.completed('failed', THREAD, 'other-turn')
  }))
  const result = await f.bridge.generate('offline PNG fixture')
  assert.match(relative(f.home, result.path), /^deliveries[/\\]/); assert.notEqual(result.path, f.saved)
  assert.deepEqual(await readFile(result.path), png); assert.equal(result.imageModel, 'gpt-image-2'); assert.match(result.modelSelection, /非可选 image2.6/)
  assert.equal(f.rpc.listeners.size, 0); assert.equal(f.bridge.busy, false)
})
for (const status of ['failed', 'interrupted']) test(`${status} turn never delivers even after image`, async t => {
  let f; f = await fixture(t, { 'turn/start': async (p, o, rpc) => { await rpc.item(f.saved); await rpc.completed(status); return { turn: turn('inProgress') } } })
  await assert.rejects(f.bridge.generate('fixture'), /未正常结束/); assert.deepEqual(await delivered(f.home), [])
})
test('completed turn without image rejects; failed image ignored', async t => {
  for (const withFailedImage of [false, true]) {
    const f = await fixture(t, { 'turn/start': async (p, o, rpc) => { if (withFailedImage) await rpc.item(null, { status: 'failed' }); await rpc.completed(); return { turn: turn('inProgress') } } })
    await assert.rejects(f.bridge.generate('fixture'), /未返回成功图片/); assert.deepEqual(await delivered(f.home), [])
  }
})
test('path containment, relative path, missing file and non-PNG rejected', async t => {
  const f = await fixture(t)
  const outside = join(f.home, 'outside.png'); await writeFile(outside, png)
  const wrong = join(f.home, 'generated_images', 'wrong.png'); await writeFile(wrong, Buffer.alloc(16))
  for (const path of ['relative.png', outside, join(f.home, 'generated_images', 'missing.png'), wrong]) await assert.rejects(verifiedImage(path, f.home))
  assert.deepEqual(await delivered(f.home), [])
})
test('cancel after turn starts interrupts, closes RPC and produces no delivery', async t => {
  let ready; const started = new Promise(resolve => { ready = resolve })
  const f = await fixture(t, { 'turn/start': () => { ready(); return { turn: turn('inProgress') } } })
  const controller = new AbortController(); const pending = f.bridge.generate('fixture', { signal: controller.signal })
  await started; await new Promise(resolve => setImmediate(resolve)); controller.abort(new Error('fixture cancellation'))
  await assert.rejects(pending, /fixture cancellation/); assert.deepEqual(await delivered(f.home), [])
  assert.ok(f.rpc.log.includes('turn/interrupt')); assert.equal(f.rpc.closed, true); assert.equal(f.bridge.busy, false)
})
test('concurrent generate single flight and busy reset after request failure', async t => {
  let release; const gate = new Promise(resolve => { release = resolve })
  let ready; const entered = new Promise(resolve => { ready = resolve })
  const f = await fixture(t, { 'turn/start': async () => { ready(); await gate; throw new Error('fixture RPC failure') } })
  const first = f.bridge.generate('first'); const firstCheck = assert.rejects(first, /fixture RPC failure/)
  await entered; await assert.rejects(f.bridge.generate('second'), /已有生图请求/)
  release(); await firstCheck; assert.equal(f.bridge.busy, false); assert.equal(f.rpc.listeners.size, 0)
})
// Regression requirements from the read-only review, retained after implementation fixes.
test('REGRESSION: signature-only pseudo PNG must never be delivered', async t => {
  const f = await fixture(t); await writeFile(f.saved, png.subarray(0, 8))
  await assert.rejects(verifiedImage(f.saved, f.home), /PNG|图片/)
  assert.deepEqual(await delivered(f.home), [])
})
test('REGRESSION: multi-cursor cycle must stop before asking for a repeated page', async t => {
  let requests = 0
  const f = await fixture(t, { 'model/list': () => { if (++requests > 4) throw new Error('fixture pagination watchdog'); return { data: [], nextCursor: requests % 2 ? 'A' : 'B' } } })
  await assert.rejects(f.bridge.models(), /分页异常/)
  assert.ok(requests <= 3)
})
test('close during active turn settles finished immediately without delivery', async t => {
  let ready; const started = new Promise(resolve => { ready = resolve })
  const f = await fixture(t, { 'turn/start': () => { ready(); return { turn: turn('inProgress') } } })
  const pending = f.bridge.generate('fixture'); const rejection = assert.rejects(pending, /进程已退出/)
  await started; await new Promise(resolve => setImmediate(resolve)); f.bridge.close()
  await rejection; assert.equal(f.bridge.busy, false); assert.deepEqual(await delivered(f.home), [])
  assert.equal(f.rpc.listeners.size, 0); assert.equal(f.rpc.closeListeners.size, 0)
})
test('cancel while turn/start response is pending closes RPC without returning an image', async t => {
  let ready; const entered = new Promise(resolve => { ready = resolve })
  const f = await fixture(t, { 'turn/start': (p, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); ready()
  }) })
  const controller = new AbortController(); const pending = f.bridge.generate('fixture', { signal: controller.signal })
  const rejection = assert.rejects(pending, /fixture cancellation before response/)
  await entered; controller.abort(new Error('fixture cancellation before response')); await rejection
  assert.equal(f.rpc.closed, true); assert.equal(f.bridge.rpc, undefined); assert.equal(f.bridge.busy, false)
  assert.deepEqual(await delivered(f.home), []); assert.ok(!f.rpc.log.includes('turn/interrupt'))
})
test('invalid CRC, truncated PNG, and oversized IHDR never deliver', async t => {
  const f = await fixture(t)
  const badCRC = Buffer.from(png); badCRC[29] ^= 1
  const oversized = Buffer.from(png); oversized.writeUInt32BE(8193, 16)
  for (const bytes of [badCRC, png.subarray(0, 40), oversized]) {
    await writeFile(f.saved, bytes); await assert.rejects(verifiedImage(f.saved, f.home), /校验|尺寸|PNG|图片/)
  }
  assert.deepEqual(await delivered(f.home), [])
})
test('distinct unbounded model pages stop at 20, including text-only records', async t => {
  let requests = 0
  const f = await fixture(t, { 'model/list': () => ({ data: [model('text', ['text'])], nextCursor: String(++requests) }) })
  await assert.rejects(f.bridge.models(), /分页异常/); assert.equal(requests, 20)
})
