'use strict';

/**
 * Session health — resume guardrails and fresh-session recommendations.
 */

const { STOP_REASONS } = require('./kernel/contract');

const DEGRADED_STOP_REASONS = new Set([
  STOP_REASONS.SEMANTIC_CYCLE_DETECTED,
  STOP_REASONS.MAX_STEPS,
  STOP_REASONS.CONTEXT_BUDGET_EXCEEDED,
  STOP_REASONS.TOOL_FAILURE_ESCALATION,
  STOP_REASONS.BRIDGE_ERROR,
  STOP_REASONS.RESUME_FAILED,
]);

const MAX_COMPACTION_GENERATION = 5;
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

const RECOMMENDATIONS = Object.freeze({
  FRESH_SESSION: 'fresh_session',
  RESUME_OK: 'resume_ok',
});

const PLAYBOOK_DOC = 'docs/runner-quickstart.html';

function getHealth(sessionStore) {
  if (!sessionStore) return null;
  const runner = sessionStore.data().runner || {};
  return runner.health || null;
}

function isDegraded(health) {
  return !!(health && health.degraded);
}

/**
 * Build health snapshot from a completed run.
 */
function buildHealth(input) {
  const { stopReason, autopsy, compactionGeneration = 0, consecutiveToolFailures = 0 } = input || {};

  const reasons = [];
  if (stopReason && DEGRADED_STOP_REASONS.has(stopReason)) {
    reasons.push(stopReason);
  }
  if (autopsy?.cycleDetected && !reasons.includes(STOP_REASONS.SEMANTIC_CYCLE_DETECTED)) {
    reasons.push(STOP_REASONS.SEMANTIC_CYCLE_DETECTED);
  }
  if (compactionGeneration >= MAX_COMPACTION_GENERATION) {
    reasons.push('compaction_generation_high');
  }
  if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
    reasons.push('consecutive_tool_failures');
  }

  const degraded = reasons.length > 0;
  return {
    degraded,
    reasons,
    lastStopReason: stopReason || null,
    lastRunAt: new Date().toISOString(),
    compactionGeneration,
    recommendation: degraded ? RECOMMENDATIONS.FRESH_SESSION : RECOMMENDATIONS.RESUME_OK,
  };
}

function assertResumeAllowed(sessionStore, options = {}) {
  const health = getHealth(sessionStore);
  // A tool proposal needs a matching receipt before native history can resume.
  // A hard kill can leave proposals in the checkpoint while an edit has already
  // happened. Never guess a result or repeat that edit just to repair history.
  const unanswered = new Set();
  for (const item of sessionStore?.items || []) {
    if (item.type === 'function_call') unanswered.add(item.call_id);
    else if (item.type === 'function_call_output') unanswered.delete(item.call_id);
  }
  if (unanswered.size) {
    return {
      allowed: false,
      health,
      reason: 'incomplete_tool_history',
      pendingCalls: unanswered.size,
      message:
        'Saved session has ' +
        unanswered.size +
        ' tool call(s) without a recorded result, possibly after an interruption. ' +
        'Some edits may already have completed. Start a fresh session and inspect existing files. ' +
        '--ack-resume-risk cannot repair missing results; saved history will not be rewritten automatically.',
    };
  }
  if (!isDegraded(health)) {
    return { allowed: true, health };
  }
  if (options.ackResumeRisk) {
    return { allowed: true, health, acknowledged: true };
  }
  return {
    allowed: false,
    health,
    message: formatResumeBlockedMessage(health),
  };
}

function formatResumeBlockedMessage(health) {
  const reasons = (health?.reasons || []).join(', ') || 'unknown';
  return (
    'Session health is degraded (' +
    reasons +
    '). Start fresh with --new-session or pass --ack-resume-risk to resume anyway. See ' +
    PLAYBOOK_DOC +
    '.'
  );
}

function formatFreshSessionTip(sessionId) {
  const idPart = sessionId ? ' --session-id ' + sessionId : '';
  return (
    'Next task: node bin/local-bridge-runner.js --new-session' +
    idPart +
    ' --task-scope --plan "…" (see ' +
    PLAYBOOK_DOC +
    ')'
  );
}

function formatTaskScopeEndTip() {
  return (
    'Task done — start the next task with --new-session (or --fork-from <session-id> to branch). See ' +
    PLAYBOOK_DOC +
    '.'
  );
}

module.exports = {
  DEGRADED_STOP_REASONS,
  MAX_COMPACTION_GENERATION,
  RECOMMENDATIONS,
  PLAYBOOK_DOC,
  getHealth,
  isDegraded,
  buildHealth,
  assertResumeAllowed,
  formatResumeBlockedMessage,
  formatFreshSessionTip,
  formatTaskScopeEndTip,
};
