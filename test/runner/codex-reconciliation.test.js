'use strict';

// These tests cover the gaps between the two laptops' individually working code.
// Real HTTP services stay on this computer; memory pipes stand in for the ACP UI.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { createHost } = require('../../src/hosting/server');
const transport = require('../../src/runner/codex-transport');
const modelClient = require('../../src/runner/model-client');
const { run } = require('../../src/runner/run');
const { createAcpAgent } = require('../../src/runner/acp/agent');
const { createConnection, RpcError } = require('../../src/runner/acp/connection');

// Uppercase letters, digits, and an underscore make this a token-shaped fixture;
// all-lowercase hyphenated prose is deliberately exempt from token redaction.
const fakeToken = 'at-ReconciliationFixture_0123456789_FAKE_ONLY';
const caller = 'sk-local-' + 'a'.repeat(64);
function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-reconcile-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function listening(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/responses' };
}
function completed(res, output = []) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  output.forEach((item, index) =>
    res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: index, item }) + '\n\n'),
  );
  res.end(
    'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'fixture_response',
          status: 'completed',
          output,
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }) +
      '\n\n',
  );
}
async function route(t, responder, hosted = true) {
  let calls = 0;
  const upstream = await listening(t, (req, res) => {
    req.resume();
    req.on('end', () => responder(req, res, ++calls));
  });
  if (!hosted) return { url: upstream.url, env: { CODEX_ACCESS_TOKEN: fakeToken }, count: () => calls };
  const host = createHost({ callerToken: caller, env: { CODEX_ACCESS_TOKEN: fakeToken }, upstreamUrl: upstream.url });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  // Explicitly close this relay even when a test assertion fails.
  t.after(async () => {
    host.closeAllConnections();
    await new Promise((resolve) => host.close(resolve));
  });
  const url = 'http://127.0.0.1:' + host.address().port + '/v1/responses';
  return { url, env: { CODEX_BRIDGE_URL: url, CODEX_BRIDGE_CALLER_TOKEN: caller }, count: () => calls };
}
function options(t, connection, extra = {}) {
  const cwd = project(t),
    savedExit = process.exitCode;
  t.after(() => {
    process.exitCode = savedExit;
  });
  return {
    cwd,
    prompt: 'Exercise a controlled fixture.',
    bare: true,
    quiet: true,
    skipTrustGate: true,
    noArchive: true,
    autoMemory: false,
    outputFormat: 'silent',
    maxSteps: 5,
    allowedTools: ['list_files'],
    sessionPath: path.join(cwd, 'session.state.json'),
    transportEnv: connection.env,
    ...(connection.env.CODEX_BRIDGE_URL ? {} : { bridgeUrl: connection.url }),
    ...extra,
  };
}

