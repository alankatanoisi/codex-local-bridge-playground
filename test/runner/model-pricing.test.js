'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { estimateCostUsd, summarizeUsage, resolveRates } = require('../../src/runner/model-pricing');

const M = 1_000_000;

describe('model-pricing: estimateCostUsd', () => {
  it('exposes gpt-5.5 standard short-context API rates as reference-only', () => {
    // These numbers are a budgeting reference for the public OpenAI API.
    // They must not be presented as the billing rules for the ChatGPT Business
    // programmatic token that this experimental runner currently uses.
    const rates = resolveRates('gpt-5.5');

    assert.equal(rates.input, 5.0);
    assert.equal(rates.output, 30.0);
    assert.equal(rates.cache_read, 0.5);
    assert.equal(rates.cache_write, 0);
    assert.equal(rates.reference_only, true);
    assert.match(rates.reference_note, /not ChatGPT subscription billing/i);
  });

  it('prices cached gpt-5.5 input once because Responses includes it in input_tokens', () => {
    // Responses reports cached tokens as a subset of input_tokens. Here, 750K
    // tokens use the normal input rate and 250K use the discounted cache rate.
    const cost = estimateCostUsd('gpt-5.5', {
      input_tokens: M,
      cache_read_input_tokens: M / 4,
    });

    assert.equal(cost, 0.75 * 5.0 + 0.25 * 0.5);
  });

  it('prices input + output (regression, no cache tokens)', () => {
    // sonnet: 1M input @ $3 + 1M output @ $15 = $18.00
    const cost = estimateCostUsd('claude-sonnet-4-6', { input_tokens: M, output_tokens: M });
    assert.equal(cost, 18.0);
  });

  it('prices cache_read and cache_write as separate components', () => {
    // sonnet cache_read 0.1x input = $0.30/M, cache_write (1h) 2.0x input = $6.00/M
    const readCost = estimateCostUsd('claude-sonnet-4-6', { cache_read_input_tokens: M });
    assert.ok(Math.abs(readCost - 0.3) < 1e-9);
    const writeCost = estimateCostUsd('claude-sonnet-4-6', { cache_creation_input_tokens: M });
    assert.ok(Math.abs(writeCost - 6.0) < 1e-9);
  });

  it('sums all four components without double counting', () => {
    const cost = estimateCostUsd('claude-sonnet-4-6', {
      input_tokens: M,
      output_tokens: M,
      cache_read_input_tokens: M,
      cache_creation_input_tokens: M,
    });
    assert.ok(Math.abs(cost - (3.0 + 15.0 + 0.3 + 6.0)) < 1e-9);
  });

  it('falls back to default for an unknown model', () => {
    const cost = estimateCostUsd('totally-unknown-model', { input_tokens: M });
    assert.equal(cost, 3.0); // default input rate
  });

  it('resolves new/alias names by family prefix, not default', () => {
    // A future opus alias should price like opus ($15/M input), not default ($3/M).
    assert.equal(resolveRates('claude-opus-4-8'), resolveRates('claude-opus-4-6'));
    const cost = estimateCostUsd('claude-opus-4-8', { input_tokens: M });
    assert.equal(cost, 15.0);
  });
});

describe('model-pricing: summarizeUsage', () => {
  it('reports a Responses cache share without adding cached tokens twice', () => {
    // For Responses, 250 cached tokens are already inside the 1,000 input
    // tokens. The prompt total stays 1,000 and the reuse share is 25%.
    const s = summarizeUsage('gpt-5.5', {
      input_tokens: 1_000,
      cache_read_input_tokens: 250,
    });

    assert.equal(s.totalInputTokens, 1_000);
    assert.equal(s.cacheReadShare, 0.25);
  });

  it('labels the displayed gpt-5.5 dollar amount as reference-only', () => {
    const s = summarizeUsage('gpt-5.5', { input_tokens: 100, output_tokens: 50 });

    assert.match(s.oneLine, /~\$[0-9.]+ \(reference only; not subscription billing\)/);
  });

  it('exposes raw counts and derived fields', () => {
    const s = summarizeUsage('claude-sonnet-4-6', {
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 12,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 0,
    });
    assert.equal(s.inputTokens, 100);
    assert.equal(s.outputTokens, 50);
    assert.equal(s.reasoningTokens, 12);
    assert.equal(s.cacheReadTokens, 300);
    assert.equal(s.cacheCreationTokens, 0);
    assert.equal(s.totalInputTokens, 400);
    // cache read share = 300 / (100 + 300 + 0) = 0.75
    assert.ok(Math.abs(s.cacheReadShare - 0.75) < 1e-9);
    assert.ok(s.costUsd > 0);
  });

  it('cacheReadShare is 0 when there are no prompt tokens', () => {
    const s = summarizeUsage('claude-sonnet-4-6', { output_tokens: 10 });
    assert.equal(s.cacheReadShare, 0);
  });

  it('oneLine omits zero cache fields and includes a dollar estimate', () => {
    const s = summarizeUsage('claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 });
    assert.ok(s.oneLine.includes('in=100'));
    assert.ok(s.oneLine.includes('out=50'));
    assert.ok(!s.oneLine.includes('cache_read='));
    assert.ok(!s.oneLine.includes('cache_write='));
    assert.ok(s.oneLine.includes('~$'));
    assert.ok(/reuse \d+%/.test(s.oneLine));
  });

  it('oneLine shows cache fields when present', () => {
    const s = summarizeUsage('claude-sonnet-4-6', {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 200,
    });
    assert.ok(s.oneLine.includes('cache_read=300'));
    assert.ok(s.oneLine.includes('cache_write=200'));
  });

  it('oneLine reports reasoning tokens when present', () => {
    const s = summarizeUsage('gpt-5.5', {
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 12,
    });
    assert.ok(s.oneLine.includes('reasoning=12'));
  });
});
