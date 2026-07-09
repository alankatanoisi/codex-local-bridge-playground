'use strict';

/**
 * codex-transport.js — Phase 2 transport: direct token client for the Codex
 * backend. This module owns exactly one concern: moving bytes between the
 * runner and `POST https://chatgpt.com/backend-api/codex/responses`.
 *
 * It does NOT translate between the Responses API dialect and the runner's
 * internal Anthropic-block dialect — that is the Phase 3 adapter's job. The
 * transport hands back raw Responses SSE events plus a small amount of
 * assembled convenience state (output text, final response, usage).
 *
 * Contract (pinned in docs/lab-notes/codex-protocol-notes.md):
 *   - Auth: `Authorization: Bearer $CODEX_ACCESS_TOKEN` — the env var is the
 *     only sanctioned token source. Never read ~/.codex/auth.json.
 *   - The backend is streaming-only: `stream: false` is rejected upstream, so
 *     this module has one wire path (SSE) and `requestBuffered()` is just the
 *     streaming path with collection instead of a callback.
 *   - `max_output_tokens` is rejected upstream ("Unsupported parameter");
 *     fail fast locally with a clear message.
 *
 * Safety invariants:
 *   - The token never appears in errors, trace events, or return values.
 *   - Anything that could echo upstream text into an error message passes
 *     through safety.scrubSecrets() first.
 *   - Flight-recorder trace events record header NAMES only, never values
 *     (trace-utils.headerSummary), mirroring the runner's request-boundary
 *     pattern from run.js.
 */

const http = require('http');
const https = require('https');
const safety = require('./safety');
const { headerSummary, bytes, sha256 } = require('../trace-utils');

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const TOKEN_ENV_VAR = 'CODEX_ACCESS_TOKEN';
const REQUEST_TIMEOUT_MS = 120000;

// Keep-alive agents so multi-turn runs reuse the TLS/TCP connection.
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });

/**
 * Resolve the access token from the environment. The env var is the only
 * sanctioned source in this repo (no keychain, no ~/.codex/auth.json, no
 * interception). Throws a descriptive error that never includes token bytes.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function resolveAccessToken(env = process.env) {
  const token = (env[TOKEN_ENV_VAR] || '').trim();
  if (!token) {
    throw new Error(
      TOKEN_ENV_VAR +
        ' is not set. Create a ChatGPT Business programmatic access token (at-…) in the dashboard and export it: ' +
        'export ' +
        TOKEN_ENV_VAR +
        '=<token>',
    );
  }
  return token;
}

/**
 * Validate and normalize an outgoing request body against the pinned
 * protocol contract. Returns a shallow copy with `stream: true` set.
 * Throws (before any network I/O) on shapes the backend is known to reject.
 */
function normalizeRequestBody(body) {
  if (!body || typeof body !== 'object') throw new Error('Request body must be an object');
  if (body.stream === false) {
    throw new Error('Codex backend is streaming-only: stream:false is rejected upstream. Omit stream or use true.');
  }
  if ('max_output_tokens' in body) {
    throw new Error(
      'max_output_tokens is an unsupported parameter on the Codex backend. ' +
        'Output budgets stay a runner-side concern (budget tracker).',
    );
  }
  return { ...body, stream: true };
}

/**
 * Codex-shaped body summary for trace events (the Anthropic-shaped
 * trace-utils.bodySummary expects system/messages/tools and does not fit
 * Responses `input` items). Structural metadata only — no payload text.
 */
function codexBodySummary(body) {
  const inputItems = Array.isArray(body.input) ? body.input : [];
  const itemTypes = {};
  for (const item of inputItems) {
    const type = item && item.type ? item.type : 'unknown';
    itemTypes[type] = (itemTypes[type] || 0) + 1;
  }
  return {
    model: body.model || null,
    stream: !!body.stream,
    store: body.store === undefined ? null : !!body.store,
    input_items: inputItems.length,
    input_item_types: itemTypes,
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    bytes: bytes(body),
    body_sha256: sha256(JSON.stringify(body)),
  };
}

function scrubbedError(prefix, rawText) {
  return new Error(prefix + safety.scrubSecrets(String(rawText || '')).slice(0, 500));
}

/**
 * Stream one Responses API call. Parses SSE frames and calls
 * `onEvent(event)` with each parsed `data:` JSON object (they carry `type`).
 *
 * @param {object} body — Responses API request body (stream forced to true)
 * @param {(event: object) => void} [onEvent]
 * @param {object} [opts]
 * @param {string} [opts.url]      — override endpoint (tests use a local http server)
 * @param {object} [opts.env]      — env source for the token (default process.env)
 * @param {object} [opts.trace]    — JsonlTrace-like sink for request boundaries
 * @param {string} [opts.runId]
 * @param {number} [opts.turn]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{streamed: true, response: object|null, output_text: string, usage: object, events_seen: string[], _transport: object}>}
 */
