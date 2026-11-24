import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexRpc } from './codex-rpc.js';

function fixture() {
  const child = new EventEmitter();
  const writes = [];
  child.stdin = new Writable({ write(chunk, encoding, done) { writes.push(JSON.parse(chunk.toString())); done(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = 0;
  child.kill = () => { child.kills++; return true; };
  let invocation;
  const rpc = new CodexRpc({
    executable: 'C:/path with spaces/codex.exe', cwd: 'C:/work', env: { ONLY: 'fixture' },
    spawnImpl: (...args) => { invocation = args; return child; },
  });
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  return { rpc, child, writes, send, get invocation() { return invocation; } };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('spawn uses discrete arguments, pipes, no shell; lifecycle is single-use', async () => {
  const f = fixture();
  assert.equal(f.rpc.start(), f.rpc);
  assert.equal(f.rpc.start(), f.rpc);
  assert.deepEqual(f.invocation, ['C:/path with spaces/codex.exe', ['app-server', '--stdio'], {
    cwd: 'C:/work', env: { ONLY: 'fixture' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }]);
  f.rpc.notify('initialized', {});
  assert.deepEqual(f.writes, [{ method: 'initialized', params: {} }]);
  f.rpc.close();
  f.rpc.close();
  assert.equal(f.child.kills, 1);
  assert.throws(() => f.rpc.start(), { code: 'RPC_CLOSED' });
  assert.throws(() => f.rpc.notify('late'), { code: 'RPC_CLOSED' });
  await rejectsCode(f.rpc.request('late'), 'RPC_CLOSED');
});

test('out-of-order responses resolve matching monotonic request ids', async () => {
  const f = fixture(); f.rpc.start();
  const first = f.rpc.request('one', { a: 1 });
  const second = f.rpc.request('two', null);
  assert.deepEqual(f.writes, [{ id: 1, method: 'one', params: { a: 1 } }, { id: 2, method: 'two', params: null }]);
  f.send({ id: 2, result: 'second' });
  f.send({ id: 1, result: 'first' });
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  f.send({ id: 900, result: 'ignored late response' });
  f.rpc.close();
});

test('remote errors preserve message, code and data', async () => {
  const f = fixture(); f.rpc.start();
  const pending = f.rpc.request('fail');
  const checked = assert.rejects(pending, { message: 'Bad request', code: -32602, data: { field: 'x' } });
  f.send({ id: 1, error: { message: 'Bad request', code: -32602, data: { field: 'x' } } });
  await checked; f.rpc.close();
});

test('notifications isolate sync/async failures and disposer removes listeners', async () => {
  const f = fixture(); f.rpc.start();
  const observed = [];
  f.rpc.onNotification(() => { throw new Error('listener failure'); });
  f.rpc.onNotification(async () => { throw new Error('async listener failure'); });
  const dispose = f.rpc.onNotification((method, params) => observed.push([method, params]));
  f.send({ method: 'event', params: { n: 1 } });
  dispose(); dispose();
  f.send({ method: 'event', params: { n: 2 } });
  const request = f.rpc.request('still-alive'); f.send({ id: 1, result: true });
  assert.equal(await request, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, [['event', { n: 1 }]]);
  f.rpc.close();
});

test('all server requests get method-not-found without notification dispatch', () => {
  const f = fixture(); f.rpc.start();
  f.rpc.onNotification(() => assert.fail('server request treated as notification'));
  for (const method of ['exec', 'shell', 'item/commandExecution/requestApproval']) {
    f.send({ id: 'server-' + method, method, params: { command: 'do-not-execute' } });
  }
  assert.deepEqual(f.writes, ['exec', 'shell', 'item/commandExecution/requestApproval'].map(method => ({
    id: 'server-' + method, error: { code: -32601, message: 'Method not found' },
  })));
  f.rpc.close();
});

test('abort before sending and in-flight abort clean up; late results ignored', async () => {
  const f = fixture(); f.rpc.start();
  const before = new AbortController(); before.abort();
  await rejectsCode(f.rpc.request('pre-abort', {}, { signal: before.signal }), 'ABORT_ERR');
  assert.equal(f.writes.length, 0);
  const controller = new AbortController();
  const checked = rejectsCode(f.rpc.request('abort', {}, { signal: controller.signal }), 'ABORT_ERR');
  controller.abort(); await checked;
  f.send({ id: 1, result: 'late' });
  const next = f.rpc.request('next'); f.send({ id: 2, result: 'ok' });
  assert.equal(await next, 'ok'); f.rpc.close();
});

test('timeout clears pending without blocking subsequent responses', async () => {
  const f = fixture(); f.rpc.start();
  await rejectsCode(f.rpc.request('slow', {}, { timeoutMs: 5 }), 'RPC_TIMEOUT');
  f.send({ id: 1, result: 'too late' });
  const next = f.rpc.request('next'); f.send({ id: 2, result: 42 });
  assert.equal(await next, 42); f.rpc.close();
});

test('exit rejects every pending request and prevents reuse', async () => {
  const f = fixture(); f.rpc.start();
  const checks = [rejectsCode(f.rpc.request('a'), 'RPC_CHILD_EXIT'), rejectsCode(f.rpc.request('b'), 'RPC_CHILD_EXIT')];
  f.child.emit('exit', 3, null);
  await Promise.all(checks);
  assert.equal(f.child.kills, 0);
  await rejectsCode(f.rpc.request('c'), 'RPC_CLOSED');
});

test('child error and pipe error reject pending using sanitized diagnostics', async () => {
  for (const target of ['child', 'stdin', 'stdout', 'stderr']) {
    const f = fixture(); f.rpc.start();
    const checked = rejectsCode(f.rpc.request('pending'), target === 'child' ? 'RPC_CHILD_ERROR' : 'RPC_IO_ERROR');
    (target === 'child' ? f.child : f.child[target]).emit('error', new Error('SECRET_LOG_TOKEN'));
    await checked;
    assert.equal(JSON.stringify(f.rpc.diagnostics).includes('SECRET_LOG_TOKEN'), false);
    assert.equal(f.child.kills, 1);
  }
});

test('invalid JSON closes transport without echoing raw stdout', async () => {
  const f = fixture(); f.rpc.start();
  const checked = assert.rejects(f.rpc.request('pending'), error => error.code === 'RPC_INVALID_JSON' && !error.message.includes('SECRET'));
  f.child.stdout.write('SECRET invalid json\n');
  await checked;
  assert.equal(f.child.kills, 1);
});

test('oversized unterminated and terminated lines close at byte limit', async () => {
  for (const suffix of ['', '\n']) {
    const f = fixture(); f.rpc.start();
    const checked = rejectsCode(f.rpc.request('pending'), 'RPC_LINE_TOO_LARGE');
    f.child.stdout.write(Buffer.alloc(8 * 1024 * 1024, 32));
    assert.equal(f.child.kills, 0);
    f.child.stdout.write('x' + suffix);
    await checked;
    assert.equal(f.child.kills, 1);
  }
});

test('exactly 8 MiB JSON line is accepted; tiny chunks are reassembled', async () => {
  const f = fixture(); f.rpc.start();
  const pending = f.rpc.request('large');
  const overhead = Buffer.byteLength(JSON.stringify({ id: 1, result: '' }));
  const value = 'x'.repeat(8 * 1024 * 1024 - overhead);
  f.send({ id: 1, result: value });
  assert.equal((await pending).length, value.length);
  const tiny = f.rpc.request('tiny');
  for (const byte of Buffer.from(JSON.stringify({ id: 2, result: 'tiny' }) + '\n')) f.child.stdout.write(Buffer.from([byte]));
  assert.equal(await tiny, 'tiny'); f.rpc.close();
});

test('asynchronous stdin write error rejects all pending', async () => {
  const f = fixture(); f.rpc.start();
  let failWrite;
  f.child.stdin.write = (line, callback) => { failWrite = callback; return false; };
  const checked = rejectsCode(f.rpc.request('write-fail'), 'RPC_IO_ERROR');
  failWrite(new Error('SECRET_WRITE_TOKEN'));
  await checked;
  assert.equal(f.child.kills, 1);
});

test('split UTF-8, CRLF, blank lines and multiple frames in one chunk', async () => {
  const f = fixture(); f.rpc.start();
  const one = f.rpc.request('one'); const two = f.rpc.request('two');
  const frame = Buffer.from('\n' + JSON.stringify({ id: 1, result: '中文' }) + '\r\n' + JSON.stringify({ id: 2, result: null }) + '\n');
  const split = frame.indexOf(Buffer.from('中文')) + 1;
  f.child.stdout.write(frame.subarray(0, split));
  f.child.stdout.write(frame.subarray(split));
  assert.deepEqual(await Promise.all([one, two]), ['中文', null]); f.rpc.close();
});

test('close rejects pending immediately and removes abort listeners', async () => {
  const f = fixture(); f.rpc.start();
  const controller = new AbortController();
  let adds = 0; let removes = 0;
  const signal = { get aborted() { return controller.signal.aborted; },
    addEventListener(...args) { adds++; controller.signal.addEventListener(...args); },
    removeEventListener(...args) { removes++; controller.signal.removeEventListener(...args); } };
  const checks = [rejectsCode(f.rpc.request('a', {}, { signal }), 'RPC_CLOSED'), rejectsCode(f.rpc.request('b'), 'RPC_CLOSED')];
  f.rpc.close(); await Promise.all(checks);
  assert.equal(adds, 1); assert.equal(removes, 1);
  assert.equal(f.child.stdin.writableEnded, true);
  assert.equal(f.child.stdout.listenerCount('data'), 0);
  assert.equal(f.child.stderr.listenerCount('data'), 0);
});

test('stderr diagnostic collection is bounded metadata with no raw contents', () => {
  const f = fixture(); f.rpc.start();
  f.child.stderr.write('SECRET_LOG_TOKEN'.repeat(1000));
  assert.deepEqual(f.rpc.diagnostics, { stderrBytes: 4096, stderrTruncated: true });
  assert.equal(Object.isFrozen(f.rpc.diagnostics), true);
  f.rpc.close();
});

test('spawn throw is sanitized, closed and never retried', () => {
  let calls = 0;
  const rpc = new CodexRpc({ executable: 'fixture', spawnImpl() { calls++; throw new Error('SECRET'); } });
  assert.throws(() => rpc.start(), { message: 'Child process start failed', code: 'RPC_SPAWN_ERROR' });
  assert.throws(() => rpc.start(), { code: 'RPC_CLOSED' });
  assert.equal(calls, 1);
});

test('EOF, child close without exit, and malformed frames reject pending', async () => {
  for (const action of [f => f.child.stdout.end('partial'), f => f.child.emit('close'), f => f.send([]), f => f.send({ id: 1 })]) {
    const f = fixture(); f.rpc.start();
    const checked = assert.rejects(f.rpc.request('pending'));
    action(f); await checked;
    f.rpc.close();
  }
});

test('invalid method/timeout and serialization error do not strand pending', async () => {
  const f = fixture();
  await rejectsCode(f.rpc.request('before-start'), 'RPC_CLOSED');
  f.rpc.start();
  await assert.rejects(f.rpc.request(''), TypeError);
  await assert.rejects(f.rpc.request('bad', {}, { timeoutMs: -1 }), TypeError);
  const circular = {}; circular.self = circular;
  await assert.rejects(f.rpc.request('circular', circular), TypeError);
  assert.equal(f.writes.length, 0);
  f.rpc.close();
});

test('closed getter and onClose detect exit after all requests have resolved', async () => {
  const f = fixture();
  assert.equal(f.rpc.closed, false);
  const events = [];
  f.rpc.onClose(error => events.push({ error, closed: f.rpc.closed }));
  f.rpc.start();
  assert.equal(f.rpc.closed, false);
  const completed = f.rpc.request('turn/start'); f.send({ id: 1, result: { turn: 't1' } });
  await completed;
  f.child.emit('exit', 9, null);
  assert.equal(f.rpc.closed, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].error.code, 'RPC_CHILD_EXIT');
  assert.equal(events[0].closed, true);
  f.child.emit('close'); f.rpc.close();
  assert.equal(events.length, 1);
  let replay;
  const dispose = f.rpc.onClose(error => { replay = error; });
  assert.equal(replay, events[0].error);
  dispose(); dispose();
});

test('onClose disposer and sync/async listener failures are isolated', async () => {
  const f = fixture(); f.rpc.start();
  assert.throws(() => f.rpc.onClose(null), TypeError);
  let removedCalls = 0; let calls = 0;
  const dispose = f.rpc.onClose(() => removedCalls++);
  dispose(); dispose();
  f.rpc.onClose(() => { throw new Error('listener'); });
  f.rpc.onClose(async () => { throw new Error('async listener'); });
  f.rpc.onClose(error => { calls++; assert.equal(error.code, 'RPC_CLOSED'); });
  f.rpc.close();
  assert.equal(removedCalls, 0);
  assert.equal(calls, 1);
  assert.equal(f.child.kills, 1);
  assert.doesNotThrow(() => f.rpc.onClose(() => { throw new Error('late listener'); }));
  f.rpc.onClose(async () => { throw new Error('late async listener'); });
  await new Promise(resolve => setImmediate(resolve));
});

test('onClose emits first terminal error for spawn failure, protocol error, and close before start', () => {
  const failed = new CodexRpc({ executable: 'fixture', spawnImpl() { throw new Error('fixture failure'); } });
  let spawnError;
  failed.onClose(error => { spawnError = error; });
  assert.throws(() => failed.start(), { code: 'RPC_SPAWN_ERROR' });
  assert.equal(failed.closed, true);
  assert.equal(spawnError.code, 'RPC_SPAWN_ERROR');
  const f = fixture(); f.rpc.start();
  let protocolError;
  f.rpc.onClose(error => { protocolError = error; });
  f.child.stdout.write('not-json\n');
  assert.equal(protocolError.code, 'RPC_INVALID_JSON');
  f.child.emit('exit', 1, null);
  let replay;
  f.rpc.onClose(error => { replay = error; });
  assert.equal(replay, protocolError);
  const neverStarted = fixture();
  let closed;
  neverStarted.rpc.onClose(error => { closed = error; });
  neverStarted.rpc.close();
  assert.equal(neverStarted.rpc.closed, true);
  assert.equal(closed.code, 'RPC_CLOSED');
  assert.equal(neverStarted.child.kills, 0);
});
