'use strict';
// Each attempt runs in a separate process so a stuck runner can be stopped
// by the parent without losing the rest of the evaluation.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const source = path.resolve(__dirname, '../..', 'source');
const { run } = require(path.join(source, 'src/runner/run'));
const { clientEnvironment } = require(path.join(source, 'src/hosting/state'));
const started = performance.now();
const events = [], requests = [], approvals = [], tools = [];
const controller = new AbortController();
let server, calls = 0, requestStart, openTools = new Map();
const text = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] });
const call = (name, args, id = 'call_eval') => ({ type: 'function_call', name, call_id: id, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
function send(res, output, incomplete = false, usage = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [output_index, item] of output.entries()) res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index, item }) + '\n\n');
  res.end('data: ' + JSON.stringify({ type: incomplete ? 'response.incomplete' : 'response.completed', response: { id: 'resp_eval', status: incomplete ? 'incomplete' : 'completed', output, incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null, usage: { input_tokens: 100, output_tokens: 20, ...usage } } }) + '\n\n');
}
(async () => {
  let transportEnv, bridgeUrl;
  if (spec.mode === 'mock') {
    // Synthetic credentials only: these never authenticate to an external host.
    transportEnv = { CODEX_ACCESS_TOKEN: 'at-offline-evaluation-not-a-real-token' };
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', part => body += part);
      req.on('end', () => {
        const parsed = JSON.parse(body); calls++;
        // Store sizes and item counts, not raw request bodies or credentials.
        requests.push({ bytes: Buffer.byteLength(body), input_bytes: Buffer.byteLength(JSON.stringify(parsed.input)), input_items: parsed.input.length, max_output_tokens: parsed.max_output_tokens, model: parsed.model, effort: parsed.reasoning?.effort });
        const name = spec.scenario;
        if (name === 'cancel-stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"type":"response.created"}\n\n');
          setTimeout(() => controller.abort(), 30); return;
        }
        if (['context-diverse', 'context-budget'].includes(name)) return send(res, calls < 5 ? [call('read_file', { path: 'chunk' + calls + '.txt' }, 'ctx_' + calls)] : [text('done')], false, { input_tokens: calls * 1000 });
        if (name === 'context') return send(res, calls < 5 ? [call('list_files', { path: '.' }, 'ctx_' + calls)] : [text('done')], false, { input_tokens: calls * 1000 });
        if (name === 'retry-400') { res.writeHead(400); return res.end('{"error":"deterministic invalid request"}'); }
        if (calls > 1) return send(res, [text('done')]);
        if (name === 'deny-write') return send(res, [call('write_file', { path: 'target.txt', content: 'forbidden' })]);
        if (name === 'tool-failure') return send(res, [call('read_file', { path: 'missing.txt' })]);
        if (name === 'incomplete-tool') return send(res, [call('write_file', '{"path":"target.txt","content":')], true);
        if (name === 'small-output') return send(res, [text('partial')], true);
        if (name === 'cancel-tools') return send(res, [call('write_file', { path: 'a.txt', content: 'a' }, 'a'), call('write_file', { path: 'b.txt', content: 'b' }, 'b')]);
        return send(res, [text('done')]);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    bridgeUrl = 'http://127.0.0.1:' + server.address().port + '/responses';
  } else {
    // This function reads only the local host connection, never the upstream token.
    transportEnv = clientEnvironment(spec.stateDir);
  }
  const options = {
    cwd: spec.cwd, prompt: spec.prompt || 'Perform the bounded evaluation.', model: 'gpt-6.1-sol', effort: 'low',
    maxTokens: spec.scenario === 'small-output' ? 16 : 4000, maxSteps: spec.scenario === 'retry-400' ? 3 : 8,
    budgetOutputTokens: 32000, maxCostUsd: 2, maxWallClockMs: 175000,
    maxContextTokens: spec.maxContextTokens, bare: true, quiet: true, skipTrustGate: true, noArchive: true, autoMemory: false,
    outputFormat: 'silent', sessionPath: spec.sessionPath, resume: !!spec.resume,
    bridgeUrl, transportEnv, signal: controller.signal,
    allowedTools: spec.allowedTools || ['list_files', 'read_file', 'write_file'],
    allowShell: !!spec.allowShell, acceptEdits: spec.scenario === 'cancel-tools',
    confirm: { ask(_action, _timeout, metadata) {
      const t = performance.now();
      // Approvals are narrow: one intended file or one exact test command.
      const input = metadata.input || {};
      const allowed = spec.scenario !== 'deny-write' && ((metadata.name === 'write_file' && input.path === 'target.js') || (metadata.name === 'bash' && input.command === 'node test.cjs'));
      approvals.push({ name: metadata.name, path: input.path || null, command: input.command || null, decision: allowed ? 'allow' : 'deny', delay_ms: performance.now() - t });
      return allowed ? 'allow' : 'deny';
    } },
    onEvent(event) {
      const t = performance.now() - started;
      events.push({ type: event.type, t_ms: t, step: event.step, name: event.name, is_error: event.is_error });
      if (event.type === 'model_request') requestStart = t;
      if (event.type === 'assistant') {
        const record = { duration_ms: t - requestStart, usage: event.message?.usage || event.usage || null };
        // Observer timing includes response parsing; it is not first-token latency.
        tools.push({ kind: 'model', ...record });
      }
      if (event.type === 'tool_use') {
        openTools.set(event.tool_use_id, t);
        tools.push({ kind: 'tool', name: event.name, signature: crypto.createHash('sha256').update(JSON.stringify([event.name, event.input])).digest('hex'), command: event.name === 'bash' ? event.input?.command : undefined });
      }
      if (event.type === 'tool_result') {
        const record = [...tools].reverse().find(item => item.kind === 'tool' && item.name === event.name && item.duration_ms === undefined);
        if (record) { record.duration_ms = t - openTools.get(event.tool_use_id); record.is_error = !!event.is_error; }
        if (spec.scenario === 'cancel-tools' && event.tool_use_id === 'a') controller.abort();
      }
    },
  };
  const result = await run(options);
  const checkpoint = fs.existsSync(spec.sessionPath) ? JSON.parse(fs.readFileSync(spec.sessionPath, 'utf8')) : null;
  const summary = { id: spec.id, mode: spec.mode, scenario: spec.scenario, elapsed_ms: performance.now() - started, stop_reason: result.stopReason, steps: result.steps, final_text: result.finalText, usage: result.usage, reference_cost_usd: result.usageSummary?.costUsd, requests, events, tools, approvals, checkpoint: checkpoint ? { schemaVersion: checkpoint.schemaVersion, provider: checkpoint.provider, item_count: checkpoint.items?.length, function_calls: checkpoint.items?.filter(i => i.type === 'function_call').length } : null, settings: { model: options.model, effort: options.effort, maxTokens: options.maxTokens, maxSteps: options.maxSteps, budgetOutputTokens: options.budgetOutputTokens, maxCostUsd: options.maxCostUsd, bare: true, allowShell: options.allowShell } };
  fs.writeFileSync(spec.output, JSON.stringify(summary, null, 2));
})().catch(error => {
  // Keep error details local and scrub through the runner's own redactor.
  const { scrubSecrets } = require(path.join(source, 'src/runner/safety'));
  fs.writeFileSync(spec.output, JSON.stringify({ id: spec.id, mode: spec.mode, scenario: spec.scenario, error: scrubSecrets(error.message), elapsed_ms: performance.now() - started }));
}).finally(() => {
  server?.closeAllConnections(); server?.close();
  process.exitCode = 0;
});
