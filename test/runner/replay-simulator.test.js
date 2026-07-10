'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SessionLedger } = require('../../src/runner/session-ledger');
const { replayFromLedger } = require('../../src/runner/replay-simulator');
const nativeItems = require('../../src/runner/items');

describe('replay simulator', () => {
  it('reports pending effects as replay issues', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
    const sessionPath = path.join(tmp, 's.state.json');
    const ledger = new SessionLedger(sessionPath);
    ledger.append('session_started', { runId: 'r1' });
    ledger.append('tool_effect_intent', { effectId: 'fx1', tool: 'write_file' });
    const replay = replayFromLedger(sessionPath);
    assert.equal(replay.ok, false);
    assert.ok(replay.issues.some((i) => i.kind === 'pending_effect'));
  });

  it('passes clean ledger with paired events', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-ok-'));
    const sessionPath = path.join(tmp, 's2.state.json');
    const ledger = new SessionLedger(sessionPath);
    ledger.append('user_prompt', { prompt: 'x' });
    ledger.append('run_stopped', { stopReason: 'success' });
    const replay = replayFromLedger(sessionPath);
    assert.equal(replay.ok, true);
  });

  it('replays native function-call items and their outputs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-native-'));
    const sessionPath = path.join(tmp, 'native.state.json');
    const ledger = new SessionLedger(sessionPath);
    ledger.append('assistant_items', {
      items: [nativeItems.functionCall({ callId: 'call_1', name: 'list_files', arguments: '{}' })],
    });
    ledger.append('function_call_outputs', {
      items: [nativeItems.functionCallOutput({ callId: 'call_1', output: 'README.md' })],
    });

    const replay = replayFromLedger(sessionPath);
    assert.equal(replay.ok, true);
    assert.equal(replay.itemsEstimate, 2);
    assert.ok(replay.events.every((event) => event.provider === 'codex'));
  });
});
