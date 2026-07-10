'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const modelClient = require('../../src/runner/model-client');
const items = require('../../src/runner/items');

const FIXTURE_TOKEN = 'at-Fixture0Token1Value2With3Entropy4';
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'codex');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

describe('model-client createRequest', () => {
  it('builds a native Responses body with tools mapped from input_schema', () => {
    const body = modelClient.createRequest({
      model: 'gpt-5.5',
      instructions: 'You are a coding agent.',
      input: [items.userMessage('list files')],
      tools: [
        {
          name: 'list_files',
          description: 'List files',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      effort: 'medium',
    });

    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.store, false);
    assert.equal(body.instructions, 'You are a coding agent.');
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].name, 'list_files');
    assert.ok(body.tools[0].parameters);
    assert.equal('input_schema' in body.tools[0], false);
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.equal('max_output_tokens' in body, false);
  });

  it('maps effort max → high', () => {
    assert.equal(modelClient.mapEffort('max'), 'high');
    const body = modelClient.createRequest({ model: 'gpt-5.5', effort: 'max' });
    assert.deepEqual(body.reasoning, { effort: 'high' });
  });

  it('rejects unknown effort values', () => {
    assert.throws(() => modelClient.mapEffort('ultra'), /effort/);
  });
});

describe('model-client stream assembler (unit)', () => {
  it('assembles function_call from deltas even when response.output is empty', () => {
    const asm = modelClient.createStreamAssembler();
    asm.handleEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '' },
    });
    asm.handleEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"path":"."}',
      obfuscation: 'ignore-me',
    });
    asm.handleEvent({
      type: 'response.function_call_arguments.done',
      output_index: 0,
      arguments: '{"path":"."}',
    });
    asm.handleEvent({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'list_files',
        arguments: '{"path":"."}',
      },
    });
    asm.handleEvent({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });

    const result = asm.finish();
    assert.equal(result.id, 'resp_1');
    assert.equal(result.stop_reason, 'tool_use');
    assert.equal(result.output.length, 1);
    assert.equal(result.output[0].type, 'function_call');
    assert.equal(result.output[0].call_id, 'call_1');
    assert.equal(result.output[0].arguments, '{"path":"."}');
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.cache_creation_input_tokens, 0);

    const parsed = items.parseFunctionCallArguments(result.output[0]);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { path: '.' });
  });
});

describe('model-client against live fixtures', () => {
  let server;
  let baseUrl;
  let fixtureName = 'responses-stream-pong.sse';
  let lastBody = null;

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const payload = readFixture(fixtureName);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Awkward chunks exercise SSE buffering in transport.
        let i = 0;
        const step = 73;
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
  });

  after(() => server.close());

  it('replays pong fixture into assistant text output', async () => {
    fixtureName = 'responses-stream-pong.sse';
    const body = modelClient.createRequest({
      model: 'gpt-5.5',
      input: [items.userMessage('Reply with exactly one word: pong')],
    });
    const result = await modelClient.post(body, baseUrl, { env: { CODEX_ACCESS_TOKEN: FIXTURE_TOKEN } });

    assert.equal(lastBody.stream, true);
    assert.equal(lastBody.store, false);
    assert.equal(result.output_text, 'pong');
    assert.equal(result.stop_reason, 'end_turn');
    assert.ok(result.output.some((item) => item.type === 'message'));
    assert.equal(result.usage.input_tokens, 12);
    assert.ok(result._transport);
    assert.equal(result._transport.status_code, 200);
    assert.equal('_localBridge' in result, false);
  });

  it('replays function-call fixture into a native function_call item', async () => {
    fixtureName = 'responses-stream-function-call.sse';
    const body = modelClient.createRequest({
      model: 'gpt-5.5',
      input: [items.userMessage('list files')],
      tools: [{ name: 'list_files', description: 'List', input_schema: { type: 'object', properties: {} } }],
      effort: 'medium',
    });
    const result = await modelClient.postStream(body, null, baseUrl, {
      env: { CODEX_ACCESS_TOKEN: FIXTURE_TOKEN },
    });

    assert.equal(result.stop_reason, 'tool_use');
    assert.equal(result.function_calls.length, 1);
    assert.equal(result.function_calls[0].name, 'list_files');
    assert.equal(result.function_calls[0].call_id, 'call_HCylw4uI1hXvaVo8tGWQLQs3');
    assert.equal(result.function_calls[0].arguments, '{"path":"."}');
    assert.equal(result.output_text, '');
    assert.equal(result.usage.output_tokens, 18);
    assert.equal(result.usage.reasoning_tokens, 0);

    const parsed = items.parseFunctionCallArguments(result.function_calls[0]);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { path: '.' });
  });

  it('replays final-answer fixture after function_call_output history', async () => {
    fixtureName = 'responses-stream-final-answer.sse';
    const body = modelClient.createRequest({
      model: 'gpt-5.5',
      input: [
        items.userMessage('list files'),
        items.functionCall({ callId: 'call_fixture_list_files', name: 'list_files', arguments: '{"path":"."}' }),
        items.functionCallOutput({ callId: 'call_fixture_list_files', output: 'README.md\npackage.json' }),
      ],
      tools: [{ name: 'list_files', description: 'List', input_schema: { type: 'object', properties: {} } }],
    });
    const result = await modelClient.post(body, { url: baseUrl, env: { CODEX_ACCESS_TOKEN: FIXTURE_TOKEN } });

    assert.equal(result.stop_reason, 'end_turn');
    assert.match(result.output_text, /README\.md/);
    assert.ok(result.output.some((item) => item.type === 'message' && item.phase === 'final_answer'));
    assert.equal(result.usage.input_tokens, 108);
  });
});
