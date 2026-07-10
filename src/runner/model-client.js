'use strict';

/**
 * model-client.js — Phase 3 Stage 3: native Responses client over codex-transport.
 *
 * Builds and streams Codex backend requests. Conversation I/O is Responses
 * *items* (see items.js) — not Anthropic Messages /v1/messages.
 *
 * API:
 *   createRequest({ model, instructions, input, tools, effort, ... })
 *   post(body, url?, opts?)           — buffered over the streaming-only wire
 *   postStream(body, onEvent, url?, opts?)
 *
 * Returns { id, output, output_text, usage, stop_reason, streamed, _transport }.
 * `output` is assembled from SSE item events — live captures leave response.output [].
 *
 * Auth: CODEX_ACCESS_TOKEN via codex-transport (env only). callerToken / bridge
 * auth from the Claude lane are unused here.
 */

const transport = require('./codex-transport');
const items = require('./items');

/** Runner --effort max has no native twin yet; map to high until a live capture settles it. */
const EFFORT_MAP = Object.freeze({
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
});

/**
 * Map CLI/runner effort to a Responses reasoning.effort value.
 * @param {string|null|undefined} effort
 * @returns {string|null}
 */
function mapEffort(effort) {
  if (effort === undefined || effort === null || effort === '') return null;
  const key = String(effort).toLowerCase();
  if (!(key in EFFORT_MAP)) {
    throw new Error('--effort must be one of: low, medium, high, max (max maps to high on Codex)');
  }
  return EFFORT_MAP[key];
}

/**
 * Build a native Responses request body for the Codex backend.
 * Omits max_output_tokens (rejected upstream). Forces store:false + stream:true
 * via transport.normalizeRequestBody when sent.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} [opts.instructions]
 * @param {object[]} [opts.input] — Responses input items
 * @param {object[]} [opts.tools] — runner tools ({name, description, input_schema}) or native tools
 * @param {string} [opts.effort]
 * @param {boolean} [opts.includeEncryptedReasoning=true]
 * @param {string|object} [opts.toolChoice]
 * @param {number} [opts.temperature] — omit if undefined (backend may echo a default)
 */
function createRequest(opts = {}) {
  if (!opts.model || typeof opts.model !== 'string') {
    throw new Error('createRequest requires opts.model');
  }

  const body = {
    model: opts.model,
    store: false,
    input: Array.isArray(opts.input) ? opts.input : [],
  };

  if (typeof opts.instructions === 'string' && opts.instructions.length > 0) {
    body.instructions = opts.instructions;
  }

  if (Array.isArray(opts.tools) && opts.tools.length > 0) {
    body.tools = opts.tools.map((tool) => {
      if (tool && tool.type === 'function' && tool.parameters) return tool;
      return items.toNativeToolDefinition(tool);
    });
    body.tool_choice = opts.toolChoice === undefined ? 'auto' : opts.toolChoice;
  }

  const effort = mapEffort(opts.effort);
  if (effort) body.reasoning = { effort };

  const includeEncrypted = opts.includeEncryptedReasoning !== false;
  if (includeEncrypted) body.include = ['reasoning.encrypted_content'];

  if (typeof opts.temperature === 'number' && !Number.isNaN(opts.temperature)) {
    body.temperature = opts.temperature;
  }

  return body;
}

/**
 * Assemble native output items from Responses SSE events.
 * Prefer output_item.done payloads; do not rely on response.output (often []).
 */
