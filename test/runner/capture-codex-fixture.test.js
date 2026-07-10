'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const capture = require('../../scripts/capture-codex-fixture');

const FIXTURE_TOKEN = 'at-Fixture0Token1Value2With3Entropy4';
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'codex');

describe('capture-codex-fixture redaction', () => {
  it('redacts safety_identifier and prompt_cache_key UUIDs', () => {
    const raw = '"safety_identifier":"user-secret-id-12345","prompt_cache_key":"550e8400-e29b-41d4-a716-446655440000"';
    const redacted = capture.redactFixtureText(raw);
    assert.ok(redacted.includes('user-[REDACTED-ID]'));
    assert.ok(redacted.includes('[REDACTED-UUID]'));
    assert.ok(!redacted.includes('user-secret-id'));
    assert.ok(!redacted.includes('550e8400-e29b'));
  });

  it('leak-grep passes on redacted pong fixture', () => {
    const pong = fs.readFileSync(path.join(FIXTURE_DIR, 'responses-stream-pong.sse'), 'utf8');
    const leak = capture.leakGrep(pong);
    assert.equal(leak.ok, true, JSON.stringify(leak.hits));
  });

  it('leak-grep passes on live function-call and final-answer fixtures', () => {
    for (const name of ['responses-stream-function-call.sse', 'responses-stream-final-answer.sse']) {
      const text = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
      const leak = capture.leakGrep(text);
      assert.equal(leak.ok, true, name + ': ' + JSON.stringify(leak.hits));
      // Live captures must include the real SSE event names Phase 3 will parse.
      if (name.includes('function-call')) {
        assert.ok(text.includes('response.function_call_arguments.delta'));
        assert.ok(text.includes('"type":"function_call"'));
      } else {
        assert.ok(text.includes('response.output_text.delta'));
        assert.ok(text.includes('"phase":"final_answer"'));
      }
    }
  });

  it('leak-grep rejects raw at- tokens', () => {
    const leak = capture.leakGrep('authorization: Bearer ' + FIXTURE_TOKEN);
    assert.equal(leak.ok, false);
  });

  it('presetBody builds function-call request with tools', () => {
    const body = capture.presetBody('function-call', 'gpt-5.5', 'medium');
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, 'list_files');
    assert.ok(Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content'));
  });

  it('presetBody builds final-answer request with function_call_output history', () => {
    const body = capture.presetBody('final-answer', 'gpt-5.5', 'medium');
    const types = body.input.map((item) => item.type);
    assert.ok(types.includes('function_call'));
    assert.ok(types.includes('function_call_output'));
  });
});
