'use strict';

/**
 * items.js — Phase 3 Stage 2: native Responses item contract.
 *
 * This fork's internal conversation state is a list of OpenAI Responses
 * *input items* (not Anthropic content blocks). Later stages (model-client,
 * run loop, tool-pipeline, compactor, sessions) all code to this module.
 *
 * Item types we use:
 *   - message              role + content parts (input_text / output_text)
 *   - function_call        model asks to run a tool (call_id, name, arguments JSON string)
 *   - function_call_output tool result keyed by call_id (output string; no is_error flag)
 *   - reasoning            opaque; preserve verbatim across turns when present
 *
 * Session schema: schemaVersion 2 + provider "codex". Pre-native (v1 / Anthropic)
 * session files are a clean break — reject resume, leave the file untouched.
 *
 * Wire facts: docs/lab-notes/codex-protocol-notes.md
 * Contract note: docs/lab-notes/items-schema-contract.md
 */

const SCHEMA_VERSION = 2;
const PROVIDER = 'codex';

/** Prefix for failed tool results — Responses has no is_error on function_call_output. */
const TOOL_ERROR_PREFIX = 'ERROR: ';

const ITEM_TYPES = Object.freeze({
  MESSAGE: 'message',
  FUNCTION_CALL: 'function_call',
  FUNCTION_CALL_OUTPUT: 'function_call_output',
  REASONING: 'reasoning',
});

class SessionSchemaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SessionSchemaError';
    this.code = 'session_schema_unsupported';
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMessageItem(item) {
  return isPlainObject(item) && item.type === ITEM_TYPES.MESSAGE && typeof item.role === 'string';
}

function isFunctionCallItem(item) {
  return (
    isPlainObject(item) &&
    item.type === ITEM_TYPES.FUNCTION_CALL &&
    typeof item.call_id === 'string' &&
    typeof item.name === 'string'
  );
}

function isFunctionCallOutputItem(item) {
  return (
    isPlainObject(item) &&
    item.type === ITEM_TYPES.FUNCTION_CALL_OUTPUT &&
    typeof item.call_id === 'string' &&
    typeof item.output === 'string'
  );
}

function isReasoningItem(item) {
  return isPlainObject(item) && item.type === ITEM_TYPES.REASONING;
}

function isInputItem(item) {
  return isMessageItem(item) || isFunctionCallItem(item) || isFunctionCallOutputItem(item) || isReasoningItem(item);
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * User turn as a Responses message item (input_text parts).
 * @param {string} text
 * @returns {object}
 */
function userMessage(text) {
  return {
    type: ITEM_TYPES.MESSAGE,
    role: 'user',
    content: [{ type: 'input_text', text: String(text ?? '') }],
  };
}

/**
 * Assistant text turn. Prefer appending real model output items when available;
 * this helper is for summaries / synthetic text.
 * @param {string} text
 * @returns {object}
 */
function assistantMessage(text) {
  return {
    type: ITEM_TYPES.MESSAGE,
    role: 'assistant',
    content: [{ type: 'output_text', text: String(text ?? '') }],
  };
}

/**
 * Model tool request. `arguments` must be a JSON *string* on the wire.
 * @param {{ callId: string, name: string, arguments?: string|object, id?: string }} opts
 */
function functionCall(opts) {
  if (!opts || typeof opts.callId !== 'string' || !opts.callId) {
    throw new Error('functionCall requires a non-empty callId');
  }
  if (typeof opts.name !== 'string' || !opts.name) {
    throw new Error('functionCall requires a non-empty name');
  }
  let args = opts.arguments;
  if (args === undefined || args === null) args = '{}';
  if (typeof args !== 'string') {
    try {
      args = JSON.stringify(args);
    } catch (err) {
      throw new Error('functionCall arguments could not be JSON-stringified: ' + err.message);
    }
  }
  const item = {
    type: ITEM_TYPES.FUNCTION_CALL,
    call_id: opts.callId,
    name: opts.name,
    arguments: args,
  };
  // Live captures also carry an item id (fc_…) — preserve when known.
  if (typeof opts.id === 'string' && opts.id) item.id = opts.id;
  return item;
}

/**
 * Tool result item. Responses has no is_error flag — failures use TOOL_ERROR_PREFIX.
 * @param {{ callId: string, output: string, isError?: boolean }} opts
 */
function functionCallOutput(opts) {
  if (!opts || typeof opts.callId !== 'string' || !opts.callId) {
    throw new Error('functionCallOutput requires a non-empty callId');
  }
  let output = opts.output === undefined || opts.output === null ? '' : String(opts.output);
  if (opts.isError) {
    if (!output.startsWith(TOOL_ERROR_PREFIX)) output = TOOL_ERROR_PREFIX + output;
  }
  return {
    type: ITEM_TYPES.FUNCTION_CALL_OUTPUT,
    call_id: opts.callId,
    output,
  };
}

/**
 * Preserve a reasoning item verbatim (ids, encrypted_content, status, order).
 * Returns a shallow clone so callers can append without mutating the source.
 * @param {object} raw
 */
function reasoningItem(raw) {
  if (!isPlainObject(raw) || raw.type !== ITEM_TYPES.REASONING) {
    throw new Error('reasoningItem requires a reasoning-typed object');
  }
  return { ...raw };
}

/**
 * Clone any completed output item for history replay (message / function_call / reasoning).
 * Prefer this over reconstructing shapes by hand.
 */
function cloneItem(item) {
  if (!isPlainObject(item)) throw new Error('cloneItem requires an object');
  return JSON.parse(JSON.stringify(item));
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function partText(part) {
  if (!isPlainObject(part)) return '';
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    return typeof part.text === 'string' ? part.text : '';
  }
  return '';
}

/**
 * Concatenate text from message items in an item list (or a single message).
 * @param {object[]|object} itemsOrMessage
 * @returns {string}
 */
function extractText(itemsOrMessage) {
  if (isMessageItem(itemsOrMessage)) {
    const content = Array.isArray(itemsOrMessage.content) ? itemsOrMessage.content : [];
    return content.map(partText).filter(Boolean).join('\n');
  }
  if (!Array.isArray(itemsOrMessage)) return '';
  const chunks = [];
  for (const item of itemsOrMessage) {
    if (!isMessageItem(item)) continue;
    const text = extractText(item);
    if (text) chunks.push(text);
  }
  return chunks.join('\n');
}

/**
 * @param {object[]} items
 * @returns {object[]} function_call items in order
 */
function extractFunctionCalls(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(isFunctionCallItem);
}

/**
 * @param {object[]} items
 * @returns {object[]} reasoning items in order
 */
function extractReasoningItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(isReasoningItem);
}