function requestStream(body, onEvent, opts = {}) {
  const token = resolveAccessToken(opts.env);
  const normalized = normalizeRequestBody(body);
  const url = opts.url || CODEX_RESPONSES_URL;
  const trace = opts.trace || null;
  const timeoutMs = opts.timeoutMs || REQUEST_TIMEOUT_MS;
  const bodyStr = JSON.stringify(normalized);

  const reqUrl = new URL(url);
  const isHttps = reqUrl.protocol === 'https:';
  const requestHeaders = {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(bodyStr),
    accept: 'text/event-stream',
  };

  if (trace) {
    trace.append('codex_request_started', {
      run_id: opts.runId,
      turn: opts.turn,
      url: reqUrl.origin + reqUrl.pathname,
      method: 'POST',
      // Names only — never header values. The token must not reach the trace.
      request_headers: headerSummary(requestHeaders),
      body: codexBodySummary(normalized),
    });
  }

  return new Promise((resolve, reject) => {
    const fail = (err) => {
      if (trace) {
        trace.append('codex_request_failed', {
          run_id: opts.runId,
          turn: opts.turn,
          message: safety.scrubSecrets(err.message),
        });
      }
      reject(err);
    };

    const requestOptions = {
      hostname: reqUrl.hostname,
      port: reqUrl.port || (isHttps ? 443 : 80),
      path: reqUrl.pathname + reqUrl.search,
      method: 'POST',
      headers: requestHeaders,
      timeout: timeoutMs,
      agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
    };

    const req = (isHttps ? https : http).request(requestOptions, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          fail(
            scrubbedError(
              'Codex backend returned HTTP ' + res.statusCode + ': ',
              Buffer.concat(chunks).toString('utf8'),
            ),
          );
        });
        return;
      }

      let buffer = '';
      let outputText = '';
      let finalResponse = null;
      let usage = {};
      const eventsSeen = [];

      const handleFrame = (frame) => {
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length === 0) return;
        const data = dataLines.join('\n');
        if (data === '[DONE]') return;

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          return; // partial or malformed frame — ignore, same as the bridge client
        }

        if (event && event.type) eventsSeen.push(event.type);

        // Assemble convenience state. `obfuscation` on delta events is
        // deliberately ignored per the Phase 0 protocol notes.
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          outputText += event.delta;
        }
        if ((event.type === 'response.completed' || event.type === 'response.incomplete') && event.response) {
          finalResponse = event.response;
          if (event.response.usage) usage = event.response.usage;
        }
        if (event.type === 'response.failed' || event.type === 'error') {
          const detail = (event.response && event.response.error) || event.error || event;
          fail(scrubbedError('Codex backend reported a failed response: ', JSON.stringify(detail)));
          return;
        }

        if (onEvent) onEvent(event);
      };

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || ''; // keep incomplete frame in the buffer
        for (const frame of parts) handleFrame(frame);
      });

      res.on('end', () => {
        if (buffer.trim()) handleFrame(buffer);

        const meta = {
          status_code: res.statusCode,
          // Names only — response headers can carry cookies and identifiers.
          response_headers: headerSummary(res.headers),
        };
        if (trace) {
          trace.append('codex_response_completed', {
            run_id: opts.runId,
            turn: opts.turn,
            status_code: res.statusCode,
            response_headers: meta.response_headers,
            events_count: eventsSeen.length,
            event_types: [...new Set(eventsSeen)],
            output_text_bytes: bytes(outputText),
            response_id: (finalResponse && finalResponse.id) || null,
            usage,
          });
        }
        resolve({
          streamed: true,
          response: finalResponse,
          output_text: outputText,
          usage,
          events_seen: eventsSeen,
          _transport: meta,
        });
      });

      res.on('error', (err) => fail(scrubbedError('Stream error: ', err.message)));
    });

    req.on('error', (err) => fail(scrubbedError('Request error: ', err.message)));
    req.on('timeout', () => {
      req.destroy();
      fail(new Error('Request timed out after ' + timeoutMs + 'ms'));
    });

    req.write(bodyStr);
    req.end();
  });
}

/**
 * "One-shot" call over the streaming-only wire: streams internally, resolves
 * with the fully assembled result and no per-event callback. This is the
 * buffered `post()` equivalent for this lane.
 */
function requestBuffered(body, opts = {}) {
  return requestStream(body, null, opts);
}

module.exports = {
  CODEX_RESPONSES_URL,
  TOKEN_ENV_VAR,
  REQUEST_TIMEOUT_MS,
  resolveAccessToken,
  normalizeRequestBody,
  codexBodySummary,
  requestStream,
  requestBuffered,
};
