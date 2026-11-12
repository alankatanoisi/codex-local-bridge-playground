'use strict';

// Two pipes stand in for T3's stdin/stdout. Model requests still travel through
// the real HTTP transport, so these tests exercise more than a mocked adapter.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { PassThrough } = require('stream');
const { createAcpAgent } = require('../../src/runner/acp/agent');
const { createConnection } = require('../../src/runner/acp/connection');

function answer(res, output) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [index, item] of output.entries())
    res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: index, item }) + '\n\n');
  res.end(
    'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_test', status: 'completed', output, usage: { input_tokens: 100, output_tokens: 10 } },
      }) +
      '\n\n',
  );
}
const text = (value) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] });
const writeCall = () => ({
  type: 'function_call',
  call_id: 'write1',
  name: 'write_file',
  arguments: JSON.stringify({ path: 'note.txt', content: 'approved' }),
});

describe('Codex ACP integration', () => {
  let root, cwd, sessionDir, server, url, token, peers, requests, respond;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-'));
    cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd);
    sessionDir = path.join(root, 'sessions');
    peers = [];
    requests = [];
    token = process.env.CODEX_ACCESS_TOKEN;
    process.env.CODEX_ACCESS_TOKEN = 'at-offline-acp-fixture';
    respond = (_body, res) => answer(res, [text('hello')]);
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
      });
      req.on('end', () => {
        const body = JSON.parse(data);
        requests.push(body);
        respond(body, res);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = 'http://127.0.0.1:' + server.address().port + '/responses';
  });
  afterEach(async () => {
    for (const p of peers) {
      p.agent.connection.close();
      p.client.close();
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (token === undefined) delete process.env.CODEX_ACCESS_TOKEN;
    else process.env.CODEX_ACCESS_TOKEN = token;
    fs.rmSync(root, { recursive: true, force: true });
    process.exitCode = 0;
  });
  async function connect(runOverrides = {}) {
    const incoming = new PassThrough(),
      outgoing = new PassThrough();
    const updates = [];
    const agent = createAcpAgent({
      input: incoming,
      write: (line) => outgoing.write(line),
      sessionDir,
      runDefaults: { bridgeUrl: url, skipTrustGate: true, bare: true, maxSteps: 3, ...runOverrides },
    });
    const client = createConnection({ input: outgoing, write: (line) => incoming.write(line) });
    client.onMethod('session/update', (p) => updates.push(p.update));
    peers.push({ client, agent });
    await client.request('initialize', { protocolVersion: 1 });
    return { client, agent, updates };
  }
  const prompt = (client, sessionId, value = 'hello') =>
    client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: value }] });
  it('resumes native history on second turn and replays history into a fresh client', async () => {
    const a = await connect();
    const { sessionId } = await a.client.request('session/new', { cwd, mcpServers: [] });
    assert.equal((await prompt(a.client, sessionId, 'remember pear')).stopReason, 'end_turn');
    await prompt(a.client, sessionId, 'what fruit?');
    assert.ok(JSON.stringify(requests[1].input).includes('remember pear'));
    a.agent.connection.close();
    a.client.close();
    const b = await connect();
    await b.client.request('session/load', { sessionId, cwd, mcpServers: [] });
    assert.ok(b.updates.some((e) => e.sessionUpdate === 'user_message_chunk' && e.content.text === 'remember pear'));
    assert.ok(b.updates.some((e) => e.sessionUpdate === 'agent_message_chunk' && e.content.text === 'hello'));
    await prompt(b.client, sessionId, 'continue');
    assert.ok(JSON.stringify(requests[2].input).includes('what fruit?'));
  });
  it('routes write approval to the client and executes only an explicit allow', async () => {
    const a = await connect();
    const { sessionId } = await a.client.request('session/new', { cwd });
    respond = (_body, res) => answer(res, requests.length === 1 ? [writeCall()] : [text('done')]);
    let approval;
    a.client.onMethod('session/request_permission', (p) => {
      approval = p;
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
    });
    assert.equal((await prompt(a.client, sessionId)).stopReason, 'end_turn');
    assert.equal(approval.toolCall.toolCallId, 'write1');
    assert.equal(fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8'), 'approved');
    assert.ok(a.updates.some((e) => e.sessionUpdate === 'tool_call_update' && e.status === 'completed'));
  });
  it('cancels pending approval and rejects overlapping prompts', async () => {
    const a = await connect();
    const { sessionId } = await a.client.request('session/new', { cwd });
    respond = (_body, res) => answer(res, [writeCall()]);
    let seen;
    const awaiting = new Promise((resolve) => {
      seen = resolve;
    });
    a.client.onMethod('session/request_permission', () => {
      seen();
      return new Promise(() => {});
    });
    const running = prompt(a.client, sessionId);
    await awaiting;
    await assert.rejects(prompt(a.client, sessionId), /already running/);
    const other = await connect();
    await assert.rejects(other.client.request('session/load', { sessionId, cwd }), /in use by another/);
    a.client.notify('session/cancel', { sessionId });
    assert.equal((await running).stopReason, 'cancelled');
    assert.equal(fs.existsSync(path.join(cwd, 'note.txt')), false);
  });
  it('enforces session paths, workspace binding, and text-only capability', async () => {
    const a = await connect();
    const { sessionId } = await a.client.request('session/new', { cwd });
    await assert.rejects(a.client.request('session/load', { sessionId: '../../other', cwd }), /Invalid sessionId/);
    await assert.rejects(a.client.request('session/load', { sessionId, cwd: root }), /different workspace/);
    await assert.rejects(
      a.client.request('session/new', { cwd, mcpServers: [{ command: 'anything' }] }),
      /not supported/,
    );
    await assert.rejects(
      a.client.request('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'no' }] }),
      /text prompts/,
    );
    assert.equal(requests.length, 0);
  });
  it('explicitly ignores client MCP servers without adding their tools to model requests', async () => {
    const a = await connect({ ignoreClientMcp: true });
    const { sessionId } = await a.client.request('session/new', {
      cwd,
      mcpServers: [{ name: 'client-only', command: '/does/not/exist', args: [] }],
    });
    assert.equal((await prompt(a.client, sessionId)).stopReason, 'end_turn');
    assert.equal(requests.length, 1);
    assert.ok(!requests[0].tools.some((tool) => tool.name.includes('client-only')));
    const b = await connect({ ignoreClientMcp: true });
    await b.client.request('session/load', {
      sessionId,
      cwd,
      mcpServers: [{ name: 'client-only', type: 'http', url: 'http://127.0.0.1:1' }],
    });
  });
  it('keeps plan mode non-writing and permits explicit code mode without an approval card', async () => {
    const a = await connect();
    let asked = false;
    a.client.onMethod('session/request_permission', () => {
      asked = true;
      return { outcome: { outcome: 'cancelled' } };
    });
    respond = (_body, res) => answer(res, requests.length % 2 === 1 ? [writeCall()] : [text('done')]);
    const first = await a.client.request('session/new', { cwd });
    await a.client.request('session/set_mode', { sessionId: first.sessionId, modeId: 'plan' });
    await prompt(a.client, first.sessionId);
    assert.equal(fs.existsSync(path.join(cwd, 'note.txt')), false);
    const second = await a.client.request('session/new', { cwd });
    await a.client.request('session/set_mode', { sessionId: second.sessionId, modeId: 'code' });
    await prompt(a.client, second.sessionId);
    assert.equal(fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8'), 'approved');
    assert.equal(asked, false);
  });
  it('does not let code mode override credential-file protection', async () => {
    const a = await connect();
    const { sessionId } = await a.client.request('session/new', { cwd });
    await a.client.request('session/set_mode', { sessionId, modeId: 'code' });
    const call = writeCall();
    call.arguments = JSON.stringify({ path: '.env', content: 'no' });
    respond = (_body, res) => answer(res, requests.length === 1 ? [call] : [text('denied')]);
    await prompt(a.client, sessionId);
    assert.equal(fs.existsSync(path.join(cwd, '.env')), false);
    assert.ok(a.updates.some((e) => e.sessionUpdate === 'tool_call_update' && e.status === 'failed'));
  });
  it('runs the complete ACP loop through the standalone host', async () => {
    const { createHost } = require('../../src/hosting/server');
    const localToken = 'sk-local-' + 'b'.repeat(64);
    const host = createHost({
      callerToken: localToken,
      env: { CODEX_ACCESS_TOKEN: 'at-host-fixture' },
      upstreamUrl: url,
    });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    try {
      const a = await connect({
        bridgeUrl: undefined,
        transportEnv: {
          CODEX_BRIDGE_URL: 'http://127.0.0.1:' + host.address().port + '/v1/responses',
          CODEX_BRIDGE_CALLER_TOKEN: localToken,
        },
      });
      const { sessionId } = await a.client.request('session/new', { cwd });
      assert.equal((await prompt(a.client, sessionId)).stopReason, 'end_turn');
      assert.equal(requests.length, 1);
    } finally {
      host.closeAllConnections();
      await new Promise((resolve) => host.close(resolve));
    }
  });
  it('supports T3 model discovery and mode/configuration methods without enabling shell', async () => {
    const a = await connect();
    const { sessionId } = await a.client.request('session/new', { cwd });
    const models = await a.client.request('cursor/list_available_models', {});
    assert.equal(models.models[0].value, 'gpt-6.1-sol');
    await a.client.request('session/mode/set', { sessionId, modeId: 'plan' });
    await a.client.request('session/set_config_option', { sessionId, configId: 'effort', value: 'xhigh' });
    await prompt(a.client, sessionId);
    assert.equal(requests[0].reasoning.effort, 'xhigh');
    assert.equal(
      requests[0].tools.some((t) => t.name === 'bash'),
      false,
    );
    assert.ok(a.updates.some((e) => e.sessionUpdate === 'current_mode_update' && e.currentModeId === 'plan'));
  });
});

describe('ACP process and transport', () => {
  it('keeps stdout as JSON frames when launched as a real child process', async () => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [path.resolve('bin/local-bridge-acp.js'), 'acp'], {
      env: { ...process.env, CODEX_ACCESS_TOKEN: '' },
    });
    let output = '',
      errors = '';
    child.stdout.on('data', (c) => {
      output += c;
    });
    child.stderr.on('data', (c) => {
      errors += c;
    });
    const exited = new Promise((resolve) => child.on('close', resolve));
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('ACP handshake timed out'));
      }, 5000);
      child.stdout.on('data', () => {
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        resolve();
      });
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n',
    );
    await reply;
    child.stdin.end();
    await exited;
    const frames = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].id, 1);
    assert.equal(frames[0].result.protocolVersion, 1);
    assert.equal(errors, '');
  });
  it('handles fragmented UTF-8 and malformed JSON without losing the next request', async () => {
    const input = new PassThrough();
    const output = [];
    const connection = createConnection({ input, write: (line) => output.push(JSON.parse(line)) });
    connection.onMethod('echo', (p) => p);
    input.write('not-json\n');
    const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: { text: '梨' } }) + '\n');
    for (const byte of frame) input.write(Buffer.from([byte]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(output[0].error.code, -32700);
    assert.equal(output[1].result.text, '梨');
    connection.close();
  });
});
