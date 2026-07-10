'use strict';

/**
 * Legacy Anthropic Messages model-client tests are retired.
 * Native Responses coverage lives in:
 *   - test/runner/codex-model-client.test.js
 *   - test/runner/codex-transport.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const modelClient = require('../../src/runner/model-client');

describe('model-client (native)', () => {
  it('withCallerAuth is a no-op passthrough (Codex uses env token)', () => {
    assert.deepEqual(modelClient.withCallerAuth({ 'x-test': '1' }, 'ignored'), { 'x-test': '1' });
  });

  it('exports createRequest and post/postStream', () => {
    assert.equal(typeof modelClient.createRequest, 'function');
    assert.equal(typeof modelClient.post, 'function');
    assert.equal(typeof modelClient.postStream, 'function');
  });

  it('createRequest maps effort max → high', () => {
    const body = modelClient.createRequest({ model: 'gpt-5.5', effort: 'max' });
    assert.deepEqual(body.reasoning, { effort: 'high' });
  });
});
