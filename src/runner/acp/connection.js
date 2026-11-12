'use strict';

// ACP uses one JSON-RPC message per line. Keep complete bytes until a newline
// arrives so a split UTF-8 character cannot damage a prompt.
const { scrubObject } = require('../safety');
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function createConnection({ input, write, onClose = () => {} }) {
  const handlers = new Map();
  const pending = new Map();
  let buffer = Buffer.alloc(0),
    nextId = 1,
    closed = false;
  function send(message) {
    if (closed) return;
    try {
      // Local ACP session IDs are routing keys, not upstream account IDs.
      // Preserve only this envelope field; tool payloads remain fully scrubbed.
      const clean = scrubObject(message);
      for (const key of ['params', 'result']) {
        const id = message[key]?.sessionId;
        if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) clean[key].sessionId = id;
      }
      write(JSON.stringify(clean) + '\n');
    } catch {
      close();
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.finish(new Error('ACP connection closed'));
    pending.clear();
    onClose();
  }
  function error(id, err) {
    // Node filesystem codes are strings such as ENOENT; JSON-RPC requires a
    // number. Keep intentional numeric codes (including zero), otherwise use
    // the standard internal-error code and retain the redacted explanation.
    const code = Number.isSafeInteger(err?.code) ? err.code : -32603;
    const message = typeof err?.message === 'string' ? err.message : 'Internal error';
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }
  function dispatch(message) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') {
      error(null, new RpcError(-32600, 'Invalid JSON-RPC message'));
      return;
    }
    if (typeof message.method === 'string') {
      const handler = handlers.get(message.method);
      if (!handler) {
        if (message.id !== undefined) error(message.id, new RpcError(-32601, 'Method not found'));
        return;
      }
      // Do not await here: cancellation and approval replies must remain readable
      // while session/prompt is waiting for the model or the human.
      Promise.resolve()
        .then(() => handler(message.params || {}))
        .then((result) => {
          if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
        })
        .catch((err) => {
          if (message.id !== undefined) error(message.id, err);
        });
    } else if (pending.has(message.id)) {
      pending.get(message.id).finish(message.error ? new Error(message.error.message) : null, message.result);
    }
  }
  input.on('data', (chunk) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    // A broken peer must not grow this process without bound.
    if (buffer.length > 8 * 1024 * 1024) {
      error(null, new RpcError(-32600, 'ACP frame too large'));
      close();
      return;
    }
    let index;
    while ((index = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, index).toString('utf8').trim();
      buffer = buffer.subarray(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        error(null, new RpcError(-32700, 'Invalid JSON'));
        continue;
      }
      dispatch(message);
    }
  });
  input.on('end', close);
  input.on('error', close);
  input.on('close', close);
  return {
    onMethod: (method, handler) => handlers.set(method, handler),
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    request(method, params, { signal, timeoutMs = 120000 } = {}) {
      return new Promise((resolve, reject) => {
        if (closed || signal?.aborted) {
          reject(new Error('ACP request cancelled'));
          return;
        }
        const id = nextId++;
        let timer;
        const cancel = () => finish(new Error('ACP request cancelled or timed out'));
        function finish(err, value) {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          if (err) reject(err);
          else resolve(value);
        }
        pending.set(id, { finish });
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(cancel, timeoutMs);
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    close,
    get closed() {
      return closed;
    },
  };
}
module.exports = { createConnection, RpcError };
