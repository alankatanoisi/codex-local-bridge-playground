'use strict';

// One shared definition keeps the command line and library callers in agreement.
const DEFAULT_MODEL = 'gpt-6.1-sol';
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeEffort(value) {
  if (value === undefined || value === null || value === '') return null;
  const effort = String(value).toLowerCase();
  if (!EFFORT_LEVELS.includes(effort)) {
    throw new Error('--effort must be one of: ' + EFFORT_LEVELS.join(', '));
  }
  // In particular, max means max. Do not silently ask the model for high.
  return effort;
}

function validateMaxOutputTokens(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('--max-tokens / max_output_tokens must be a positive safe integer');
  }
  return value;
}

module.exports = { DEFAULT_MODEL, DEFAULT_MAX_OUTPUT_TOKENS, EFFORT_LEVELS, normalizeEffort, validateMaxOutputTokens };
