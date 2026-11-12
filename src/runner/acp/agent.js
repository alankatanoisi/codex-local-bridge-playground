'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { createConnection, RpcError } = require('./connection');
const { DEFAULT_MODEL, EFFORT_LEVELS, normalizeEffort, validateMaxOutputTokens } = require('../model-controls');
const { scrubObject } = require('../safety');
const { extractText } = require('../items');
const { SessionStore } = require('../session-store');

const MODES = [
  { id: 'ask', name: 'Ask', description: 'Ask before edits' },
  { id: 'plan', name: 'Plan', description: 'Propose edits without applying them' },
  { id: 'code', name: 'Code', description: 'Allow enabled edits without per-edit approval' },
];
function controls(s) {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: s.mode,
      options: MODES.map((m) => ({ value: m.id, name: m.name })),
    },
    {
      id: 'model',
      name: 'Codex model',
      category: 'model',
      type: 'select',
      currentValue: s.model,
      options: [{ value: s.model, name: s.model }],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: s.effort,
      options: ['auto', ...EFFORT_LEVELS].map((value) => ({ value, name: value })),
    },
    {
      id: 'context',
      name: 'Output limit (includes reasoning)',
      category: 'model_config',
      type: 'select',
      currentValue: String(s.maxTokens),
      options: [...new Set([s.maxTokens, 2000, 4096, 8192, 16384, 32768])].map((n) => ({
        value: String(n),
        name: String(n),
      })),
    },
  ];
}
function state(s) {
  return {
    configOptions: controls(s),
    modes: { currentModeId: s.mode, availableModes: MODES },
    models: { currentModelId: s.model, availableModels: [{ modelId: s.model, name: s.model }] },
  };
}
function createAcpAgent({
  input,
  write,
  runFn = require('../run').run,
  sessionDir = path.join(os.homedir(), '.bridge-runner', 'codex-acp'),
  runDefaults = {},
}) {
  let initialized = false,
    active = null;
  const sessions = new Map();
  const connection = createConnection({ input, write, onClose: () => active?.controller.abort() });
  const fail = (message) => {
    throw new RpcError(-32602, message);
  };
  const ready = () => {
    if (!initialized) fail('Initialize the agent first');
  };
  function file(id, suffix) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('Invalid sessionId');
    return path.join(sessionDir, id + suffix);
  }
  function save(s) {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const target = file(s.id, '.acp.json');
    // Rename a complete file into place: an interrupted write cannot leave half JSON.
    fs.writeFileSync(target + '.tmp', JSON.stringify(scrubObject(s)), { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
  }
  function readSavedSession(id, cwd) {
    const saved = JSON.parse(fs.readFileSync(file(id, '.acp.json'), 'utf8'));
    if (!saved || saved.id !== id || saved.cwd !== cwd) fail('Session belongs to a different workspace');
    if (!MODES.some((mode) => mode.id === saved.mode)) fail('Invalid saved session mode');
    if (typeof saved.model !== 'string' || !saved.model.trim()) fail('Invalid saved session model');
    if (!Array.isArray(saved.history)) fail('Invalid saved session history');
    const effort = saved.effort === 'auto' ? 'auto' : normalizeEffort(saved.effort);
    if (!effort) fail('Invalid saved session effort');
    validateMaxOutputTokens(saved.maxTokens);
    return { ...saved, effort };
  }
  function refreshSession(s) {
    // Call this AFTER taking the session lock. Another process may have changed
    // Ask/Plan/Code or an output limit since this interface loaded the session.
    // Reload all supported settings together, not just conversation history.
    const saved = readSavedSession(s.id, s.cwd);
    const keys = ['mode', 'model', 'effort', 'maxTokens'];
    const changed = keys.some((key) => s[key] !== saved[key]);
    const modeChanged = s.mode !== saved.mode;
    for (const key of [...keys, 'history']) s[key] = saved[key];
    return { changed, modeChanged };
  }
  function session(params) {
    ready();
    const s = sessions.get(params.sessionId);
    if (!s) fail('Unknown session');
    return s;
  }
  function setup(params) {
    ready();
    if (active) fail('A prompt is already running');
    // Some clients attach their own tool servers to every session. Opting out
    // ignores those descriptions entirely: no process starts and no URL is fetched.
    if (params.mcpServers?.length && !runDefaults.ignoreClientMcp)
      fail('External MCP servers are not supported; use --ignore-client-mcp to continue without those tools');
    if (params.additionalDirectories?.length) fail('Additional workspace roots are not supported');
    if (typeof params.cwd !== 'string' || !path.isAbsolute(params.cwd)) fail('cwd must be an absolute directory');
    const cwd = fs.realpathSync(params.cwd);
    if (!fs.statSync(cwd).isDirectory()) fail('cwd must be a directory');
    return cwd;
  }
  function update(s, value, remember = true) {
    const clean = scrubObject(value);
    if (remember) {
      s.history.push(clean);
      save(s);
    }
    connection.notify('session/update', { sessionId: s.id, update: clean });
  }
  connection.onMethod('initialize', () => {
    initialized = true;
    return {
      protocolVersion: 1,
      agentInfo: { name: 'codex-local-bridge', title: 'Codex Playground', version: '0.1.0' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    };
  });
  connection.onMethod('session/new', (params) => {
    const cwd = setup(params);
    const s = {
      id: randomUUID(),
      cwd,
      model: runDefaults.model || DEFAULT_MODEL,
      effort: runDefaults.effort || 'auto',
      maxTokens: runDefaults.maxTokens || 2000,
      mode: 'ask',
      history: [],
    };
    save(s);
    sessions.set(s.id, s);
    return { sessionId: s.id, ...state(s) };
  });
  connection.onMethod('session/load', (params) => {
    const cwd = setup(params);
    if (fs.existsSync(file(params.sessionId, '.run.lock'))) fail('Session is in use by another agent process');
    const s = readSavedSession(params.sessionId, cwd);
    const checkpoint = file(s.id, '.state.json');
    if (fs.existsSync(checkpoint)) {
      const saved = new SessionStore(checkpoint).load();
      if (saved.metadata.cwd !== cwd) fail('Checkpoint workspace mismatch');
    }
    sessions.set(s.id, s);
    for (const entry of s.history) update(s, entry, false);
    return state(s);
  });
  function configure(params, id, value) {
    const s = session(params);
    if (active || fs.existsSync(file(s.id, '.run.lock'))) fail('Cannot change configuration during a prompt');
    const lock = file(s.id, '.run.lock');
    let fd;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch {
      fail('Session is in use by another agent process');
    }
    fs.closeSync(fd);
    try {
      // Apply this one requested change to the latest complete saved settings.
      const refreshed = refreshSession(s);
      // Publish the already-saved authority before validating the new choice.
      // Even a rejected choice must not leave the interface showing stale Code.
      if (refreshed.modeChanged) update(s, { sessionUpdate: 'current_mode_update', currentModeId: s.mode }, false);
      if (refreshed.changed) update(s, { sessionUpdate: 'config_option_update', configOptions: controls(s) }, false);
      if (id === 'mode') {
        if (!MODES.some((m) => m.id === value)) fail('Unknown mode');
        s.mode = value;
      } else if (id === 'effort') {
        s.effort = value === 'auto' ? 'auto' : normalizeEffort(value);
        if (!s.effort) fail('Missing effort');
      } else if (id === 'context') s.maxTokens = validateMaxOutputTokens(Number(value));
      else if (id === 'model') {
        if (value !== s.model) fail('Model must be selected in the agent launch settings');
      } else fail('Unknown configuration option');
      save(s);
      if (id === 'mode') update(s, { sessionUpdate: 'current_mode_update', currentModeId: s.mode }, false);
      update(s, { sessionUpdate: 'config_option_update', configOptions: controls(s) }, false);
      return { configOptions: controls(s) };
    } finally {
      fs.unlinkSync(lock);
    }
  }
  connection.onMethod('session/set_config_option', (p) => configure(p, p.configId, p.value));
  connection.onMethod('session/set_mode', (p) => configure(p, 'mode', p.modeId));
  connection.onMethod('session/mode/set', (p) => configure(p, 'mode', p.modeId));
  connection.onMethod('session/set_model', (p) => configure(p, 'model', p.modelId));
  connection.onMethod('cursor/list_available_models', () => ({
    models: [
      {
        value: runDefaults.model || DEFAULT_MODEL,
        name: runDefaults.model || DEFAULT_MODEL,
        configOptions: controls({
          model: runDefaults.model || DEFAULT_MODEL,
          mode: 'ask',
          effort: runDefaults.effort || 'auto',
          maxTokens: runDefaults.maxTokens || 2000,
        }).filter((c) => ['effort', 'context'].includes(c.id)),
      },
    ],
  }));
  connection.onMethod('session/cancel', (p) => {
    session(p);
    if (active?.id === p.sessionId) active.controller.abort();
  });
  connection.onMethod('session/prompt', async (params) => {
    const s = session(params);
    // The inherited runner has process-wide state. Serialize across ALL sessions,
    // not merely within one conversation, until that runner state is isolated.
    if (active) fail('A prompt is already running in this agent process');
    if (
      !Array.isArray(params.prompt) ||
      !params.prompt.length ||
      params.prompt.some((b) => b.type !== 'text' || typeof b.text !== 'string')
    )
      fail('This adapter currently accepts text prompts only');
    const prompt = params.prompt.map((b) => b.text).join('\n');
    // Separate T3 processes may try to load the same conversation. An exclusive
    // per-session lock prevents competing writes to its checkpoint and history.
    const lock = file(s.id, '.run.lock');
    let lockFd;
    try {
      lockFd = fs.openSync(lock, 'wx', 0o600);
    } catch {
      fail('Session is in use by another agent process');
    }
    fs.writeSync(lockFd, String(process.pid));
    fs.closeSync(lockFd);
    const controller = new AbortController();
    active = { id: s.id, controller };
    const checkpoint = file(s.id, '.state.json');
    let shown = '';
    let restored = false;
    try {
      const refreshed = refreshSession(s);
      restored = true;
      // Let the interface display the same current authority the runner uses.
      if (refreshed.modeChanged) update(s, { sessionUpdate: 'current_mode_update', currentModeId: s.mode }, false);
      if (refreshed.changed) update(s, { sessionUpdate: 'config_option_update', configOptions: controls(s) }, false);
      update(s, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } });
      const result = await runFn({
        ...runDefaults,
        cwd: s.cwd,
        prompt,
        model: s.model,
        effort: s.effort === 'auto' ? undefined : s.effort,
        maxTokens: s.maxTokens,
        maxSteps: runDefaults.maxSteps || 32,
        sessionPath: checkpoint,
        resume: fs.existsSync(checkpoint),
        outputFormat: 'silent',
        quiet: true,
        noArchive: true,
        autoMemory: false,
        signal: controller.signal,
        acceptEdits: s.mode === 'code',
        dontAsk: false,
        plan: s.mode === 'plan',
        // Interactive terminal questions have no ACP port yet. Expose only the
        // useful local tools whose behavior is supported by this interface.
        allowedTools: [
          'list_files',
          'read_file',
          'search_text',
          'glob',
          'git_status',
          'edit_file',
          'write_file',
          'apply_patch',
          ...(runDefaults.allowShell ? ['bash'] : []),
        ],
        onEvent(e) {
          if (e.type === 'assistant') {
            const text = e.text || extractText(e.message?.content || []);
            if (text) {
              shown = text;
              update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
            }
          } else if (e.type === 'tool_use')
            update(s, {
              sessionUpdate: 'tool_call',
              toolCallId: e.tool_use_id,
              title: e.name,
              kind: 'other',
              status: 'pending',
              rawInput: e.input,
            });
          else if (e.type === 'tool_result')
            update(s, {
              sessionUpdate: 'tool_call_update',
              toolCallId: e.tool_use_id,
              status: e.is_error ? 'failed' : 'completed',
              rawOutput: e.content,
            });
        },
        confirm: {
          async ask(action, timeoutMs, metadata) {
            try {
              const response = await connection.request(
                'session/request_permission',
                {
                  sessionId: s.id,
                  toolCall: {
                    toolCallId: metadata.tool_use_id,
                    title: action,
                    kind: 'edit',
                    status: 'pending',
                    rawInput: metadata.input,
                  },
                  options: [
                    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                    { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
                  ],
                },
                { signal: controller.signal, timeoutMs: timeoutMs || 120000 },
              );
              return response?.outcome?.outcome === 'selected' && response.outcome.optionId === 'allow-once'
                ? 'allow'
                : 'deny';
            } catch {
              return 'deny';
            }
          },
        },
      });
      if (result.finalText && result.finalText !== shown)
        update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.finalText } });
      if (controller.signal.aborted || result.stopReason === 'cancelled') return { stopReason: 'cancelled' };
      if (result.stopReason === 'success') return { stopReason: 'end_turn' };
      if (
        [
          'max_output_tokens',
          'output_token_budget_exceeded',
          'input_token_budget_exceeded',
          'context_budget_exceeded',
          'predictive_context_budget_exceeded',
          'predictive_input_token_budget_exceeded',
          'predictive_output_token_budget_exceeded',
        ].includes(result.stopReason)
      )
        return { stopReason: 'max_tokens' };
      if (['max_steps', 'max_tool_calls_per_turn'].includes(result.stopReason))
        return { stopReason: 'max_turn_requests' };
      if (result.stopReason === 'model_refusal') return { stopReason: 'refusal' };
      throw new RpcError(-32603, result.finalText || result.stopReason);
    } finally {
      active = null;
      process.exitCode = 0;
      try {
        // If reloading failed, leave that file intact instead of replacing it
        // with the stale in-memory session. The lock is still always released.
        if (restored) save(s);
      } finally {
        fs.unlinkSync(lock);
      }
    }
  });
  return { connection };
}
module.exports = { createAcpAgent };
