'use strict';

// These regressions exercise the real runner and HTTP client with a local model.
// A disposable project and a fake token keep every check offline and free.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { run } = require('../../src/runner/run');
const { SessionStore, resolveSessionPath } = require('../../src/runner/session-store');
const { SessionLedger } = require('../../src/runner/session-ledger');
const { writeAutopsyFile } = require('../../src/runner/loop-autopsy');
const { parseRetryAfter, retryDelayMs } = require('../../src/runner/model-retry');
const { formatFatalError } = require('../../bin/local-bridge-runner');

describe('retry metadata', () => {
  it('handles numeric and dated server delays without retaining raw headers', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    assert.equal(parseRetryAfter('2', now), 2000);
    assert.equal(parseRetryAfter('Sun, 25 Oct 2026 12:00:03 GMT', now), 3000);
    assert.equal(parseRetryAfter('Sun, 25 Oct 2026 11:59:00 GMT', now), 0);
    assert.equal(parseRetryAfter('invalid header', now), null);
    assert.equal(retryDelayMs({ statusCode: 429, retryAfterMs: parseRetryAfter('9'.repeat(400), now) }, 0), null);
  });

  it('retries temporary network errors but never guesses from an error message', () => {
    assert.equal(retryDelayMs({ code: 'ECONNRESET' }, 0), 250);
    assert.equal(retryDelayMs({ code: 'ETIMEDOUT' }, 1), 500);
    assert.equal(retryDelayMs({ message: 'HTTP 503' }, 0), null);
    assert.equal(retryDelayMs({ code: 'ERR_INVALID_ARG_TYPE' }, 0), null);
    assert.equal(retryDelayMs({ statusCode: 401, code: 'ECONNRESET' }, 0), null);
  });
});

function reply(res, output, inputTokens = 100, outputTokens = 10) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  output.forEach((item, output_index) =>
    res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index, item }) + '\n\n'),
  );
  res.end(
    'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_test',
          status: 'completed',
          output,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        },
      }) +
      '\n\n',
  );
}
const text = () => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] });
const read = (n) => ({
  type: 'function_call',
  call_id: 'read_' + n,
  name: 'read_file',
  arguments: JSON.stringify({ path: 'part' + n + '.txt' }),
});