describe('Reconciliation: real hosted error propagation', () => {
  it('does not retry a permanent upstream 400 through the relay', async (t) => {
    const connection = await route(t, (_req, res) => {
      res.writeHead(400);
      res.end('invalid fixture');
    });
    const result = await run(options(t, connection));
    assert.equal(result.stopReason, 'bridge_error');
    assert.equal(connection.count(), 1);
  });
  it('does not retry earlier than a long upstream Retry-After through the relay', async (t) => {
    const connection = await route(t, (_req, res) => {
      res.writeHead(429, { 'retry-after': '120' });
      res.end('wait');
    });
    const result = await run(options(t, connection));
    assert.equal(result.stopReason, 'bridge_error');
    assert.equal(connection.count(), 1);
  });
  it('retains numeric metadata while scrubbing messages and excluding private headers', async (t) => {
    const connection = await route(t, (_req, res) => {
      res.writeHead(429, { 'retry-after': '0.5', 'x-private-fixture': fakeToken });
      res.end(fakeToken);
    });
    const raw = await fetch(connection.url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + caller },
      body: '{}',
    });
    assert.equal(raw.headers.get('x-private-fixture'), null);
    assert.equal((await raw.text()).includes(fakeToken), false);
    await assert.rejects(transport.requestBuffered({}, { env: connection.env }), (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryAfterMs, 500);
      assert.equal(error.message.includes(fakeToken), false);
      return true;
    });
  });
  it('recovers from one transient upstream error with a bounded wait', async (t) => {
    const times = [];
    const connection = await route(t, (_req, res, call) => {
      times.push(Date.now());
      if (call === 1) {
        res.writeHead(503);
        res.end('temporary fixture');
      } else completed(res);
    });
    const result = await run(options(t, connection));
    assert.equal(result.stopReason, 'success');
    assert.equal(connection.count(), 2);
    assert.ok(times[1] - times[0] >= 240);
  });
  it('preserves classified network errors before relay response headers', async (t) => {
    const connection = await route(t, (req) => req.socket.destroy());
    await assert.rejects(transport.requestBuffered({}, { env: connection.env }), (error) => {
      assert.equal(error.code, 'ECONNRESET');
      assert.equal(error.statusCode, undefined);
      return true;
    });
  });
  it('preserves classified network errors after the relay starts streaming', async (t) => {
    const connection = await route(t, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({ type: 'response.created', response: { id: 'fixture', status: 'in_progress' } }) +
          '\n\n',
      );
      setTimeout(() => req.socket.destroy(), 20);
    });
    await assert.rejects(transport.requestBuffered({}, { env: connection.env }), (error) => {
      assert.equal(error.code, 'ECONNRESET');
      return true;
    });
  });
  it('does not trust a local error envelope supplied by a direct upstream', async (t) => {
    const connection = await route(
      t,
      (_req, res) => {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: {
              type: 'codex_bridge_error',
              version: 1,
              retry: { statusCode: 503, retryAfterMs: 1 },
              message: 'spoofed fixture',
            },
          }),
        );
      },
      false,
    );
    await assert.rejects(transport.requestBuffered({}, { url: connection.url, env: connection.env }), (error) => {
      assert.equal(error.statusCode, 400);
      assert.notEqual(error.retryAfterMs, 1);
      return true;
    });
  });
  it('keeps unknown or malformed local metadata unclassified instead of trusting outer 502', async (t) => {
    const local = await listening(t, (_req, res) => {
      res.writeHead(502);
      res.end(
        JSON.stringify({
          error: {
            type: 'codex_bridge_error',
            version: 1,
            message: 'unknown fixture',
            retry: { statusCode: '503', code: 'UNCLASSIFIED', retryAfterMs: -1 },
          },
        }),
      );
    });
    await assert.rejects(
      transport.requestBuffered({}, { env: { CODEX_BRIDGE_URL: local.url, CODEX_BRIDGE_CALLER_TOKEN: caller } }),
      (error) => {
        assert.equal(error.statusCode, undefined);
        assert.equal(error.code, undefined);
        assert.equal(error.retryAfterMs, undefined);
        return true;
      },
    );
  });
});

