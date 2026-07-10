'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const modelClient = require('../../src/runner/model-client');
const { run } = require('../../src/runner/run');

describe('native persistence and observability', () => {
  it('saves native items, records reasoning usage, and resumes them', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-persistence-e2e-'));
    const sessionPath = path.join(tmpDir, 'session.state.json');
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const humanLogPath = path.join(tmpDir, 'human-log.md');
    const originalPost = modelClient.post;
    let requestNumber = 0;
    let resumedInput = null;

    modelClient.post = async (body) => {
      requestNumber++;
      if (requestNumber === 2) resumedInput = JSON.parse(JSON.stringify(body.input));
      return {
        id: 'resp_' + requestNumber,
        output: [
          {
            type: 'reasoning',
            id: 'rs_' + requestNumber,
            encrypted_content: 'opaque-reasoning-' + requestNumber,
            status: 'completed',
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: requestNumber === 1 ? 'First answer.' : 'Resumed answer.' }],
          },
        ],
        output_text: requestNumber === 1 ? 'First answer.' : 'Resumed answer.',
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 7,
        },
        stop_reason: 'end_turn',
        function_calls: [],
      };
    };

    try {
      await run({
        prompt: 'Start the session.',
        cwd: tmpDir,
        model: 'gpt-5.5',
        maxSteps: 1,
        sessionPath,
        transcriptPath,
        humanLogPath,
        noArchive: true,
        quiet: true,
      });

      const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      assert.equal(saved.schemaVersion, 2);
      assert.equal(saved.provider, 'codex');
      assert.deepEqual(
        saved.items.map((item) => item.type),
        ['message', 'reasoning', 'message'],
      );

      const transcriptEvents = fs
        .readFileSync(transcriptPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const usage = transcriptEvents.find((event) => event.type === 'usage');
      assert.equal(usage.provider, 'codex');
      assert.equal(usage.reasoningTokens, 7);
      assert.match(fs.readFileSync(humanLogPath, 'utf8'), /reasoning tokens: 7/);

      await run({
        prompt: 'Continue the session.',
        cwd: tmpDir,
        model: 'gpt-5.5',
        maxSteps: 1,
        sessionPath,
        resume: true,
        noArchive: true,
        quiet: true,
      });

      assert.ok(resumedInput.some((item) => item.type === 'reasoning' && item.id === 'rs_1'));
      assert.equal(resumedInput.at(-1).type, 'message');
      assert.equal(resumedInput.at(-1).role, 'user');

      const ledgerPath = sessionPath.replace(/\.state\.json$/, '.ledger.jsonl');
      const ledgerEvents = fs
        .readFileSync(ledgerPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(ledgerEvents.some((event) => event.type === 'assistant_items'));
      assert.ok(ledgerEvents.every((event) => event.provider === 'codex'));
    } finally {
      modelClient.post = originalPost;
    }
  });
});
