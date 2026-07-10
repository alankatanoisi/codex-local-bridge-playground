#!/usr/bin/env node
'use strict';

/**
 * capture-codex-fixture.js — Phase 3 live SSE fixture capture helper.
 *
 * Records a redacted SSE stream from the real Codex backend via codex-transport.js.
 * Run on Alan's capture machine with CODEX_ACCESS_TOKEN set. Never commit output
 * until the built-in leak-grep reports 0 hits.
 *
 * Usage:
 *   export CODEX_ACCESS_TOKEN=<at-… token>
 *   node scripts/capture-codex-fixture.js --preset function-call --out test/runner/fixtures/codex/responses-stream-function-call.sse
 *   node scripts/capture-codex-fixture.js --preset final-answer --out test/runner/fixtures/codex/responses-stream-final-answer.sse
 *   node scripts/capture-codex-fixture.js --preset pong --out /tmp/pong.sse
 *
 * Options:
 *   --preset <name>   pong | function-call | final-answer (default: pong)
 *   --out <path>      output file (required)
 *   --model <id>      default gpt-5.5
 *   --effort <level>  reasoning.effort (default: medium)
 *   --dry-run         print request summary only, no network
 */

const fs = require('node:fs');
const path = require('node:path');

const transport = require('../src/runner/codex-transport');
const safety = require('../src/runner/safety');

const LEAK_PATTERNS = [
  /\bat-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /"safety_identifier"\s*:\s*"user-(?!\[REDACTED)[^"]+"/g,
  /"prompt_cache_key"\s*:\s*"[0-9a-f-]{36}"/gi,
];

const LIST_FILES_TOOL = {
  type: 'function',
  name: 'list_files',
  description: 'List files and directories at a path within the workspace.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace (default: .)' },
    },
    additionalProperties: false,
  },
};

function parseArgs(argv) {
  const opts = { preset: 'pong', model: 'gpt-5.5', effort: 'medium', dryRun: false, out: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--preset') opts.preset = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--effort') opts.effort = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 20).join('\n'));
      process.exit(0);
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }
  if (!opts.out) throw new Error('--out <path> is required');
  return opts;
}

function baseRequest(model, effort) {
  return {
    model,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort },
  };
}

function presetBody(preset, model, effort) {
  const base = baseRequest(model, effort);
  if (preset === 'pong') {
    return {
      ...base,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly one word: pong' }] }],
    };
  }
  if (preset === 'function-call') {
    return {
      ...base,
      tool_choice: 'auto',
      tools: [LIST_FILES_TOOL],
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'List the files in the current directory using list_files. Do not explain.' }],
        },
      ],
    };
  }
  if (preset === 'final-answer') {
    return {
      ...base,
      tool_choice: 'auto',
      tools: [LIST_FILES_TOOL],
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'List the files in the current directory using list_files.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_fixture_list_files',
          name: 'list_files',
          arguments: '{"path":"."}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_fixture_list_files',
          output: 'README.md\npackage.json\nsrc/\ntest/',
        },
      ],
    };
  }
  throw new Error('Unknown preset: ' + preset + ' (expected pong, function-call, final-answer)');
}

/**
 * Redact sensitive fields from raw SSE text before writing fixtures.
 * Exported for unit tests.
 */
function redactFixtureText(raw) {
  let text = String(raw || '');
  text = text.replace(/"safety_identifier"\s*:\s*"user-[^"]+"/g, '"safety_identifier":"user-[REDACTED-ID]"');
  text = text.replace(/"prompt_cache_key"\s*:\s*"[0-9a-f-]{36}"/gi, '"prompt_cache_key":"[REDACTED-UUID]"');
  text = safety.scrubSecrets(text);
  return text;
}

/**
 * Count leak-pattern hits. Returns { ok, hits: [{ pattern, count }] }.
 */
function leakGrep(text) {
  const hits = [];
  for (const pattern of LEAK_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      hits.push({ pattern: pattern.source, count: matches.length });
    }
  }
  return { ok: hits.length === 0, hits };
}

function formatSseFrame(event) {
  return 'event: ' + (event.type || 'message') + '\n' + 'data: ' + JSON.stringify(event) + '\n\n';
}

async function capture(body) {
  const frames = [];
  const result = await transport.requestStream(body, (event) => {
    frames.push(formatSseFrame(event));
  });
  return { frames: frames.join(''), result };
}

async function main() {
  const opts = parseArgs(process.argv);
  const body = presetBody(opts.preset, opts.model, opts.effort);

  console.log('[capture] preset: ' + opts.preset);
  console.log('[capture] model: ' + opts.model);
  console.log('[capture] effort: ' + opts.effort);
  console.log('[capture] out: ' + opts.out);

  if (opts.dryRun) {
    console.log('[capture] dry-run request summary:', JSON.stringify(transport.codexBodySummary(body), null, 2));
    return;
  }

  transport.resolveAccessToken();

  const { frames, result } = await capture(body);
  const redacted = redactFixtureText(frames);
  const leak = leakGrep(redacted);

  if (!leak.ok) {
    console.error('[capture] REFUSED — leak-grep found sensitive patterns:');
    for (const hit of leak.hits) console.error('  ' + hit.pattern + ': ' + hit.count + ' hit(s)');
    process.exit(2);
  }

  const outPath = path.resolve(opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, redacted, 'utf8');

  console.log('[capture] events: ' + result.events_seen.length);
  console.log('[capture] event types: ' + [...new Set(result.events_seen)].join(', '));
  console.log('[capture] output_text bytes: ' + (result.output_text || '').length);
  console.log('[capture] leak-grep: 0 hits — safe to commit after review');
  console.log('[capture] wrote ' + outPath);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[capture] FAIL — ' + err.message);
    process.exit(1);
  });
}

module.exports = {
  redactFixtureText,
  leakGrep,
  presetBody,
  LEAK_PATTERNS,
};