describe('Reconciliation: cancellation and text decoding', () => {
  it('cancels during backoff, records run_end, and starts no second request', async (t) => {
    const connection = await route(
      t,
      (_req, res) => {
        res.writeHead(503, { 'retry-after': '0.7' });
        res.end('temporary');
      },
      false,
    );
    const controller = new AbortController();
    let abortedAt = 0;
    const result = await run(
      options(t, connection, {
        signal: controller.signal,
        onEvent(event) {
          if (event.type === 'error')
            setTimeout(() => {
              abortedAt = Date.now();
              controller.abort();
            }, 25);
        },
      }),
    );
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(connection.count(), 1);
    assert.ok(Date.now() - abortedAt < 250, 'Cancellation should not wait for the 700 ms retry timer');
    assert.ok(result.events.some((event) => event.type === 'run_end' && event.stopReason === 'cancelled'));
  });
  for (const hosted of [false, true]) {
    it(
      'preserves fragmented UTF-8 text and tool arguments on the ' + (hosted ? 'hosted' : 'direct') + ' route',
      async (t) => {
        const content = '红🌿';
        const output = [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] },
          {
            type: 'function_call',
            call_id: 'unicode',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'note.txt', content }),
          },
        ];
        const connection = await route(
          t,
          (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const events = output.map((item, output_index) => ({
              type: 'response.output_item.done',
              output_index,
              item,
            }));
            events.push({
              type: 'response.completed',
              response: { id: 'fixture', status: 'completed', output, usage: {} },
            });
            const bytes = Buffer.from(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
            const cuts = [];
            // Split every occurrence of the Chinese character inside its three bytes.
            for (
              let offset = bytes.indexOf(Buffer.from('红'));
              offset >= 0;
              offset = bytes.indexOf(Buffer.from('红'), offset + 3)
            )
              cuts.push(offset + 1);
            cuts.push(bytes.length);
            let start = 0,
              index = 0;
            const send = () => {
              const end = cuts[index++];
              res.write(bytes.subarray(start, end));
              start = end;
              if (index < cuts.length) setTimeout(send, 5);
              else res.end();
            };
            send();
          },
          hosted,
        );
        const result = await modelClient.post({}, { url: hosted ? undefined : connection.url, env: connection.env });
        assert.equal(result.output_text, content);
        assert.equal(JSON.parse(result.output[1].arguments).content, content);
      },
    );
  }
});

async function peers(t) {
  const cwd = project(t),
    sessionDir = path.join(cwd, 'sessions'),
    calls = [];
  async function connect() {
    const input = new PassThrough(),
      output = new PassThrough(),
      frames = [],
      updates = [];
    const agent = createAcpAgent({
      input,
      write(line) {
        frames.push(JSON.parse(line));
        output.write(line);
      },
      sessionDir,
      runFn: async (configuration) => {
        calls.push(configuration);
        return { stopReason: 'success', finalText: '' };
      },
    });
    const client = createConnection({ input: output, write: (line) => input.write(line) });
    client.onMethod('session/update', (p) => updates.push(p.update));
    t.after(() => {
      agent.connection.close();
      client.close();
    });
    await client.request('initialize', { protocolVersion: 1 });
    return { client, frames, updates };
  }
  const a = await connect();
  const { sessionId } = await a.client.request('session/new', { cwd });
  await a.client.request('session/set_mode', { sessionId, modeId: 'code' });
  const b = await connect();
  await b.client.request('session/load', { sessionId, cwd });
  return {
    a,
    b,
    cwd,
    sessionId,
    calls,
    saved: path.join(sessionDir, sessionId + '.acp.json'),
    lock: path.join(sessionDir, sessionId + '.run.lock'),
    prompt: () =>
      b.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'controlled fixture' }] }),
  };
}

