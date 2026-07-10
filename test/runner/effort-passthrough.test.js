'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const modelClient = require('../../src/runner/model-client');
const { run, normalizeEffort } = require('../../src/runner/run');
const { SessionStore } = require('../../src/runner/session-store');
const health = require('../../src/runner/session-health');
const nativeItems = require('../../src/runner/items');

describe('effort passthrough', () => {
  it('normalizeEffort accepts planned enum values', () => {
    assert.equal(normalizeEffort('high'), 'high');
    assert.equal(normalizeEffort('MAX'), 'max');
    assert.throws(() => normalizeEffort('turbo'), /--effort must be one of/);
  });

  it('forwards reasoning.effort in native model requests', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-run-'));
    const originalPost = modelClient.post;
    let capturedBody = null;
    modelClient.post = async (body) => {
      capturedBody = body;
      return {
        id: 'resp_test',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        output_text: 'ok',
        usage: {},
        stop_reason: 'end_turn',
        function_calls: [],
      };
    };

    try {
      await run({
        prompt: 'Say ok',
        cwd: tmpDir,
        model: 'test',
        maxTokens: 10,
        maxSteps: 1,
        effort: 'medium',
      });
      assert.deepEqual(capturedBody.reasoning, { effort: 'medium' });
    } finally {
      modelClient.post = originalPost;
    }
  });
});

describe('session resume health gate', () => {
  it('blocks --resume-session when health is degraded', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-health-'));
    const sessionPath = path.join(tmpDir, 'bad.state.json');
    const store = new SessionStore(sessionPath);
    store.load();
    store.setItems([nativeItems.userMessage('prior')]);
    store.updateRunner({
      health: health.buildHealth({ stopReason: 'max_steps' }),
    });
    store.save();

    const originalPost = modelClient.post;
    const originalExitCode = process.exitCode;
    modelClient.post = async () => {
      throw new Error('model should not be called');
    };

    try {
      const result = await run({
        prompt: 'continue',
        cwd: tmpDir,
        model: 'test',
        maxTokens: 10,
        maxSteps: 1,
        sessionPath,
        resume: true,
      });
      assert.match(result.finalText, /degraded/i);
      assert.equal(result.stopReason, 'resume_failed');
    } finally {
      modelClient.post = originalPost;
      process.exitCode = originalExitCode;
    }
  });
});

describe('instruction delta in run loop', () => {
  it('injects small CLAUDE.md delta on a later turn after an edit', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-run-'));
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'alpha\n');
    const originalPost = modelClient.post;
    let callCount = 0;
    let sawDelta = false;
    modelClient.post = async (body) => {
      callCount++;
      if (callCount === 2) {
        const serialized = JSON.stringify(body.input || []);
        sawDelta = serialized.includes('Instruction memory update');
      }
      if (callCount === 1) {
        return {
          id: 'resp_1',
          output: [
            {
              type: 'function_call',
              call_id: 'w1',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'CLAUDE.md', content: 'alpha\nbeta\n' }),
            },
          ],
          output_text: '',
          usage: {},
          stop_reason: 'tool_use',
          function_calls: [
            {
              type: 'function_call',
              call_id: 'w1',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'CLAUDE.md', content: 'alpha\nbeta\n' }),
            },
          ],
        };
      }
      return {
        id: 'resp_2',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
        output_text: 'done',
        usage: {},
        stop_reason: 'end_turn',
        function_calls: [],
      };
    };

    try {
      await run({
        prompt: 'update instructions',
        cwd: tmpDir,
        model: 'test',
        maxTokens: 10,
        maxSteps: 2,
        acceptEdits: true,
      });
      assert.equal(sawDelta, true);
    } finally {
      modelClient.post = originalPost;
    }
  });
});
