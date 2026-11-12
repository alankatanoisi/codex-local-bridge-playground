'use strict';

/**
 * Model pricing table — estimate only, for budget warnings and usage summaries.
 *
 * Rates are USD per million tokens. Each row documents its provider-specific
 * cache semantics. The active gpt-6.1-sol row is reference-only; its published rate card
 * does not establish the actual charge for this account.
 */

const PRICING_PER_MILLION = Object.freeze({
  // Standard Codex rates verified 2026-10-17. USD is the published Enterprise
  // reference, not a claim about this account's invoice or included allowance.
  // Credit rates: 50 input / 2.5 cached input / 250 output per million tokens.
  'gpt-6.1-sol': {
    input: 2,
    output: 10,
    cache_read: 0.1,
    cache_write: 0,
    input_includes_cache_read: true,
    reference_only: true,
    reference_note: 'Standard Enterprise USD reference; not verified account billing.',
    credits_per_usd: 25,
    long_context_threshold: 272000,
  },
  // Official OpenAI API Standard rates for short-context gpt-5.5 requests,
  // checked 2026-08-10. This runner authenticates through a ChatGPT Business
  // programmatic token, so the row is an estimate/reference only; it does not
  // claim that a ChatGPT subscription is billed at these public API rates.
  'gpt-5.5': {
    input: 5.0,
    output: 30.0,
    cache_read: 0.5,
    cache_write: 0,
    // Responses input_tokens already contains the cached-token subset. The
    // estimator subtracts that subset before applying the full input rate.
    input_includes_cache_read: true,
    reference_only: true,
    reference_note: 'OpenAI API Standard short-context rates; not ChatGPT subscription billing.',
  },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 6.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 30.0 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0, cache_read: 0.08, cache_write: 1.6 },
  default: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 6.0 },
});

// Resolve rates defensively so new/alias model names (e.g. a future
// claude-opus-4-8) fall back to the right family instead of silently using the
// generic default. Lookup order: exact key, then legacy family prefix, then unknown.
const FAMILY_PREFIXES = [
  { prefix: 'claude-opus', key: 'claude-opus-4-6' },
  { prefix: 'claude-sonnet', key: 'claude-sonnet-4-6' },
  { prefix: 'claude-haiku', key: 'claude-haiku-4-5' },
];

function resolveRates(model) {
  // Only rows we explicitly added are prices. Every ordinary JavaScript object
  // also inherits names such as "constructor"; those are not model rate cards.
  if (typeof model === 'string' && Object.hasOwn(PRICING_PER_MILLION, model)) return PRICING_PER_MILLION[model];
  if (typeof model === 'string') {
    for (const { prefix, key } of FAMILY_PREFIXES) {
      if (model.startsWith(prefix)) return PRICING_PER_MILLION[key];
    }
  }
  // Unknown is not zero and not a guessed price from a different provider.
  return null;
}

function estimateCostUsd(model, usage) {
  const rates = resolveRates(model);
  if (!rates) return null;
  const u = usage || {};
  const input = (u.input_tokens || 0) / 1_000_000;
  const output = (u.output_tokens || 0) / 1_000_000;
  const cacheRead = (u.cache_read_input_tokens || 0) / 1_000_000;
  const cacheWrite = (u.cache_creation_input_tokens || 0) / 1_000_000;

  // Anthropic usage reports cached tokens separately from input_tokens, while
  // Responses reports cached tokens as a subset of input_tokens. This small
  // rate flag lets one public estimator handle both shapes without charging a
  // cached Responses token once at full price and again at the cache price.
  const fullRateInput = rates.input_includes_cache_read ? Math.max(0, input - cacheRead) : input;

  // This helper prices ONE request. The runner sums those prices, because
  // several short turns must not accidentally trigger a long-context rate.
  const longContext = rates.long_context_threshold && (u.input_tokens || 0) > rates.long_context_threshold;
  return (
    (fullRateInput * rates.input + cacheRead * rates.cache_read) * (longContext ? 2 : 1) +
    output * rates.output * (longContext ? 1.5 : 1) +
    cacheWrite * rates.cache_write
  );
}

/**
 * Build a usage/cost summary for stderr, transcript, and human-log surfaces.
 *
 * Returns both raw token counts and derived fields so downstream scripts never
 * have to parse the display string.
 *
 * cacheReadShare is the fraction of prompt tokens served from cache. It is
 * deliberately named "read share" rather than "hit rate" — it measures reuse,
 * not a true cache hit rate.
 */
function summarizeUsage(model, usage, options = {}) {
  const u = usage || {};
  const rates = resolveRates(model);
  const inputTokens = u.input_tokens || 0;
  const outputTokens = u.output_tokens || 0;
  const reasoningTokens = u.reasoning_tokens || 0;
  const cacheReadTokens = u.cache_read_input_tokens || 0;
  const cacheCreationTokens = u.cache_creation_input_tokens || 0;
  // Responses counts cached reads inside input_tokens. Claude-style usage
  // keeps them separate. Match the model's public usage shape so the displayed
  // prompt total and reuse percentage describe the same token population.
  const totalInputTokens =
    !rates || rates.input_includes_cache_read
      ? inputTokens + cacheCreationTokens
      : inputTokens + cacheReadTokens + cacheCreationTokens;
  const costUsd = Object.hasOwn(options, 'costUsd') ? options.costUsd : estimateCostUsd(model, u);
  const cacheReadShare = totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : 0;

  const parts = ['in=' + inputTokens, 'out=' + outputTokens];
  if (reasoningTokens) parts.push('reasoning=' + reasoningTokens);
  if (cacheReadTokens) parts.push('cache_read=' + cacheReadTokens);
  if (cacheCreationTokens) parts.push('cache_write=' + cacheCreationTokens);
  parts.push('(reuse ' + Math.round(cacheReadShare * 100) + '%)');
  parts.push(costUsd === null ? 'cost unknown (no model pricing)' : '~$' + costUsd.toFixed(4));
  if (rates?.reference_only) parts.push('(reference only; not subscription billing)');
  const oneLine = '[runner usage] ' + parts.join(' ');

  return {
    model: model || null,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalInputTokens,
    costUsd,
    costKnown: costUsd !== null,
    costReferenceOnly: !!rates?.reference_only,
    costReferenceNote: rates?.reference_note || null,
    estimatedCredits: costUsd !== null && rates?.credits_per_usd ? costUsd * rates.credits_per_usd : null,
    cacheReadShare,
    oneLine,
  };
}

module.exports = {
  PRICING_PER_MILLION,
  resolveRates,
  estimateCostUsd,
  summarizeUsage,
};
