import { describe, expect, it } from 'vitest';
import { estimateCostUsd, formatUsd, JEV_PRICING } from '../pricing.js';

describe('estimateCostUsd', () => {
  it('reproduces a cost the Gateway actually reported', () => {
    // Observed live on 2026-09-19: the Gateway billed marketCost 0.000011424
    // for 272 input tokens. If this test fails, the published rate has moved
    // and every estimate in the UI and bench output is stale.
    expect(estimateCostUsd({ inputTokens: 272, outputTokens: 20 })).toBeCloseTo(0.000011424, 12);
  });

  it('charges nothing for output tokens, which are documented as free', () => {
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000 })).toBe(0);
    expect(JEV_PRICING.outputPerMillionUsd).toBe(0);
  });

  it('scales linearly with input tokens', () => {
    const one = estimateCostUsd({ inputTokens: 1_000_000 })!;
    expect(one).toBeCloseTo(JEV_PRICING.inputPerMillionUsd, 12);
    expect(estimateCostUsd({ inputTokens: 2_000_000 })!).toBeCloseTo(one * 2, 12);
  });

  it('returns undefined when usage is unknown, rather than a misleading zero', () => {
    expect(estimateCostUsd(undefined)).toBeUndefined();
    expect(estimateCostUsd({})).toBeUndefined();
  });

  it('treats a missing half of usage as zero', () => {
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: undefined })).toBeCloseTo(
      JEV_PRICING.inputPerMillionUsd,
      12,
    );
    expect(estimateCostUsd({ outputTokens: 500 })).toBe(0);
  });

  it('puts a realistic 60-game benchmark in the right ballpark', () => {
    // 60 games, ~49 shots each, two model strategies, ~2500 input tokens a call.
    const calls = 60 * 49 * 2;
    const total = estimateCostUsd({ inputTokens: calls * 2500 })!;
    expect(total).toBeGreaterThan(0.5);
    expect(total).toBeLessThan(2);
  });
});

describe('formatUsd', () => {
  it('keeps very small amounts legible instead of rounding them away', () => {
    expect(formatUsd(0.000011424)).toBe('$0.00001');
    expect(formatUsd(0.0034)).toBe('$0.00340');
  });

  it('formats larger amounts normally', () => {
    expect(formatUsd(0.61)).toBe('$0.6100');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(0)).toBe('$0');
  });
});
