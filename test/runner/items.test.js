'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const items = require('../../src/runner/items');

describe('items type guards', () => {
  it('recognizes each native item type', () => {
    const user = items.userMessage('hi');
    const fc = items.functionCall({ callId: 'call_1', name: 'list_files', arguments: '{}' });
    const out = items.functionCallOutput({ callId: 'call_1', output: 'ok' });
    const reasoning = items.reasoningItem({ type: 'reasoning', id: 'rs_1', summary: [] });

    assert.equal(items.isMessageItem(user), true);
    assert.equal(items.isFunctionCallItem(fc), true);
    assert.equal(items.isFunctionCallOutputItem(out), true);
    assert.equal(items.isReasoningItem(reasoning), true);
    assert.equal(items.isInputItem(user), true);
    assert.equal(items.isInputItem(fc), true);
    assert.equal(items.isInputItem({ type: 'tool_use' }), false);
  });
});

describe('items constructors', () => {
  it('builds user and assistant message items with typed text parts', () => {
    const user = items.userMessage('list files');
    assert.equal(user.type, 'message');
    assert.equal(user.role, 'user');
    assert.equal(user.content[0].type, 'input_text');
    assert.equal(user.content[0].text, 'list files');

    const assistant = items.assistantMessage('done');
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content[0].type, 'output_text');
  });

  it('builds function_call with JSON-string arguments and optional id', () => {
    const fc = items.functionCall({
      callId: 'call_abc',
      name: 'list_files',
      arguments: { path: '.' },
      id: 'fc_abc',
    });
    assert.equal(fc.type, 'function_call');
    assert.equal(fc.call_id, 'call_abc');
    assert.equal(fc.name, 'list_files');
    assert.equal(fc.arguments, '{"path":"."}');
    assert.equal(fc.id, 'fc_abc');
  });

  it('prefixes error tool outputs (no is_error on the wire)', () => {
    const ok = items.functionCallOutput({ callId: 'call_1', output: 'README.md' });
    assert.equal(ok.output, 'README.md');
    assert.equal(items.isToolErrorOutput(ok.output), false);

    const err = items.functionCallOutput({ callId: 'call_1', output: 'permission denied', isError: true });
    assert.equal(err.output, items.TOOL_ERROR_PREFIX + 'permission denied');
    assert.equal(items.isToolErrorOutput(err.output), true);

    const already = items.functionCallOutput({
      callId: 'call_1',
      output: items.TOOL_ERROR_PREFIX + 'already',
      isError: true,
    });
    assert.equal(already.output, items.TOOL_ERROR_PREFIX + 'already');
  });

  it('preserves reasoning items verbatim via shallow clone', () => {
    const raw = {
      type: 'reasoning',
      id: 'rs_live',
      encrypted_content: 'opaque-bytes',
      status: 'completed',
    };
    const cloned = items.reasoningItem(raw);
    assert.deepEqual(cloned, raw);
    cloned.status = 'mutated';
    assert.equal(raw.status, 'completed');
  });
});

describe('items extractors', () => {
  it('extractText joins message parts from an item list', () => {
    const history = [
      items.userMessage('hello'),
      items.functionCall({ callId: 'call_1', name: 'list_files', arguments: '{}' }),
      items.assistantMessage('world'),
    ];
    assert.equal(items.extractText(history), 'hello\nworld');
  });

  it('extractFunctionCalls returns only function_call items', () => {
    const history = [
      items.userMessage('go'),
      items.functionCall({ callId: 'call_1', name: 'list_files', arguments: '{}' }),
      items.functionCallOutput({ callId: 'call_1', output: 'ok' }),
      items.functionCall({ callId: 'call_2', name: 'read_file', arguments: '{"path":"a"}' }),
    ];
    const calls = items.extractFunctionCalls(history);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'list_files');
    assert.equal(calls[1].call_id, 'call_2');
  });

  it('parseFunctionCallArguments is fail-closed on malformed JSON', () => {
    const good = items.functionCall({ callId: 'c1', name: 'list_files', arguments: '{"path":"."}' });
    const parsed = items.parseFunctionCallArguments(good);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { path: '.' });

    const bad = items.functionCall({ callId: 'c2', name: 'list_files', arguments: '{not-json' });
    const failed = items.parseFunctionCallArguments(bad);
    assert.equal(failed.ok, false);
    assert.equal(failed.value, null);
    assert.match(failed.error, /malformed/i);

    // Never treat a JSON array as executable tool input.
    const arr = items.functionCall({ callId: 'c3', name: 'list_files', arguments: '[1,2]' });
    const arrParsed = items.parseFunctionCallArguments(arr);
    assert.equal(arrParsed.ok, false);
  });
});

describe('tool definition + usage helpers', () => {
  it('maps input_schema to native parameters without mutating the source', () => {
    const tool = {
      name: 'list_files',
      description: 'List files',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    };
    const native = items.toNativeToolDefinition(tool);
    assert.equal(native.type, 'function');
    assert.equal(native.name, 'list_files');
    assert.deepEqual(native.parameters, tool.input_schema);
    assert.equal(tool.input_schema.type, 'object'); // source untouched
    assert.equal('parameters' in tool, false);
  });

  it('normalizeUsage maps Responses fields and zeros cache-write', () => {
    const usage = items.normalizeUsage({
      input_tokens: 73,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
      output_tokens: 18,
      output_tokens_details: { reasoning_tokens: 4 },
      total_tokens: 91,
    });
    assert.deepEqual(usage, {
      input_tokens: 73,
      output_tokens: 18,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 4,
    });
  });
});

describe('session schema v2 clean break', () => {
  it('createNativeSession uses schemaVersion 2, provider codex, and items[]', () => {
    const session = items.createNativeSession('ses_test');
    assert.equal(session.schemaVersion, items.SCHEMA_VERSION);
    assert.equal(session.provider, items.PROVIDER);
    assert.deepEqual(session.items, []);
    assert.equal(Array.isArray(session.messages), false);
  });

  it('assertNativeSession accepts a valid v2 session', () => {
    const session = items.createNativeSession('ses_ok');
    session.items.push(items.userMessage('hi'));
    assert.equal(items.assertNativeSession(session), session);
  });

  it('rejects schemaVersion 1 sessions without mutating them', () => {
    const legacy = {
      schemaVersion: 1,
      sessionId: 'ses_old',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const before = JSON.stringify(legacy);
    assert.throws(() => items.assertNativeSession(legacy), (err) => {
      assert.equal(err.name, 'SessionSchemaError');
      assert.equal(err.code, 'session_schema_unsupported');
      assert.match(err.message, /cannot be resumed/i);
      return true;
    });
    assert.equal(JSON.stringify(legacy), before);
    assert.equal(items.isLegacySession(legacy), true);
  });

  it('rejects Anthropic tool_use messages even if schemaVersion is missing', () => {
    const legacy = {
      sessionId: 'ses_anthropic',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'list_files', input: {} }],
        },
      ],
    };
    assert.equal(items.isLegacySession(legacy), true);
    assert.throws(() => items.assertNativeSession(legacy), /cannot be resumed/i);
  });

  it('rejects wrong provider', () => {
    const other = items.createNativeSession('ses_x', { provider: 'anthropic' });
    assert.throws(() => items.assertNativeSession(other), (err) => {
      assert.equal(err.name, 'SessionSchemaError');
      return true;
    });
  });
});
