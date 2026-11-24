import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'
import { AUTH_PATH, createAuthSettings, codexDevicePage } from './auth-settings.js'

const origin = 'http://localhost'
const official = 'https://auth.openai.com/codex/device'
function fixture(overrides = {}) {
  const lifetime = new AbortController()
  const deps = { lifetime: lifetime.signal, textStatus: async () => ({ configured:false }),
    loginText: async () => ({ command:{kind:'success'} }), loginCodex: async () => ({ verificationUrl:official, userCode:'ABCD-1234' }),
    cancelCodex: async () => {}, codexStatus: async () => ({ connected:false }), openDevicePage: async () => {}, invalidateUsage() {}, ...overrides }
  const auth = createAuthSettings(deps)
  const route = async (suffix = '', body = '{"confirm":true}', contentType = 'application/json') => {
    const path = `${AUTH_PATH}${suffix}`
    const h = auth.routes.find(route => route.path === path.split('?')[0])
    const options = h.methods[0] === 'POST' ? { method:'POST', headers:{'content-type':contentType}, body } : {}
    return h.fetch(new Request(origin + path, options))
  }
  const snapshot = async (...args) => (await route(...args)).json()
  return { route, snapshot, lifetime, auth }
}
const success = { command: { kind:'success' } }
const tick = () => pause(0)

test('exact JSON actions, no-store and no account fields', async t => {
  let starts = 0
  const f = fixture({ loginText:async () => { starts++; return success }, textStatus:async () => ({configured:true, token:'sensitive'}), codexStatus:async () => ({connected:true,email:'private'}) })
  t.after(() => f.lifetime.abort())
  for (const [path, body, type] of [['/text/start','{}'], ['/text/start','{"confirm":true,"url":"evil"}'], ['/text/start','{"confirm":true}','text/plain'], ['/text/start?q=1','{"confirm":true}']]) {
    assert.equal((await f.route(path,body,type)).status,400)
  }
  assert.equal(starts, 0)
  const status = await f.route()
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await status.json(),{text:{state:'connected'},codex:{state:'connected'}})
})

test('text action detaches, publishes actual saved state, and does not touch Codex', async t => {
  let resume, configured = false, codexStarted = 0
  const f = fixture({ loginText: () => new Promise(r => { resume = r }), textStatus:async () => ({ configured }), loginCodex: async () => { codexStarted++ } })
  t.after(() => f.lifetime.abort())
  assert.equal((await f.snapshot('/text/start')).text.state,'pending')
  assert.equal((await f.auth.startText()).kind,'error')
  configured = true; resume(success); await tick()
  assert.equal((await f.snapshot()).text.state,'connected')
  assert.equal(codexStarted,0)
})

test('text cancel and timeout release the job, cancel can withdraw shared flow', async t => {
  let cancelled = 0
  const f = fixture({ textTimeout:20, cancelText(){ cancelled++ }, loginText: signal => new Promise(r => signal.addEventListener('abort', () => r({cancelled:true, command:{kind:'error'}}), {once:true})) })
  t.after(() => f.lifetime.abort())
  await f.snapshot('/text/start')
  await f.snapshot('/text/cancel')
  await tick()
  assert.equal(cancelled,1)
  assert.equal((await f.snapshot()).text.state,'cancelled')
  await f.snapshot('/text/start')
  await pause(35)
  assert.equal((await f.snapshot()).text.state,'expired')
})

test('Codex code and official launch only during pending; old account is not new success', async t => {
  let completion, opened, unsubscribed = 0
  const f = fixture({ codexStatus:async () => ({connected:true}), loginCodex:async (_signal,complete) => { completion=complete; return {verificationUrl:official,userCode:'ABCD-1234',unsubscribe(){unsubscribed++}} }, openDevicePage:async url => {opened=url} })
  t.after(() => f.lifetime.abort())
  assert.equal((await f.snapshot('/codex/start')).codex.state,'checking')
  await tick()
  assert.equal(opened,official)
  assert.deepEqual((await f.snapshot()).codex,{state:'pending',verificationUrl:official,userCode:'ABCD-1234'})
  completion(true)
  assert.deepEqual((await f.snapshot()).codex,{state:'connected'})
  assert.equal(unsubscribed,1)
})

test('Codex slow start does not block text; cancel and retry clean up the code', async t => {
  let resolve, count=0, cancelled=0, opened=0
  const f = fixture({ loginCodex:() => { count++; return new Promise(r => {resolve=r}) }, cancelCodex:async () => {cancelled++}, openDevicePage:async () => {opened++} })
  t.after(() => f.lifetime.abort())
  assert.equal((await f.snapshot('/codex/start')).codex.state,'checking')
  assert.equal((await f.snapshot('/text/start')).text.state,'pending')
  await f.snapshot('/codex/start')
  assert.equal(count,1)
  resolve({verificationUrl:official,userCode:'CODE-1234'})
  await tick()
  assert.equal((await f.snapshot()).codex.state,'pending')
  await f.snapshot('/codex/cancel'); await tick()
  assert.deepEqual((await f.snapshot()).codex,{state:'cancelled'})
  assert.equal(cancelled,1)
  assert.equal(opened,1)
  await f.snapshot('/codex/start')
  resolve({verificationUrl:'https://chatgpt.com.evil.invalid/device',userCode:'CODE-1234'})
  await tick()
  assert.deepEqual((await f.snapshot()).codex,{state:'failed'})
  assert.equal(opened,1)
})

test('GET errors are status failures, and unsafe verification URLs never open', async t => {
  const f = fixture({ textStatus:async () => {throw Error()}, codexStatus:async () => {throw Error()} })
  t.after(() => f.lifetime.abort())
  assert.deepEqual(await f.snapshot(), {text:{state:'statusUnavailable'},codex:{state:'statusUnavailable'}})
  for (const url of ['http://chatgpt.com/codex/device','https://chatgpt.com:444/codex/device','https://user@chatgpt.com/codex/device','https://chatgpt.com.evil.invalid/']) assert.throws(() => codexDevicePage(url))
})
