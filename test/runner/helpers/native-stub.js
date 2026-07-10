'use strict';

/**
 * Convert Anthropic-shaped stub responses (or partial native ones) into the
 * native model-client return shape that run.js expects after Phase 3 Stage 4.
 */
function asNativeModelResponse(entry = {}) {
  if (Array.isArray(entry.output)) {
    return {
      id: entry.id || 'resp_stub',
      output: entry.output,
      output_text: entry.output_text || '',
      usage: entry.usage || {},
      stop_reason: entry.stop_reason || 'end_turn',
      function_calls: entry.function_calls || entry.output.filter((i) => i.type === 'function_call'),
      streamed: false,
      _transport: entry._transport || { status_code: 200 },
    };
  }

  const output = [];
  for (const block of entry.content || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      output.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: block.text || '' }],
      });
    } else if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input || {}),
      });
    }
  }

  const functionCalls = output.filter((i) => i.type === 'function_call');
  const text = output
    .filter((i) => i.type === 'message')
    .map((i) => (i.content || []).map((p) => p.text || '').join(''))
    .join('\n');

  return {
    id: entry.id || 'resp_stub',
    output,
    output_text: text,
    usage: entry.usage || {},
    stop_reason: entry.stop_reason || (functionCalls.length ? 'tool_use' : 'end_turn'),
    function_calls: functionCalls,
    streamed: false,
    _transport: entry._transport || { status_code: 200 },
  };
}

/** Wrap a stub so Anthropic-shaped returns are auto-converted. */
function wrapPostStub(fn) {
  return async (...args) => asNativeModelResponse(await fn(...args));
}

module.exports = { asNativeModelResponse, wrapPostStub };