/**
 * Parse function_call.arguments fail-closed.
 * Never returns an empty object for malformed JSON (that would execute a tool with {}).
 * @param {object} item
 * @returns {{ ok: true, value: object } | { ok: false, error: string, value: null }}
 */
function parseFunctionCallArguments(item) {
  if (!isFunctionCallItem(item)) {
    return { ok: false, error: 'not a function_call item', value: null };
  }
  const raw = item.arguments;
  if (typeof raw !== 'string') {
    return { ok: false, error: 'arguments must be a JSON string', value: null };
  }
  try {
    const value = JSON.parse(raw);
    if (!isPlainObject(value) || Array.isArray(value)) {
      return { ok: false, error: 'arguments JSON must be an object', value: null };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: 'malformed arguments JSON: ' + err.message, value: null };
  }
}

/**
 * True when a function_call_output string was built as an error result.
 * @param {string} output
 */
function isToolErrorOutput(output) {
  return typeof output === 'string' && output.startsWith(TOOL_ERROR_PREFIX);
}

// ---------------------------------------------------------------------------
// Tool definitions (request-build mapping; tool files keep input_schema for now)
// ---------------------------------------------------------------------------

/**
 * Map a runner tool definition ({ name, description, input_schema }) to a
 * native Responses function tool. Does not mutate the source.
 * @param {object} tool
 */
function toNativeToolDefinition(tool) {
  if (!tool || typeof tool.name !== 'string') {
    throw new Error('toNativeToolDefinition requires a tool with a name');
  }
  const parameters = tool.parameters || tool.input_schema || { type: 'object', properties: {} };
  return {
    type: 'function',
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters,
  };
}

// ---------------------------------------------------------------------------
// Usage normalization (Responses → runner-friendly fields)
// ---------------------------------------------------------------------------

/**
 * @param {object} usage — Responses usage object from response.completed
 * @returns {{ input_tokens: number, output_tokens: number, cache_read_input_tokens: number, cache_creation_input_tokens: number, reasoning_tokens: number }}
 */
function normalizeUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const inputDetails = u.input_tokens_details || {};
  const outputDetails = u.output_tokens_details || {};
  return {
    input_tokens: Number(u.input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    // Live captures may include cache_write_tokens: 0 — ignore for billing.
    cache_read_input_tokens: Number(inputDetails.cached_tokens) || 0,
    cache_creation_input_tokens: 0,
    reasoning_tokens: Number(outputDetails.reasoning_tokens) || 0,
  };
}

// ---------------------------------------------------------------------------
// Session schema (v2 clean break)
// ---------------------------------------------------------------------------

/**
 * Empty native session document used by SessionStore (wired in Stage 5).
 * @param {string} [sessionId]
 * @param {object} [overrides]
 */
function createNativeSession(sessionId, overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    provider: PROVIDER,
    sessionId: sessionId || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Native conversation history — Responses input items, not Anthropic messages.
    items: [],
    runner: {
      undoLog: [],
      consecutiveToolFailures: 0,
      activeTaskIds: [],
      tasks: [],
      compactionGeneration: 0,
      flags: {},
    },
    metadata: {
      cwd: null,
      model: null,
      familyId: null,
      forkedFrom: null,
      forkTurn: null,
    },
    ...overrides,
  };
}

