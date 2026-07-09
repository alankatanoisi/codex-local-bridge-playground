'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const safety = require('../../src/runner/safety');
const transport = require('../../src/runner/codex-transport');

// Fixture token — never a real credential. High-entropy shape on purpose so
// the redaction guard treats it like a real at-… token.
const FIXTURE_TOKEN = 'at-Fixture0Token1Value2With3Entropy4';

const PONG_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex', 'responses-stream-pong.sse'), 'utf8');

describe('codex token redaction (safety.js)', () => {
  it('redacts standalone at-… tokens', () => {
    const scrubbed = safety.scrubSecrets('token ' + FIXTURE_TOKEN + ' end');
    assert.ok(!scrubbed.includes(FIXTURE_TOKEN));
    assert.ok(scrubbed.includes('[REDACTED:openai_access_token]'));
  });

  it('redacts at-… tokens in Authorization headers', () => {
    const scrubbed = safety.scrubSecrets('authorization: Bearer ' + FIXTURE_TOKEN);
    assert.ok(!scrubbed.includes(FIXTURE_TOKEN));
  });

  it('redacts CODEX_ACCESS_TOKEN assignment lines', () => {
    const scrubbed = safety.scrubSecrets('CODEX_ACCESS_TOKEN=' + FIXTURE_TOKEN);
    assert.ok(!scrubbed.includes(FIXTURE_TOKEN));
  });

  it('leaves hyphenated prose intact', () => {
    const prose = 'we decided at-the-end-of-the-day-basically to keep at-rules and at-risk flags';
    assert.equal(safety.scrubSecrets(prose), prose);
  });

  it('scrubObject catches tokens nested in payloads', () => {
    const scrubbed = safety.scrubObject({ nested: { note: 'uses ' + FIXTURE_TOKEN } });
    assert.ok(!JSON.stringify(scrubbed).includes(FIXTURE_TOKEN));
  });
});

describe('codex env scrubbing (safety.js)', () => {
  it('lists CODEX_ACCESS_TOKEN in SCRUBBED_ENV_VARS', () => {
    assert.ok(safety.SCRUBBED_ENV_VARS.includes('CODEX_ACCESS_TOKEN'));
  });

  it('buildSafeEnv strips CODEX_* variables from child shells', () => {
    const saved = { ...process.env };
    try {
      process.env.CODEX_ACCESS_TOKEN = FIXTURE_TOKEN;
      process.env.CODEX_EXPERIMENT_FLAG = 'yes';
      const env = safety.buildSafeEnv();
      assert.ok(!('CODEX_ACCESS_TOKEN' in env));
      assert.ok(!('CODEX_EXPERIMENT_FLAG' in env));
      assert.ok('PATH' in env);
    } finally {
      delete process.env.CODEX_ACCESS_TOKEN;
      delete process.env.CODEX_EXPERIMENT_FLAG;
      if (saved.CODEX_ACCESS_TOKEN) process.env.CODEX_ACCESS_TOKEN = saved.CODEX_ACCESS_TOKEN;
      if (saved.CODEX_EXPERIMENT_FLAG) process.env.CODEX_EXPERIMENT_FLAG = saved.CODEX_EXPERIMENT_FLAG;
    }
  });

  it('deny matrix blocks the official Codex CLI credential store', () => {
    assert.ok(safety.isPathBlockedByDenyMatrix('/Users/someone/.codex/auth.json'));
    assert.ok(safety.isPathBlockedByDenyMatrix('/Users/someone/.codex'));
  });
});

describe('codex transport request validation', () => {
  it('requires CODEX_ACCESS_TOKEN and never echoes token bytes', () => {
    assert.throws(() => transport.resolveAccessToken({}), /CODEX_ACCESS_TOKEN is not set/);
  });

  it('reads the token from the provided env only', () => {
    assert.equal(transport.resolveAccessToken({ CODEX_ACCESS_TOKEN: FIXTURE_TOKEN }), FIXTURE_TOKEN);
  });

  it('rejects stream:false (backend is streaming-only)', () => {
    assert.throws(() => transport.normalizeRequestBody({ model: 'gpt-5.5', stream: false }), /streaming-only/);
  });

  it('rejects max_output_tokens (unsupported upstream)', () => {
    assert.throws(
      () => transport.normalizeRequestBody({ model: 'gpt-5.5', max_output_tokens: 100 }),
      /max_output_tokens/,
    );
  });

  it('forces stream:true on outgoing bodies', () => {
    assert.equal(transport.normalizeRequestBody({ model: 'gpt-5.5' }).stream, true);
  });

  it('codexBodySummary reports structure without payload text', () => {
    const summary = transport.codexBodySummary({
      model: 'gpt-5.5',
      stream: true,
      store: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'secret prompt' }] }],
    });
    assert.equal(summary.model, 'gpt-5.5');
    assert.equal(summary.input_items, 1);
    assert.equal(summary.input_item_types.message, 1);
    assert.ok(!JSON.stringify(summary).includes('secret prompt'));
  });
});

