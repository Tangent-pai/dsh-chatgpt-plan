import { spawn } from 'node:child_process';

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const STDERR_DIAGNOSTIC_LIMIT = 4096;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function failure(message, code, name = 'Error') {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}

/** Standalone, single-use Codex app-server JSONL transport; no handshake or tool execution. */
export class CodexRpc {
  #executable;
  #args;
  #cwd;
  #env;
  #spawn;
  #child;
  #state = 'new';
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closeListeners = new Set();
  #closeError;
  #buffer = Buffer.alloc(0);
  #lineBytes = 0;
  #stderrBytes = 0;
  #stderrTruncated = false;

  constructor({ executable, args = ['app-server', '--stdio'], cwd, env, spawnImpl = spawn }) {
    if (typeof executable !== 'string' || !executable) throw new TypeError('executable is required');
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new TypeError('args must be strings');
    if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
    this.#executable = executable;
    this.#args = [...args];
    this.#cwd = cwd;
    this.#env = env;
    this.#spawn = spawnImpl;
  }

  /** True after the first terminal event, including explicit close or spawn failure. */
  get closed() {
    return this.#state === 'closed';
  }

  /** Called synchronously once on termination; late subscriptions replay the first error. */
  onClose(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (this.closed) {
      this.#emitClose(listener, this.#closeError);
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  #emitClose(listener, error) {
    try { Promise.resolve(listener(error)).catch(() => {}); } catch { /* isolate listener */ }
  }

  /** Diagnostic metadata only: stderr contents are never retained or exposed. */
  get diagnostics() {
    return Object.freeze({ stderrBytes: this.#stderrBytes, stderrTruncated: this.#stderrTruncated });
  }

  /** Synchronously creates the child. Repeated start while running is a no-op. */
  start() {
    if (this.#state === 'running') return this;
    if (this.#state !== 'new') throw failure('Transport is closed', 'RPC_CLOSED');
    this.#state = 'running';
    try {
      const child = this.#spawn(this.#executable, this.#args, {
        cwd: this.#cwd, env: this.#env, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.#child = child;
      child.on('error', () => this.#stop(failure('Child process failed', 'RPC_CHILD_ERROR')));
      child.on('exit', (code, signal) => this.#stop(failure(
        `Child exited (code=${typeof code === 'number' ? code : 'null'}, signal=${signal ? 'set' : 'none'})`, 'RPC_CHILD_EXIT'), false));
      child.on('close', () => this.#stop(failure('Child process closed', 'RPC_CHILD_EXIT'), false));
      if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Missing pipes');
      child.stdin.on('error', () => this.#stop(failure('stdin failed', 'RPC_IO_ERROR')));
      child.stdout.on('error', () => this.#stop(failure('stdout failed', 'RPC_IO_ERROR')));
      child.stderr.on('error', () => this.#stop(failure('stderr failed', 'RPC_IO_ERROR')));
      child.stdout.on('data', this.#read);
      child.stdout.on('end', () => this.#stop(failure('stdout ended', 'RPC_EOF')));
      child.stderr.on('data', this.#readStderr);
    } catch {
      this.#stop(failure('Child process start failed', 'RPC_SPAWN_ERROR'));
      throw failure('Child process start failed', 'RPC_SPAWN_ERROR');
    }
    return this;
  }

  request(method, params, { signal, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.#state !== 'running') return reject(failure('Transport is not running', 'RPC_CLOSED'));
      if (typeof method !== 'string' || !method) return reject(new TypeError('method is required'));
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) return reject(new TypeError('Invalid timeoutMs'));
      if (signal?.aborted) return reject(failure('Request aborted', 'ABORT_ERR', 'AbortError'));
      if (!Number.isSafeInteger(this.#nextId)) return reject(failure('Request id exhausted', 'RPC_ID_EXHAUSTED'));
      const id = this.#nextId++;
      const onAbort = () => this.#settle(id, failure('Request aborted', 'ABORT_ERR', 'AbortError'));
      const timer = setTimeout(() => this.#settle(id, failure('Request timed out', 'RPC_TIMEOUT', 'TimeoutError')), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, signal, onAbort });
      try {
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        this.#write({ id, method, params });
      } catch (error) {
        this.#settle(id, error);
      }
    });
  }

  /** Writes one notification; throws on closed transport or serialization failure. */
  notify(method, params) {
    if (typeof method !== 'string' || !method) throw new TypeError('method is required');
    this.#write({ method, params });
  }

  /** Listener receives (method, params); synchronous and async failures are isolated. */
  onNotification(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (this.#state === 'closed') throw failure('Transport is closed', 'RPC_CLOSED');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Idempotent; rejects pending work immediately and ends/kills the owned child. */
  close() {
    this.#stop(failure('Transport closed', 'RPC_CLOSED'));
  }

  #write(message) {
    if (this.#state !== 'running') throw failure('Transport is not running', 'RPC_CLOSED');
    const line = JSON.stringify(message) + '\n';
    this.#child.stdin.write(line, error => {
      if (error) this.#stop(failure('stdin write failed', 'RPC_IO_ERROR'));
    });
  }

  #settle(id, error, result) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  #readStderr = chunk => {
    if (this.#state !== 'running') return;
    const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    this.#stderrTruncated ||= this.#stderrBytes + size > STDERR_DIAGNOSTIC_LIMIT;
    this.#stderrBytes = Math.min(STDERR_DIAGNOSTIC_LIMIT, this.#stderrBytes + size);
  };

  #read = chunk => {
    if (this.#state !== 'running') return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length && this.#state === 'running') {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const size = end - start;
      if (this.#lineBytes + size > MAX_LINE_BYTES) {
        this.#stop(failure('stdout line exceeds 8 MiB', 'RPC_LINE_TOO_LARGE'));
        return;
      }
      const required = this.#lineBytes + size;
      if (required > this.#buffer.length) {
        // Geometric growth bounds allocations even for one-byte stream chunks.
        const capacity = Math.min(MAX_LINE_BYTES, Math.max(required, this.#buffer.length * 2, 4096));
        const next = Buffer.allocUnsafe(capacity);
        this.#buffer.copy(next, 0, 0, this.#lineBytes);
        this.#buffer = next;
      }
      bytes.copy(this.#buffer, this.#lineBytes, start, end);
      this.#lineBytes = required;
      if (newline < 0) return;
      const line = this.#buffer.toString('utf8', 0, this.#lineBytes);
      this.#lineBytes = 0;
      if (line.trim()) this.#dispatch(line);
      start = newline + 1;
    }
  };

  #dispatch(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      this.#stop(failure('Invalid stdout JSON', 'RPC_INVALID_JSON'));
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#stop(failure('Invalid RPC frame', 'RPC_INVALID_FRAME'));
      return;
    }
    if (own(message, 'method')) {
      if (typeof message.method !== 'string') {
        this.#stop(failure('Invalid RPC method', 'RPC_INVALID_FRAME'));
      } else if (own(message, 'id')) {
        // Never interpret server calls as exec, shell, approvals, or other local actions.
        try { this.#write({ id: message.id, error: { code: -32601, message: 'Method not found' } }); }
        catch { this.#stop(failure('Server response write failed', 'RPC_IO_ERROR')); }
      } else {
        for (const listener of [...this.#listeners]) {
          try { Promise.resolve(listener(message.method, message.params)).catch(() => {}); } catch { /* isolate listener */ }
        }
      }
    } else if (own(message, 'id')) {
      if (own(message, 'error')) {
        const remote = message.error;
        const error = failure(typeof remote?.message === 'string' ? remote.message : 'Remote RPC error', remote?.code ?? 'RPC_REMOTE_ERROR');
        if (remote && own(remote, 'data')) error.data = remote.data;
        this.#settle(message.id, error);
      } else if (own(message, 'result')) {
        this.#settle(message.id, null, message.result);
      } else {
        this.#stop(failure('Invalid RPC response', 'RPC_INVALID_FRAME'));
      }
    } else {
      this.#stop(failure('Invalid RPC frame', 'RPC_INVALID_FRAME'));
    }
  }

  #stop(error, kill = true) {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#closeError = error;
    this.#buffer = Buffer.alloc(0);
    this.#lineBytes = 0;
    this.#listeners.clear();
    for (const id of this.#pending.keys()) this.#settle(id, error);
    const child = this.#child;
    child?.stdout?.off('data', this.#read);
    child?.stderr?.off('data', this.#readStderr);
    const closeListeners = [...this.#closeListeners];
    this.#closeListeners.clear();
    for (const listener of closeListeners) this.#emitClose(listener, error);
    if (kill && child) {
      try { child.stdin?.end(); } catch { /* best effort */ }
      try { child.kill(); } catch { /* best effort */ }
    }
  }
}