/**
 * Detect pre-native / Anthropic-shaped session files.
 * @param {object} data
 */
function isLegacySession(data) {
  if (!isPlainObject(data)) return true;
  const version = Number(data.schemaVersion) || 0;
  if (version > 0 && version < SCHEMA_VERSION) return true;
  if (data.provider && data.provider !== PROVIDER) return true;
  // v1 sessions used `messages` with Anthropic content blocks.
  if (Array.isArray(data.messages) && !Array.isArray(data.items)) return true;
  if (Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      if (!isPlainObject(msg) || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && (block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'thinking')) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Assert a loaded session document is native schema v2.
 * On failure: throw SessionSchemaError. Never mutates or deletes the file.
 * @param {object} data
 */
function assertNativeSession(data) {
  if (!isPlainObject(data)) {
    throw new SessionSchemaError('Session file is not a JSON object.', { schemaVersion: null });
  }
  if (isLegacySession(data)) {
    throw new SessionSchemaError(
      'This session was saved before the Codex native Responses rewrite (schema v' +
        SCHEMA_VERSION +
        ') and cannot be resumed. Start a new session (omit --continue / use --new-session). ' +
        'The old session file was left untouched.',
      {
        schemaVersion: data.schemaVersion ?? null,
        provider: data.provider ?? null,
        expectedSchemaVersion: SCHEMA_VERSION,
        expectedProvider: PROVIDER,
      },
    );
  }
  if (Number(data.schemaVersion) !== SCHEMA_VERSION) {
    throw new SessionSchemaError(
      'Unsupported session schemaVersion ' +
        data.schemaVersion +
        ' (expected ' +
        SCHEMA_VERSION +
        '). Start a new session; the file was left untouched.',
      {
        schemaVersion: data.schemaVersion ?? null,
        expectedSchemaVersion: SCHEMA_VERSION,
      },
    );
  }
  if (!Array.isArray(data.items)) {
    throw new SessionSchemaError('Native sessions require an items array.', {
      schemaVersion: data.schemaVersion,
    });
  }
  return data;
}

/**
 * Map native function_call items → pipeline toolUses ({ id, name, input }).
 * Fail-closed: malformed arguments become an empty input with _parseError set
 * so the pipeline can still emit an error result instead of executing {}.
 * @param {object[]} functionCallItems
 * @returns {object[]}
 */
function functionCallsToPipelineToolUses(functionCallItems) {
  if (!Array.isArray(functionCallItems)) return [];
  return functionCallItems.map((fc) => {
    const parsed = parseFunctionCallArguments(fc);
    return {
      id: fc.call_id,
      name: fc.name,
      input: parsed.ok ? parsed.value : {},
      _parseError: parsed.ok ? null : parsed.error,
      _nativeItem: fc,
    };
  });
}

/**
 * Map pipeline toolResults ({ tool_use_id, content, is_error }) → function_call_output items.
 * Multimodal content arrays are stringified with a placeholder note (Phase 5 revisit).
 * @param {object[]} toolResults
 * @returns {object[]}
 */
function pipelineResultsToOutputItems(toolResults) {
  if (!Array.isArray(toolResults)) return [];
  return toolResults.map((tr) => {
    let output = '';
    if (typeof tr.content === 'string') {
      output = tr.content;
    } else if (Array.isArray(tr.content)) {
      // Responses function_call_output is a string — degrade multimodal blocks.
      output = tr.content
        .map((block) => {
          if (!block || typeof block !== 'object') return '';
          if (block.type === 'text') return block.text || '';
          return '[unsupported multimodal tool result part: ' + (block.type || 'unknown') + ']';
        })
        .filter(Boolean)
        .join('\n');
    } else if (tr.content !== undefined && tr.content !== null) {
      output = String(tr.content);
    }
    return functionCallOutput({
      callId: tr.tool_use_id,
      output,
      isError: !!tr.is_error,
    });
  });
}

module.exports = {
  SCHEMA_VERSION,
  PROVIDER,
  TOOL_ERROR_PREFIX,
  ITEM_TYPES,
  SessionSchemaError,
  // guards
  isMessageItem,
  isFunctionCallItem,
  isFunctionCallOutputItem,
  isReasoningItem,
  isInputItem,
  // constructors
  userMessage,
  assistantMessage,
  functionCall,
  functionCallOutput,
  reasoningItem,
  cloneItem,
  // extractors
  extractText,
  extractFunctionCalls,
  extractReasoningItems,
  parseFunctionCallArguments,
  isToolErrorOutput,
  // tools / usage
  toNativeToolDefinition,
  normalizeUsage,
  // pipeline boundary adapters (Stage 4/5)
  functionCallsToPipelineToolUses,
  pipelineResultsToOutputItems,
  // session schema
  createNativeSession,
  isLegacySession,
  assertNativeSession,
};