describe('codex transport streaming client', () => {
  let server;
  let baseUrl;
  let lastRequest = null;
  let mode = 'pong';

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastRequest = {
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        };
        if (mode === 'unauthorized') {
          res.writeHead(401, { 'content-type': 'application/json' });
          // Hostile-ish body that echoes the credential back — the client
          // must scrub it before surfacing the error.
          res.end(JSON.stringify({ error: 'bad token ' + req.headers.authorization }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Write in awkward chunk sizes to exercise SSE frame buffering.
        let i = 0;
        const step = 97;
        const tick = () => {
          if (i >= PONG_FIXTURE.length) {
            res.end();
            return;
          }
          res.write(PONG_FIXTURE.slice(i, i + step));
          i += step;
          setImmediate(tick);
        };
        tick();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = 'http://127.0.0.1:' + server.address().port + '/backend-api/codex/responses';
  });

  after(() => server.close());

  it('round-trips a streamed call against the Phase 0 fixture', async () => {
    mode = 'pong';
    const seen = [];
    const result = await transport.requestStream(
      { model: 'gpt-5.5', input: [], store: false },
      (event) => seen.push(event.type),
      { url: baseUrl, env: { CODEX_ACCESS_TOKEN: FIXTURE_TOKEN } },
    );

    // Request wire shape
    assert.equal(lastRequest.headers.authorization, 'Bearer ' + FIXTURE_TOKEN);
    assert.equal(lastRequest.body.stream, true);

    // Assembled result
    assert.equal(result.output_text, 'pong');
    assert.equal(result.usage.input_tokens, 12);
    assert.equal(result.usage.output_tokens, 5);
    assert.equal(result.response.status, 'completed');
    assert.equal(result._transport.status_code, 200);

    // Event grammar observed in order
    assert.equal(seen[0], 'response.created');
    assert.equal(seen[seen.length - 1], 'response.completed');
    assert.ok(seen.includes('response.output_text.delta'));
  });

  it('supports buffered one-shot calls over the streaming-only wire', async () => {
    mode = 'pong';
    const result = await transport.requestBuffered(
      { model: 'gpt-5.5', input: [] },
      { url: baseUrl, env: { CODEX_ACCESS_TOKEN: FIXTURE_TOKEN } },
    );
    assert.equal(result.output_text, 'pong');
    assert.equal(result.streamed, true);
  });

  it('records request boundaries with header names only, never values', async () => {
    mode = 'pong';
    const traceCalls = [];
    const fakeTrace = { append: (type, fields) => traceCalls.push({ type, ...fields }) };

    await transport.requestStream({ model: 'gpt-5.5', input: [] }, null, {
      url: baseUrl,
      env: { CODEX_ACCESS_TOKEN: FIXTURE_TOKEN },
      trace: fakeTrace,
      runId: 'test-run',
      turn: 1,
    });

    const started = traceCalls.find((c) => c.type === 'codex_request_started');
    const completed = traceCalls.find((c) => c.type === 'codex_response_completed');
    assert.ok(started, 'expected codex_request_started');
    assert.ok(completed, 'expected codex_response_completed');
    assert.ok(started.request_headers.names.includes('authorization'));
    assert.equal(completed.status_code, 200);
    assert.equal(completed.response_id, 'resp_0de63bd3ec4f5c21016a4eb19128dc819bab88ff5e63ca0619');

    // The whole trace stream must be token-free.
    assert.ok(!JSON.stringify(traceCalls).includes(FIXTURE_TOKEN));
  });

  it('scrubs token bytes out of upstream error bodies', async () => {
    mode = 'unauthorized';
    await assert.rejects(
      transport.requestStream({ model: 'gpt-5.5', input: [] }, null, {
        url: baseUrl,
        env: { CODEX_ACCESS_TOKEN: FIXTURE_TOKEN },
      }),
      (err) => {
        assert.match(err.message, /HTTP 401/);
        assert.ok(!err.message.includes(FIXTURE_TOKEN), 'token must not leak into errors');
        return true;
      },
    );
    mode = 'pong';
  });
});