describe('bounded evaluation regressions', () => {
  let cwd, server, url, requests, respond, savedToken, savedExit;
  beforeEach(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remediation-'));
    for (let n = 1; n <= 4; n++) fs.writeFileSync(path.join(cwd, 'part' + n + '.txt'), 'Distinct part ' + n);
    savedToken = process.env.CODEX_ACCESS_TOKEN;
    savedExit = process.exitCode;
    process.env.CODEX_ACCESS_TOKEN = 'at-offline-regression-fixture';
    requests = [];
    respond = (_body, res) => reply(res, [text()]);
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push({ time: Date.now(), body });
        respond(body, res);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = 'http://127.0.0.1:' + server.address().port + '/responses';
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
      prompt: 'Read the bounded fixture.',
      model: 'gpt-5.5',
      bridgeUrl: url,
      bare: true,
      quiet: true,
      skipTrustGate: true,
      noArchive: true,
      noSessionPersistence: true,
      autoMemory: false,
      allowedTools: ['read_file'],
      maxSteps: 8,
      outputFormat: 'json',
      ...extra,
    };
  }

  it('rejects session.json before creating files or sending a request', async () => {
    const invalid = path.join(cwd, 'session.json');
    const before = fs.readdirSync(cwd);
    await assert.rejects(run(options({ sessionPath: invalid })), /must end in \.state\.json/);
    assert.deepEqual(fs.readdirSync(cwd), before);
    assert.equal(requests.length, 0);
  });

  it('rejects invalid session paths at direct store, ledger, resolution and autopsy entry points', () => {
    const invalid = path.join(cwd, 'existing.json');
    fs.writeFileSync(invalid, '{"keep":"unchanged"}');
    const before = fs.readFileSync(invalid);
    for (const action of [
      () => new SessionStore(invalid),
      () => new SessionLedger(invalid),
      () => resolveSessionPath({ sessionPath: invalid }),
      () => writeAutopsyFile(invalid, { stopReason: 'test' }),
    ]) {
      assert.throws(action, /must end in \.state\.json/);
      assert.deepEqual(fs.readFileSync(invalid), before);
    }
  });

  it('explains an invalid session filename as a user input error', () => {
    try {
      resolveSessionPath({ sessionPath: '' });
      assert.fail('an empty path must be rejected');
    } catch (error) {
      assert.equal(error.code, 'session_path_invalid');
      assert.match(formatFatalError(error), /^Error: Session path must end in \.state\.json/);
    }
  });

  it('stops permanent HTTP 400 errors after one request', async () => {
    respond = (_body, res) => {
      res.writeHead(400);
      res.end('{"error":"invalid request"}');
    };
    const result = await run(options());
    assert.equal(result.stopReason, 'bridge_error');
    assert.equal(requests.length, 1);
  });

  it('backs off before recovering from a temporary HTTP 503 error', async () => {
    respond = (_body, res) => {
      if (requests.length === 1) {
        res.writeHead(503);
        res.end('temporarily unavailable');
      } else reply(res, [text()]);
    };
    const result = await run(options());
    assert.equal(result.stopReason, 'success');
    assert.equal(requests.length, 2);
    assert.ok(requests[1].time - requests[0].time >= 200, 'a real delay separates requests');
  });

  it('limits repeated transient errors to three total requests with increasing waits', async () => {
    respond = (_body, res) => {
      res.writeHead(503);
      res.end('temporarily unavailable');
    };
    const result = await run(options());
    assert.equal(result.stopReason, 'bridge_error');
    assert.equal(requests.length, 3);
    assert.ok(requests[1].time - requests[0].time >= 200);
    assert.ok(requests[2].time - requests[1].time >= 450);
  });

  it('respects Retry-After and stops rather than retrying earlier than a long server delay', async () => {
    respond = (_body, res) => {
      res.writeHead(429, { 'retry-after': '120' });
      res.end('wait');
    };
    const result = await run(options());
    assert.equal(result.stopReason, 'bridge_error');
    assert.equal(requests.length, 1);
  });

  it('honors a short Retry-After before a successful retry', async () => {
    respond = (_body, res) => {
      if (requests.length === 1) {
        res.writeHead(429, { 'retry-after': '0.5' });
        res.end('wait');
      } else reply(res, [text()]);
    };
    const result = await run(options());
    assert.equal(result.stopReason, 'success');
    assert.equal(requests.length, 2);
    assert.ok(requests[1].time - requests[0].time >= 450);
  });

  it('does not spend the last allowed model step on an extra retry', async () => {
    respond = (_body, res) => {
      res.writeHead(503);
      res.end('temporarily unavailable');
    };
    const result = await run(options({ maxSteps: 1 }));
    assert.equal(result.stopReason, 'bridge_error');
    assert.equal(requests.length, 1);
  });

  it('does not wait past the run wall-clock allowance to retry', async () => {
    respond = (_body, res) => {
      res.writeHead(429, { 'retry-after': '2' });
      res.end('wait');
    };
    const result = await run(options({ maxWallClockMs: 1000 }));
    assert.equal(result.stopReason, 'bridge_error');
    assert.equal(requests.length, 1);
  });

  it('resets the consecutive retry allowance after a successful model response', async () => {
    respond = (_body, res) => {
      if (requests.length % 2 === 1) {
        res.writeHead(503);
        res.end('temporary outage');
      } else {
        reply(res, requests.length < 6 ? [read(requests.length)] : [text()]);
      }
    };
    const result = await run(options());
    assert.equal(result.stopReason, 'success');
    assert.equal(requests.length, 6);
  });

  it('does not mistake accumulated usage for current context size', async () => {
    respond = (_body, res) =>
      reply(res, requests.length < 5 ? [read(requests.length)] : [text()], requests.length * 1000, 20);
    const result = await run(options({ maxContextTokens: 4000 }));
    assert.equal(result.stopReason, 'success');
    assert.equal(requests.length, 5);
    assert.equal(result.usage.input_tokens, 15000, 'cumulative usage remains available for spend accounting');
  });

  it('still stops an individually oversized response before running its tool', async () => {
    // Input alone is below the hard threshold; the reply must count too.
    respond = (_body, res) => reply(res, [read(1)], 7900, 200);
    const result = await run(options({ maxContextTokens: 4000 }));
    assert.equal(result.stopReason, 'context_budget_exceeded');
    assert.equal(requests.length, 1);
    assert.equal(
      result.events.some((event) => event.type === 'tool_use'),
      false,
    );
  });

  it('still applies a separate cumulative input budget', async () => {
    respond = (_body, res) => reply(res, [read(requests.length)], 3000, 20);
    const result = await run(options({ maxContextTokens: 4000, budgetInputTokens: 5000 }));
    assert.equal(result.stopReason, 'input_token_budget_exceeded');
    assert.equal(requests.length, 2);
  });
});
