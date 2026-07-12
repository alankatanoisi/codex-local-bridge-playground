'use strict';

/**
 * codex-offline-e2e.test.js — Phase 3 Stage 6: offline end-to-end agent loop.
 *
 * Full circuit with zero live credentials:
 *
 *   run() → codex-transport HTTP → mock SSE server replaying REAL captured
 *   fixtures → native function_call → REAL list_files tool on a temp
 *   workspace → function_call_output on the wire → final answer.
 *
 * The mock server replays the redacted Phase 3 Stage 1 live captures, so the
 * grammar the loop consumes here is byte-identical to what the ChatGPT
 * backend Codex endpoint actually emits. The captured request bodies are also
 * used as a wire-level fence: no Anthropic shapes may leave the runner.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../../src/runner/run');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'codex');
// Fixture token: fake, never a live credential. Shape matters (at-…) so the
// transport's env-var lookup and redaction paths see a realistic value.
const FIXTURE_TOKEN = 'at-offline-e2e-fixture-token-not-real';
// call_id captured live in responses-stream-function-call.sse.
const CAPTURED_CALL_ID = 'call_HCylw4uI1hXvaVo8tGWQLQs3';

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

describe('offline e2e: runner → mock SSE → real tool → final answer', () => {
  let server;
  let baseUrl;
  /** Parsed JSON request bodies, in arrival order. */
  const requests = [];
  /** Raw header maps, in arrival order. */
  const headers = [];
  let cwd;
  let savedToken;
  let result;

  before(async () => {
    // Turn 1 answers with the captured function_call stream; turn 2 with the
    // captured final-answer stream. Chunked writes exercise SSE buffering.
    const script = ['responses-stream-function-call.sse', 'responses-stream-final-answer.sse'];
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        headers.push({ ...req.headers, _url: req.url });
        const payload = readFixture(script[Math.min(requests.length - 1, script.length - 1)]);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const step = 97;
        const tick = () => {
          if (i >= payload.length) {
            res.end();
            return;
          }
          res.write(payload.slice(i, i + step));
          i += step;
          setImmediate(tick);
        };
        tick();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = 'http://127.0.0.1:' + server.address().port + '/backend-api/codex/responses';

    // Real workspace matching the live capture's directory listing, so the
    // replayed final answer stays coherent with what the real tool returns.
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e2e-'));
    fs.writeFileSync(path.join(cwd, 'README.md'), '# fixture project\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"fixture-project"}\n', 'utf8');
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.mkdirSync(path.join(cwd, 'test'));

    savedToken = process.env.CODEX_ACCESS_TOKEN;
    process.env.CODEX_ACCESS_TOKEN = FIXTURE_TOKEN;

    // Run the REAL loop once; individual `it` blocks assert on the shared result.
    const originalWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
      result = await run({
        prompt: 'What files are in this project?',
        cwd,
        model: 'gpt-5.5',
        maxSteps: 3,
        bare: true,
        quiet: true,
        skipTrustGate: true,
        noArchive: true,
        noSessionPersistence: true,
        outputFormat: 'text',
        allowedTools: ['list_files'],
        // bridgeUrl doubles as the transport URL override for offline tests.
        bridgeUrl: baseUrl,
      });
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  after(() => {
    server.close();
    if (savedToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
    else process.env.CODEX_ACCESS_TOKEN = savedToken;
  });

  it('completes the loop: function_call turn + final answer turn', () => {
    assert.equal(result.stopReason, 'success');
    assert.equal(result.steps, 2);
    assert.equal(requests.length, 2, 'exactly two model requests hit the wire');
    assert.match(result.finalText, /README\.md/);
    assert.match(result.finalText, /package\.json/);
  });

  it('executed the real list_files tool against the temp workspace', () => {
    const toolResults = (result.events || []).filter((event) => event.type === 'tool_result');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].name, 'list_files');
    assert.equal(!!toolResults[0].is_error, false);
  });

  it('sends a native Responses request body on turn 1', () => {
    const first = requests[0];
    assert.equal(first.stream, true, 'transport forces streaming');
    assert.equal(first.store, false, 'stateless: reasoning must round-trip client-side');
    assert.ok(Array.isArray(first.input), 'conversation is an input item list');
    const userMsg = first.input.find((item) => item.type === 'message' && item.role === 'user');
    assert.ok(userMsg, 'user prompt travels as a native message item');
    assert.ok(
      first.tools.every((tool) => tool.type === 'function' && tool.parameters && !('input_schema' in tool)),
      'tool definitions are native function tools with parameters',
    );
    assert.ok(
      first.tools.some((tool) => tool.name === 'list_files'),
      'list_files offered to the model',
    );
    assert.equal(typeof first.instructions, 'string', 'system prompt travels as instructions');
    assert.equal('messages' in first, false);
    assert.equal('system' in first, false);
  });

  it('replays function_call + function_call_output with the captured call_id on turn 2', () => {
    const second = requests[1];
    const call = second.input.find((item) => item.type === 'function_call');
    const output = second.input.find((item) => item.type === 'function_call_output');
    assert.ok(call, 'assistant function_call item replayed in history');
    assert.ok(output, 'tool result travels as function_call_output');
    assert.equal(call.call_id, CAPTURED_CALL_ID);
    assert.equal(output.call_id, CAPTURED_CALL_ID, 'call_id pairing preserved');
    assert.equal(call.name, 'list_files');
    assert.match(String(output.output), /README\.md/, 'real local tool output went back on the wire');
    assert.ok(
      second.input.indexOf(call) < second.input.indexOf(output),
      'function_call precedes its function_call_output',
    );
  });

  it('authenticates with the env-var bearer token and no Anthropic headers', () => {
    for (const h of headers) {
      assert.equal(h.authorization, 'Bearer ' + FIXTURE_TOKEN);
      assert.equal('x-api-key' in h, false, 'no Anthropic API key header');
      assert.equal('anthropic-version' in h, false, 'no Anthropic version header');
      assert.match(h._url, /\/backend-api\/codex\/responses$/);
      assert.doesNotMatch(h._url, /\/v1\/messages/);
    }
  });

  it('late fence: no Anthropic request shapes anywhere on the wire', () => {
    const wire = JSON.stringify(requests);
    for (const forbidden of ['cache_control', 'input_schema', '"tool_use"', '"tool_result"', 'anthropic']) {
      assert.equal(wire.includes(forbidden), false, 'forbidden Anthropic shape on the wire: ' + forbidden);
    }
    for (const body of requests) {
      for (const item of body.input) {
        assert.ok(
          ['message', 'function_call', 'function_call_output', 'reasoning'].includes(item.type),
          'non-native input item type: ' + item.type,
        );
      }
    }
  });

  it('maps native usage fields including reasoning_tokens into the run summary', () => {
    // Captured fixtures report input_tokens 24 + 108 and output_tokens 18 + 13.
    assert.equal(result.usage.input_tokens > 0, true);
    assert.equal(result.usage.output_tokens > 0, true);
    assert.equal('reasoning_tokens' in result.usage, true);
    assert.equal('cache_read_input_tokens' in result.usage, true);
  });
});