function createStreamAssembler(options = {}) {
  const streamOutput = !!options.streamOutput;
  /** @type {Map<number, object>} */
  const byIndex = new Map();
  /** @type {Map<number, string>} */
  const argBuffers = new Map();
  /** @type {Map<number, string>} */
  const textBuffers = new Map();
  /** @type {object[]} */
  const completed = [];
  let responseId = null;
  let status = null;
  let rawUsage = {};
  let outputText = '';
  let lastStreamed = '';

  function ensureSlot(outputIndex, seed) {
    if (!byIndex.has(outputIndex)) {
      byIndex.set(outputIndex, seed && typeof seed === 'object' ? { ...seed } : {});
    } else if (seed && typeof seed === 'object') {
      byIndex.set(outputIndex, { ...byIndex.get(outputIndex), ...seed });
    }
    return byIndex.get(outputIndex);
  }

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'response.created' && event.response) {
      responseId = event.response.id || responseId;
      status = event.response.status || status;
    }

    if (event.type === 'response.output_item.added' && event.item) {
      const idx = typeof event.output_index === 'number' ? event.output_index : byIndex.size;
      ensureSlot(idx, event.item);
      if (event.item.type === 'function_call') argBuffers.set(idx, event.item.arguments || '');
      if (event.item.type === 'message') textBuffers.set(idx, '');
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const idx = typeof event.output_index === 'number' ? event.output_index : 0;
      // obfuscation is tolerated and ignored (protocol notes).
      const prev = argBuffers.get(idx) || '';
      argBuffers.set(idx, prev + (typeof event.delta === 'string' ? event.delta : ''));
      const slot = ensureSlot(idx, { type: 'function_call' });
      slot.arguments = argBuffers.get(idx);
    }

    if (event.type === 'response.function_call_arguments.done') {
      const idx = typeof event.output_index === 'number' ? event.output_index : 0;
      if (typeof event.arguments === 'string') argBuffers.set(idx, event.arguments);
      const slot = ensureSlot(idx, { type: 'function_call' });
      slot.arguments = argBuffers.get(idx) || '';
    }

    if (event.type === 'response.output_text.delta') {
      const idx = typeof event.output_index === 'number' ? event.output_index : 0;
      const delta = typeof event.delta === 'string' ? event.delta : '';
      textBuffers.set(idx, (textBuffers.get(idx) || '') + delta);
      outputText += delta;
      if (streamOutput && delta) {
        process.stdout.write(delta);
        lastStreamed += delta;
      }
      const slot = ensureSlot(idx, { type: 'message', role: 'assistant', content: [] });
      slot.content = [{ type: 'output_text', text: textBuffers.get(idx) }];
    }

    if (event.type === 'response.output_text.done') {
      const idx = typeof event.output_index === 'number' ? event.output_index : 0;
      if (typeof event.text === 'string') {
        textBuffers.set(idx, event.text);
        // Rebuild outputText from buffers if done carries the full string
        // (deltas already appended; only replace when buffers were empty).
      }
      const slot = ensureSlot(idx, { type: 'message', role: 'assistant' });
      const text = textBuffers.get(idx) || '';
      slot.content = [{ type: 'output_text', text }];
    }

    if (event.type === 'response.output_item.done' && event.item) {
      const idx = typeof event.output_index === 'number' ? event.output_index : completed.length;
      // Completed item from the wire is source of truth for that slot.
      let finalItem = { ...event.item };
      if (finalItem.type === 'function_call') {
        const buffered = argBuffers.get(idx);
        if ((!finalItem.arguments || finalItem.arguments === '') && buffered) {
          finalItem.arguments = buffered;
        }
        // Fail-closed parse is available to callers; we keep the string on the item.
      }
      byIndex.set(idx, finalItem);
      // Place into completed at index order (sparse-safe).
      completed[idx] = finalItem;
    }

    if ((event.type === 'response.completed' || event.type === 'response.incomplete') && event.response) {
      responseId = event.response.id || responseId;
      status = event.response.status || status;
      if (event.response.usage) rawUsage = event.response.usage;
    }
  }

  function finish() {
    if (streamOutput && lastStreamed) process.stdout.write('\n');

    // Compact completed list (remove holes) while preserving order.
    const output = [];
    const maxIdx = Math.max(-1, ...byIndex.keys(), completed.length - 1);
    for (let i = 0; i <= maxIdx; i++) {
      const item = completed[i] || byIndex.get(i);
      if (item && item.type) output.push(item);
    }

    // If text deltas arrived but no output_item.done (shouldn't happen on live
    // captures), synthesize a message from the text buffer.
    if (output.length === 0 && outputText) {
      output.push(items.assistantMessage(outputText));
    }

    const usage = items.normalizeUsage(rawUsage);
    const functionCalls = items.extractFunctionCalls(output);
    let stopReason = 'end_turn';
    if (status === 'incomplete') stopReason = 'incomplete';
    else if (functionCalls.length > 0) stopReason = 'tool_use';

    return {
      streamed: true,
      id: responseId,
      status,
      output,
      output_text: outputText || items.extractText(output),
      usage,
      stop_reason: stopReason,
      function_calls: functionCalls,
    };
  }

  return { handleEvent, finish };
}

function resolveUrl(urlOrOpts, opts) {
  // Support both post(body, url, opts) and post(body, opts) shapes.
  if (typeof urlOrOpts === 'string') return { url: urlOrOpts, opts: opts || {} };
  if (urlOrOpts && typeof urlOrOpts === 'object') return { url: urlOrOpts.url, opts: urlOrOpts };
  return { url: undefined, opts: opts || {} };
}

/**
 * @deprecated Claude-lane helper. Kept so older tests that import it don't break.
 * Codex auth is CODEX_ACCESS_TOKEN via transport — not a caller bearer.
 */
function withCallerAuth(headers = {}, _callerToken) {
  return headers;
}

/**
 * Stream one native Responses turn.
 * @param {object} body — Responses request (from createRequest or hand-built)
 * @param {(event: object) => void} [onEvent]
 * @param {string|object} [urlOrOpts]
 * @param {object} [opts]
 */
function postStream(body, onEvent, urlOrOpts, opts) {
  const resolved = resolveUrl(urlOrOpts, opts);
  const options = { streamOutput: false, ...resolved.opts };
  const assembler = createStreamAssembler({ streamOutput: options.streamOutput });

  const transportOpts = {
    url: resolved.url || options.url,
    env: options.env,
    trace: options.trace,
    runId: options.runId,
    turn: options.turn,
    timeoutMs: options.timeoutMs,
  };

  return transport
    .requestStream(
      body,
      (event) => {
        assembler.handleEvent(event);
        if (onEvent) onEvent(event);
      },
      transportOpts,
    )
    .then((transportResult) => {
      const assembled = assembler.finish();
      return {
        ...assembled,
        // Prefer assembler usage (normalized); fall back to transport raw.
        usage:
          assembled.usage.input_tokens || assembled.usage.output_tokens
            ? assembled.usage
            : items.normalizeUsage(transportResult.usage),
        _transport: transportResult._transport,
        events_seen: transportResult.events_seen,
      };
    });
}

/**
 * Buffered one-shot over the streaming-only wire.
 */
function post(body, urlOrOpts, opts) {
  return postStream(body, null, urlOrOpts, opts);
}

module.exports = {
  createRequest,
  mapEffort,
  createStreamAssembler,
  post,
  postStream,
  withCallerAuth,
  EFFORT_MAP,
};
