'use strict';

// Exercise the actual HTTP client and tool loop against a tiny local model.
// No live credential, model spend, or user project edits are involved.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { run } = require('../../src/runner/run');
const transport = require('../../src/runner/codex-transport');
const modelClient = require('../../src/runner/model-client');

function textItem(text) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}
function callItem(id, name, input) {
  return { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) };
}
function sendResponse(res, output, { incomplete = false, outputTokens = 22, inputTokens = 100 } = {}) {
  const event = (value) => res.write('data: ' + JSON.stringify(value) + '\n\n');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  output.forEach((item, index) => event({ type: 'response.output_item.done', output_index: index, item }));
  event({
    type: incomplete ? 'response.incomplete' : 'response.completed',
    response: {
      id: 'resp_test',
      status: incomplete ? 'incomplete' : 'completed',
      output,
      incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  });
  res.end();
}

describe('Codex reopening: live-shaped loop contracts', () => {
  let cwd, server, url, requests, responder, savedToken, savedExit;
  beforeEach(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-reopening-'));
    savedToken = process.env.CODEX_ACCESS_TOKEN;
    savedExit = process.exitCode;
    process.env.CODEX_ACCESS_TOKEN = 'at-fixture-reopening-not-a-real-token';
    requests = [];
    responder = (_body, res) => sendResponse(res, [textItem('done')]);
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (part) => {
        body += part;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        responder(parsed, res);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/responses`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (savedToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
    else process.env.CODEX_ACCESS_TOKEN = savedToken;
    process.exitCode = savedExit;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  function options(extra = {}) {
    return {
      cwd,
      prompt: 'Test the tool loop.',
      bridgeUrl: url,
      bare: true,
      quiet: true,
      skipTrustGate: true,
      noArchive: true,
      autoMemory: false,
      outputFormat: 'silent',
      maxSteps: 3,
      allowedTools: ['list_files'],
      sessionPath: path.join(cwd, 'session.state.json'),
      ...extra,
    };
  }
  function checkpoint() {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'session.state.json'), 'utf8'));
  }

  it('uses current defaults and sends the remaining output allowance on each turn', async () => {
    responder = (_body, res) =>
      requests.length === 1
        ? sendResponse(res, [callItem('list1', 'list_files', { path: '.' })])
        : sendResponse(res, [textItem('done')]);
    const result = await run(options({ maxTokens: 48, budgetOutputTokens: 60, effort: 'max' }));
    assert.equal(result.stopReason, 'success');
    assert.deepEqual(
      requests.map((r) => r.max_output_tokens),
      [48, 38],
    );
    assert.equal(requests[0].model, 'gpt-6.1-sol');
    assert.equal(requests[0].reasoning.effort, 'max');
    assert.equal(
      requests[1].input.some((i) => i.type === 'function_call_output' && i.call_id === 'list1'),
      true,
    );
  });

  it('does not execute or save a tool call from an incomplete response', async () => {
    responder = (_body, res) =>
      sendResponse(res, [callItem('partial1', 'write_file', { path: 'must-not-exist.txt', content: 'oops' })], {
        incomplete: true,
      });
    const result = await run(options({ allowedTools: ['write_file'], acceptEdits: true }));
    assert.equal(result.stopReason, 'max_output_tokens');
    assert.equal(result.incompleteDetails.reason, 'max_output_tokens');
    assert.equal(result.usage.output_tokens, 22);
    assert.equal(fs.existsSync(path.join(cwd, 'must-not-exist.txt')), false);
    assert.equal(
      checkpoint().items.some((i) => i.type === 'function_call'),
      false,
    );
    assert.equal(requests.length, 1);
  });

  it('reports truncated text as partial, not successful, and accounts for it', async () => {
    responder = (_body, res) => sendResponse(res, [textItem('unfinished')], { incomplete: true });
    const result = await run(options());
    assert.equal(result.stopReason, 'max_output_tokens');
    assert.equal(result.finalText, 'unfinished');
    assert.ok(result.usageSummary.costUsd > 0);
    assert.ok(result.events.some((e) => e.type === 'assistant' && e.partial));
  });

  it('redacts observer events, isolates mutations, contains rejected callbacks, and emits no stdout', async () => {
    const secret = 'at-Fixture0Token1Value2With3Entropy4';
    responder = (_body, res) => sendResponse(res, [textItem('value ' + secret)]);
    const observed = [];
    const result = await run(
      options({
        onEvent(event) {
          observed.push(JSON.stringify(event));
          event.type = 'corrupted';
          return Promise.reject(new Error('broken UI'));
        },
      }),
    );
    assert.equal(result.stopReason, 'success');
    assert.equal(observed.join('').includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok(result.events.some((e) => e.type === 'run_end'));
    assert.equal(
      result.events.some((e) => e.type === 'corrupted'),
      false,
    );
  });

  it('keeps hosted silent-mode stdout empty in a separate process', async () => {
    // A subprocess isolates stdout from node:test's own progress messages.
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const script =
      'require("./src/runner/run").run(' +
      JSON.stringify(options()) +
      ').then(r => { if(r.stopReason !== "success") process.exitCode=1; });';
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], { cwd: process.cwd() });
    assert.equal(stdout, '');
  });

  it('routes approval metadata to the UI and honors an explicit allow', async () => {
    responder = (_body, res) =>
      requests.length === 1
        ? sendResponse(res, [callItem('write1', 'write_file', { path: 'approved.txt', content: 'approved' })])
        : sendResponse(res, [textItem('done')]);
    let approval;
    const result = await run(
      options({
        allowedTools: ['write_file'],
        confirm: {
          ask(action, _timeout, metadata) {
            approval = { action, metadata };
            return 'allow';
          },
        },
      }),
    );
    assert.equal(result.stopReason, 'success');
    assert.equal(approval.metadata.tool_use_id, 'write1');
    assert.equal(approval.metadata.name, 'write_file');
    assert.equal(fs.readFileSync(path.join(cwd, 'approved.txt'), 'utf8'), 'approved');
  });

  it('cancels a pending approval, ignores late allow, and preserves paired receipts', async () => {
    const controller = new AbortController();
    responder = (_body, res) =>
      sendResponse(res, [callItem('write1', 'write_file', { path: 'denied.txt', content: 'no' })]);
    let lateAllow;
    const result = await run(
      options({
        signal: controller.signal,
        allowedTools: ['write_file'],
        confirm: {
          ask() {
            setImmediate(() => controller.abort());
            return new Promise((resolve) => {
              lateAllow = resolve;
            });
          },
        },
      }),
    );
    lateAllow('allow');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(fs.existsSync(path.join(cwd, 'denied.txt')), false);
    assert.equal(requests.length, 1);
    assert.equal(process.exitCode, savedExit);
    const saved = checkpoint().items;
    assert.equal(saved.filter((i) => i.type === 'function_call').length, 1);
    assert.equal(saved.filter((i) => i.type === 'function_call_output').length, 1);
  });

  it('keeps the first completed write and prevents a second write after cancellation', async () => {
    const controller = new AbortController();
    responder = (_body, res) =>
      sendResponse(res, [
        callItem('a', 'write_file', { path: 'a.txt', content: 'a' }),
        callItem('b', 'write_file', { path: 'b.txt', content: 'b' }),
      ]);
    const result = await run(
      options({
        signal: controller.signal,
        allowedTools: ['write_file'],
        acceptEdits: true,
        onEvent(e) {
          if (e.type === 'tool_result' && e.tool_use_id === 'a') controller.abort();
        },
      }),
    );
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(fs.existsSync(path.join(cwd, 'a.txt')), true);
    assert.equal(fs.existsSync(path.join(cwd, 'b.txt')), false);
    assert.equal(checkpoint().items.filter((i) => i.type === 'function_call_output').length, 2);
  });

  it('aborts an active model stream and closes its connection', async () => {
    const controller = new AbortController();
    let close;
    const closed = new Promise((resolve) => {
      close = resolve;
    });
    responder = (_body, res) => {
      res.on('close', close);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"response.created"}\n\n');
      setImmediate(() => controller.abort());
    };
    const result = await run(options({ signal: controller.signal }));
    await closed;
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(process.exitCode, savedExit);
  });

  it('rejects a premature stream end instead of executing an apparent tool call', async () => {
    responder = (_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: ' +
          JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: callItem('bad', 'write_file', { path: 'bad.txt', content: 'bad' }),
          }) +
          '\n\n',
      );
    };
    const result = await run(options({ allowedTools: ['write_file'], acceptEdits: true }));
    assert.equal(result.stopReason, 'bridge_error');
    assert.equal(fs.existsSync(path.join(cwd, 'bad.txt')), false);
  });

  it('refuses a dollar budget for unknown pricing before any network request', async () => {
    const result = await run(options({ model: 'unknown-model', maxCostUsd: 1 }));
    assert.equal(result.stopReason, 'pricing_unknown');
    assert.equal(result.usageSummary.costUsd, null);
    assert.equal(requests.length, 0);
  });

  it('refuses a dollar budget for an inherited object name before networking', async () => {
    // This previously looked like a known model, producing NaN instead of a
    // usable price. No request may start when its dollar cost is unknown.
    const result = await run(options({ model: 'constructor', maxCostUsd: 1 }));
    assert.equal(result.stopReason, 'pricing_unknown');
    assert.equal(result.usageSummary.costUsd, null);
    assert.equal(requests.length, 0);
  });

  it('checks cost on a text-only turn and sums short-turn prices without a long-context surcharge', async () => {
    responder = (_body, res) =>
      requests.length === 1
        ? sendResponse(res, [callItem('list1', 'list_files', { path: '.' })], { inputTokens: 150000, outputTokens: 10 })
        : sendResponse(res, [textItem('done')], { inputTokens: 150000, outputTokens: 10 });
    const result = await run(options({ maxCostUsd: 0.5 }));
    assert.equal(result.stopReason, 'cost_budget_exceeded');
    assert.ok(Math.abs(result.usageSummary.costUsd - 0.6002) < 1e-10);
  });

  it('accepts xhigh, rejects invalid output limits, and never sends an already cancelled request', async () => {
    assert.equal(
      modelClient.createRequest({ model: 'gpt-6.1-sol', effort: 'xhigh', maxTokens: 16 }).reasoning.effort,
      'xhigh',
    );
    await assert.rejects(run(options({ maxTokens: 0 })), /positive safe integer/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(transport.requestBuffered({ model: 'gpt-6.1-sol' }, { url, signal: controller.signal }), {
      name: 'AbortError',
    });
    const result = await run(options({ signal: controller.signal }));
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(requests.length, 0);
  });
});

describe('Hosted approvals fail closed', () => {
  const { createApprovalPort } = require('../../src/runner/hosted-ports');
  it('denies UI errors and non-explicit answers', async () => {
    // A broken or ambiguous UI response must never become permission to write.
    for (const ask of [
      () => true,
      () => undefined,
      () => 'deny',
      () => {
        throw new Error('UI failed');
      },
      () => Promise.reject(new Error('UI disconnected')),
    ]) {
      assert.equal(await createApprovalPort(null, { ask }).ask('write', 100), 'deny');
    }
  });
  it('expires an unanswered request and ignores its later approval', async () => {
    let answer;
    const port = createApprovalPort(null, {
      ask: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const pending = port.ask('write', 10);
    assert.equal(await pending, 'deny');
    answer('allow');
    assert.equal(await pending, 'deny');
  });
});