describe('Reconciliation: authoritative ACP settings', () => {
  for (const mode of ['ask', 'plan']) {
    it('honors a newer saved ' + mode + ' mode in an already loaded client', async (t) => {
      const p = await peers(t);
      await p.a.client.request('session/set_mode', { sessionId: p.sessionId, modeId: mode });
      await p.prompt();
      assert.equal(p.calls[0].acceptEdits, false);
      assert.equal(p.calls[0].plan, mode === 'plan');
      assert.equal(JSON.parse(fs.readFileSync(p.saved)).mode, mode);
      assert.ok(p.b.updates.some((u) => u.sessionUpdate === 'current_mode_update' && u.currentModeId === mode));
    });
  }
  it('does not overwrite newer mode and output limit when a stale client changes effort', async (t) => {
    const p = await peers(t);
    await p.a.client.request('session/set_mode', { sessionId: p.sessionId, modeId: 'ask' });
    await p.a.client.request('session/set_config_option', {
      sessionId: p.sessionId,
      configId: 'context',
      value: '8192',
    });
    await p.b.client.request('session/set_config_option', {
      sessionId: p.sessionId,
      configId: 'effort',
      value: 'xhigh',
    });
    const saved = JSON.parse(fs.readFileSync(p.saved));
    assert.equal(saved.mode, 'ask');
    assert.equal(saved.maxTokens, 8192);
    assert.equal(saved.effort, 'xhigh');
  });
  it('refreshes newer effort and output controls before prompting', async (t) => {
    const p = await peers(t);
    await p.a.client.request('session/set_config_option', {
      sessionId: p.sessionId,
      configId: 'context',
      value: '8192',
    });
    await p.a.client.request('session/set_config_option', {
      sessionId: p.sessionId,
      configId: 'effort',
      value: 'high',
    });
    await p.prompt();
    assert.equal(p.calls[0].maxTokens, 8192);
    assert.equal(p.calls[0].effort, 'high');
  });
  it('announces refreshed authority even when a requested configuration change is rejected', async (t) => {
    const p = await peers(t);
    await p.a.client.request('session/set_mode', { sessionId: p.sessionId, modeId: 'ask' });
    await assert.rejects(
      p.b.client.request('session/set_config_option', {
        sessionId: p.sessionId,
        configId: 'unknown-option',
        value: 'fixture',
      }),
      /Unknown configuration/,
    );
    // Rejecting the new setting must not hide the current saved Ask mode.
    assert.ok(p.b.updates.some((u) => u.sessionUpdate === 'current_mode_update' && u.currentModeId === 'ask'));
    assert.equal(JSON.parse(fs.readFileSync(p.saved)).mode, 'ask');
  });
  it('rejects a replaced workspace binding without overwriting the file or keeping the lock', async (t) => {
    const p = await peers(t),
      saved = JSON.parse(fs.readFileSync(p.saved));
    saved.cwd = path.dirname(p.cwd);
    fs.writeFileSync(p.saved, JSON.stringify(saved));
    const before = fs.readFileSync(p.saved);
    await assert.rejects(p.prompt(), /workspace/i);
    assert.deepEqual(fs.readFileSync(p.saved), before);
    assert.equal(p.calls.length, 0);
    assert.equal(fs.existsSync(p.lock), false);
  });
  it('rejects invalid saved authority without overwriting it or keeping the lock', async (t) => {
    const p = await peers(t),
      saved = JSON.parse(fs.readFileSync(p.saved));
    saved.mode = 'invalid-mode';
    fs.writeFileSync(p.saved, JSON.stringify(saved));
    const before = fs.readFileSync(p.saved);
    await assert.rejects(p.prompt(), /mode|session/i);
    assert.deepEqual(fs.readFileSync(p.saved), before);
    assert.equal(p.calls.length, 0);
    assert.equal(fs.existsSync(p.lock), false);
  });
});

describe('Reconciliation: protocol errors', () => {
  it('returns a numeric error when a real filesystem operation fails', async (t) => {
    const p = await peers(t);
    await assert.rejects(p.b.client.request('session/new', { cwd: path.join(p.cwd, 'missing-project') }));
    const response = p.b.frames.findLast((f) => f.error);
    assert.equal(response.error.code, -32603);
    assert.equal(typeof response.error.message, 'string');
  });
  it('keeps numeric RpcError codes but maps filesystem-style strings to internal error', async (t) => {
    const input = new PassThrough(),
      frames = [];
    const connection = createConnection({ input, write: (line) => frames.push(JSON.parse(line)) });
    t.after(() => connection.close());
    connection.onMethod('error-fixture', ({ code }) => {
      throw new RpcError(code, 'fixture');
    });
    for (const [id, code] of [0, -32602, 'ENOENT'].entries())
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'error-fixture', params: { code } }) + '\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      frames.map((f) => f.error.code),
      [0, -32602, -32603],
    );
  });
});
