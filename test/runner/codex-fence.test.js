'use strict';

/**
 * codex-fence.test.js — Phase 3 Stage 6 "late fence".
 *
 * The roadmap requires that the active Codex path never regrows Anthropic
 * wire DNA: no /v1/messages endpoint, no manual cache_control markers, and
 * no Anthropic Messages request shapes (messages/system arrays, tool_use /
 * tool_result blocks, input_schema tool defs, x-api-key / anthropic-version
 * headers).
 *
 * Two layers:
 *   1. Static source fence — scan the active-path modules for forbidden
 *      tokens in executable code (comments may mention history).
 *   2. Request-shape fence — build a maximal native request (real tool
 *      catalog + full item history) and prove the serialized body and the
 *      transport constants are Anthropic-free.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modelClient = require('../../src/runner/model-client');
const transport = require('../../src/runner/codex-transport');
const items = require('../../src/runner/items');
const { TOOL_MODULES } = require('../../src/runner/tool-catalog');

const SRC = path.join(__dirname, '..', '..', 'src', 'runner');

// The modules a live Codex request flows through, prompt → wire.
const ACTIVE_CODEX_PATH = ['run.js', 'model-client.js', 'codex-transport.js', 'items.js', 'tool-pipeline.js'];

// Wire-level tokens that must never appear in executable active-path code.
const FORBIDDEN_SOURCE_TOKENS = [
  '/v1/messages',
  'cache_control',
  'anthropic-version',
  'x-api-key',
  'api.anthropic.com',
];

// Keys/shapes that must never appear in a serialized Codex request body.
const FORBIDDEN_BODY_TOKENS = [
  'cache_control',
  'input_schema',
  '"messages"',
  '"system"',
  '"tool_use"',
  '"tool_result"',
  'anthropic',
];

/** True when a source line is (or is inside) a comment, so prose mentions of history are fine. */
function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

describe('late fence: static source scan of the active Codex path', () => {
  for (const file of ACTIVE_CODEX_PATH) {
    it(file + ' has no Anthropic wire tokens in executable code', () => {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8');
      const offenders = [];
      source.split('\n').forEach((line, index) => {
        if (isCommentLine(line)) return;
        for (const token of FORBIDDEN_SOURCE_TOKENS) {
          if (line.includes(token)) {
            offenders.push(file + ':' + (index + 1) + ' contains "' + token + '": ' + line.trim());
          }
        }
      });
      assert.deepEqual(offenders, [], offenders.join('\n'));
    });
  }

  it('run.js no longer exports Anthropic cache budgeting helpers', () => {
    const runModule = require('../../src/runner/run');
    assert.equal('applyCacheControlBudget' in runModule, false);
  });
});

describe('late fence: request shape', () => {
  it('a maximal native request body carries no Anthropic shapes', () => {
    // Every real tool definition (input_schema flavored) must map cleanly.
    const tools = TOOL_MODULES.map((mod) => mod.definition());
    const body = modelClient.createRequest({
      model: 'gpt-5.5',
      instructions: 'You are a coding agent.',
      input: [
        items.userMessage('list files'),
        items.reasoningItem({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'OPAQUE' }),
        items.functionCall({ callId: 'call_1', name: 'list_files', arguments: '{"path":"."}' }),
        items.functionCallOutput({ callId: 'call_1', output: 'README.md' }),
        items.assistantMessage('Found README.md'),
      ],
      tools,
      effort: 'high',
    });

    const wire = JSON.stringify(body);
    for (const token of FORBIDDEN_BODY_TOKENS) {
      assert.equal(wire.includes(token), false, 'forbidden token in request body: ' + token);
    }

    // Positive shape checks: the native grammar is actually present.
    assert.ok(Array.isArray(body.input));
    assert.ok(body.input.every((item) => items.isInputItem(item)));
    assert.ok(body.tools.length > 0);
    assert.ok(body.tools.every((tool) => tool.type === 'function' && tool.parameters));
    assert.equal(typeof body.instructions, 'string');
    assert.equal(body.store, false);
  });

  it('normalized request bodies force stream:true and never gain Anthropic keys', () => {
    // Real composition: createRequest builds the body (store:false), the
    // transport normalizer then forces the streaming-only wire contract.
    const normalized = transport.normalizeRequestBody(modelClient.createRequest({ model: 'gpt-5.5', input: [] }));
    assert.equal(normalized.stream, true);
    assert.equal(normalized.store, false);
    const wire = JSON.stringify(normalized);
    for (const token of FORBIDDEN_BODY_TOKENS) {
      assert.equal(wire.includes(token), false, 'forbidden token after normalization: ' + token);
    }
  });

  it('the default endpoint is the ChatGPT backend Codex route, not /v1/messages', () => {
    assert.equal(transport.CODEX_RESPONSES_URL, 'https://chatgpt.com/backend-api/codex/responses');
    assert.doesNotMatch(transport.CODEX_RESPONSES_URL, /\/v1\/messages/);
    assert.doesNotMatch(transport.CODEX_RESPONSES_URL, /anthropic/);
  });

  it('auth comes from the single env var, not Anthropic credential paths', () => {
    assert.equal(transport.TOKEN_ENV_VAR, 'CODEX_ACCESS_TOKEN');
    const token = transport.resolveAccessToken({ CODEX_ACCESS_TOKEN: 'at-fence-fixture' });
    assert.equal(token, 'at-fence-fixture');
  });
});
