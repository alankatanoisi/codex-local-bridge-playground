#!/usr/bin/env node
'use strict';

/**
 * codex-transport-smoke.js — Phase 2 live smoke test.
 *
 * Round-trips two calls through src/runner/codex-transport.js against the
 * real Codex backend (the backend is streaming-only, so "one-shot" means the
 * buffered wrapper over the same SSE wire):
 *
 *   1. requestBuffered — one-shot ping, expects a non-empty reply.
 *   2. requestStream   — streamed ping, prints text deltas live.
 *
 * Usage:
 *   export CODEX_ACCESS_TOKEN=<at-… token from the ChatGPT dashboard>
 *   node scripts/codex-transport-smoke.js [--model gpt-5.5]
 *
 * The token is read from the environment by the transport module only; this
 * script never prints it. Exit code 0 = both calls succeeded.
 */

const transport = require('../src/runner/codex-transport');

const modelFlagIndex = process.argv.indexOf('--model');
const MODEL = modelFlagIndex !== -1 ? process.argv[modelFlagIndex + 1] : 'gpt-5.5';

function pingBody(text) {
  return {
    model: MODEL,
    store: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
  };
}

function summarize(label, result) {
  const usage = result.usage || {};
  console.log(
    '[smoke] ' +
      label +
      ' ok — status ' +
      result._transport.status_code +
      ', events ' +
      result.events_seen.length +
      ', input_tokens ' +
      (usage.input_tokens ?? '?') +
      ', output_tokens ' +
      (usage.output_tokens ?? '?') +
      ', cached_tokens ' +
      (usage.input_tokens_details ? usage.input_tokens_details.cached_tokens : '?'),
  );
}

async function main() {
  // Fail fast (and clearly) if the env var is missing.
  transport.resolveAccessToken();

  console.log('[smoke] model: ' + MODEL);
  console.log('[smoke] endpoint: ' + transport.CODEX_RESPONSES_URL);

  // 1. Buffered one-shot call
  const buffered = await transport.requestBuffered(pingBody('Reply with exactly one word: pong'));
  if (!buffered.output_text.trim()) throw new Error('buffered call returned empty output_text');
  console.log('[smoke] buffered reply: ' + buffered.output_text.trim());
  summarize('buffered', buffered);

  // 2. Streamed call with live deltas
  process.stdout.write('[smoke] streamed reply: ');
  const streamed = await transport.requestStream(pingBody('Reply with exactly one word: ping'), (event) => {
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      process.stdout.write(event.delta);
    }
  });
  process.stdout.write('\n');
  if (!streamed.output_text.trim()) throw new Error('streamed call returned empty output_text');
  summarize('streamed', streamed);

  console.log('[smoke] PASS — transport round-trips buffered and streamed calls');
}

main().catch((err) => {
  console.error('[smoke] FAIL — ' + err.message);
  process.exit(1);
});
