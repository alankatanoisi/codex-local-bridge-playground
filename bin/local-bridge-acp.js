#!/usr/bin/env node
'use strict';

// Standard output belongs exclusively to ACP. Any inherited console output
// goes to diagnostics instead, before loading code that might print messages.
const wireWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => process.stderr.write(...args);
const { parseArgs } = require('util');
const path = require('path');
const { createAcpAgent } = require('../src/runner/acp/agent');
const { normalizeEffort, validateMaxOutputTokens } = require('../src/runner/model-controls');
const { scrubSecrets } = require('../src/runner/safety');
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: 'string' },
      'host-state-dir': { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'max-tokens': { type: 'string' },
      'max-steps': { type: 'string' },
      'session-dir': { type: 'string' },
      'trust-workspace': { type: 'boolean' },
      'allow-shell': { type: 'boolean' },
      'ignore-client-mcp': { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
  });
  if (positionals.some((value) => value !== 'acp') || positionals.length > 1)
    throw new Error('Only the optional acp subcommand is supported');
  if (values.help || values.version) {
    console.error(
      values.version
        ? 'codex-local-bridge-acp 0.1.0'
        : 'Codex ACP agent. Options: --host direct|standalone, --host-state-dir, --model, --effort, --max-tokens, --max-steps, --session-dir, --trust-workspace, --allow-shell, --ignore-client-mcp.\nDefault: ask before edits; shell disabled; 32 model steps per prompt. CODEX_ACCESS_TOKEN must be supplied in the process environment.',
    );
  } else {
    const runDefaults = {
      trustWorkspace: !!values['trust-workspace'],
      allowShell: !!values['allow-shell'],
      ignoreClientMcp: !!values['ignore-client-mcp'],
    };
    if (values.host && !['direct', 'standalone'].includes(values.host))
      throw new Error('--host must be direct or standalone');
    if (values.host === 'standalone')
      runDefaults.transportEnv = require('../src/hosting/state').clientEnvironment(values['host-state-dir']);
    if (values.model) runDefaults.model = values.model;
    if (values.effort) runDefaults.effort = normalizeEffort(values.effort);
    if (values['max-tokens']) runDefaults.maxTokens = validateMaxOutputTokens(Number(values['max-tokens']));
    if (values['max-steps']) {
      const count = Number(values['max-steps']);
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error('--max-steps must be a positive integer');
      runDefaults.maxSteps = count;
    }
    if (values['session-dir'] && !path.isAbsolute(values['session-dir']))
      throw new Error('--session-dir must be absolute');
    const agent = createAcpAgent({
      input: process.stdin,
      write: wireWrite,
      sessionDir: values['session-dir'],
      runDefaults,
    });
    // Disconnect cancels outstanding work. The runner then closes its own
    // current model request and records any already completed local effects.
    process.on('SIGTERM', () => agent.connection.close());
    process.on('SIGINT', () => agent.connection.close());
    process.stdin.resume();
  }
} catch (err) {
  console.error(scrubSecrets(err.message));
  process.exitCode = 1;
}
