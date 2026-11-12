'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { STOP_REASONS } = require('../../src/runner/kernel/contract');
const { SessionStore } = require('../../src/runner/session-store');
const health = require('../../src/runner/session-health');

describe('session health', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-'));

  it('marks degraded stop reasons', () => {
    const h = health.buildHealth({ stopReason: STOP_REASONS.MAX_STEPS, compactionGeneration: 0 });
    assert.equal(h.degraded, true);
    assert.ok(h.reasons.includes(STOP_REASONS.MAX_STEPS));
    assert.equal(h.recommendation, health.RECOMMENDATIONS.FRESH_SESSION);
  });

  it('marks success as resume_ok', () => {
    const h = health.buildHealth({ stopReason: STOP_REASONS.SUCCESS, compactionGeneration: 1 });
    assert.equal(h.degraded, false);
    assert.equal(h.recommendation, health.RECOMMENDATIONS.RESUME_OK);
  });

  it('degrades on high compaction generation', () => {
    const h = health.buildHealth({
      stopReason: STOP_REASONS.SUCCESS,
      compactionGeneration: health.MAX_COMPACTION_GENERATION,
    });
    assert.equal(h.degraded, true);
    assert.ok(h.reasons.includes('compaction_generation_high'));
  });

  it('blocks resume when degraded without ack', () => {
    const p = path.join(tmp, 'degraded.state.json');
    const store = new SessionStore(p);
    store.load();
    store.updateRunner({
      health: health.buildHealth({ stopReason: STOP_REASONS.SEMANTIC_CYCLE_DETECTED }),
    });
    store.save();

    const check = health.assertResumeAllowed(store, { ackResumeRisk: false });
    assert.equal(check.allowed, false);
    assert.match(check.message, /--new-session/);
  });

  it('allows resume when ack flag is set', () => {
    const p = path.join(tmp, 'degraded-ack.state.json');
    const store = new SessionStore(p);
    store.load();
    store.updateRunner({
      health: health.buildHealth({ stopReason: STOP_REASONS.BRIDGE_ERROR }),
    });
    store.save();

    const check = health.assertResumeAllowed(store, { ackResumeRisk: true });
    assert.equal(check.allowed, true);
    assert.equal(check.acknowledged, true);
  });

  // A hard kill can leave a structurally valid checkpoint between a model's
  // tool proposal and its receipt. Resuming it must not send invalid history
  // or guess whether the proposed edit already happened.
  for (const acknowledged of [false, true]) {
    it('refuses an unanswered native call even with risk acknowledgement ' + acknowledged, () => {
      const store = new SessionStore(path.join(tmp, 'unfinished-' + acknowledged + '.state.json'));
      store.load();
      store.setItems([{ type: 'function_call', call_id: 'fixture', name: 'write_file', arguments: '{}' }]);
      const check = health.assertResumeAllowed(store, { ackResumeRisk: acknowledged });
      assert.equal(check.allowed, false);
      assert.equal(check.reason, 'incomplete_tool_history');
      assert.equal(check.pendingCalls, 1);
      assert.match(check.message, /fresh|new.session/i);
    });
  }

  it('counts only still-unanswered calls in a multi-tool checkpoint', () => {
    const store = new SessionStore(path.join(tmp, 'partly-finished.state.json'));
    store.load();
    store.setItems([
      { type: 'function_call', call_id: 'first', name: 'write_file', arguments: '{}' },
      { type: 'function_call', call_id: 'second', name: 'write_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'first', output: 'completed' },
    ]);
    assert.equal(health.assertResumeAllowed(store).pendingCalls, 1);
  });

  it('allows fully paired native tool history with out-of-order receipts', () => {
    const store = new SessionStore(path.join(tmp, 'paired.state.json'));
    store.load();
    store.setItems([
      { type: 'function_call', call_id: 'first', name: 'read_file', arguments: '{}' },
      { type: 'function_call', call_id: 'second', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'second', output: 'second result' },
      { type: 'function_call_output', call_id: 'first', output: 'first result' },
    ]);
    assert.equal(health.assertResumeAllowed(store).allowed, true);
  });

  it('treats a denied or cancelled tool receipt as a completed pairing', () => {
    const store = new SessionStore(path.join(tmp, 'denied.state.json'));
    store.load();
    store.setItems([
      { type: 'function_call', call_id: 'fixture', name: 'write_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'fixture', output: 'ERROR: User denied this action.' },
    ]);
    assert.equal(health.assertResumeAllowed(store).allowed, true);
  });

  it('marks a rejected resume as degraded instead of recommending resume_ok', () => {
    const result = health.buildHealth({ stopReason: STOP_REASONS.RESUME_FAILED });
    assert.equal(result.degraded, true);
    assert.equal(result.recommendation, health.RECOMMENDATIONS.FRESH_SESSION);
  });
});
