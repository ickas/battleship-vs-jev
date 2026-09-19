import type { JevUsage } from './types.js';

/**
 * Published Jev pricing, used only to estimate cost when the transport does not
 * report one.
 *
 * The Gateway returns a per-call `marketCost` and that figure is always
 * preferred. The TypeSafe API returns token usage but no cost at all, so on the
 * direct transport an estimate is the only option - and showing nothing, or a
 * silent zero, would be worse than showing a clearly labelled estimate.
 *
 * The rate is confirmed twice over, which is why it is safe to hardcode:
 *   - https://docs.typesafe.ai/models.md states $0.042 per million input
 *     tokens, with output free.
 *   - A live Gateway call on 2026-09-19 reported marketCost 0.000011424 for 272
 *     input tokens. 272 * 0.042 / 1e6 = 0.000011424 exactly.
 *
 * Re-check it against the models page before trusting a large total; a provider
 * can change a price without changing an API.
 */
export const JEV_PRICING = {
  inputPerMillionUsd: 0.042,
  /** Output tokens are documented as free. */
  outputPerMillionUsd: 0,
  source: 'https://docs.typesafe.ai/models.md',
  confirmedOn: '2026-09-19',
} as const;

/**
 * Cost of a call at the published rate, or undefined when usage is unknown.
 * This is an estimate, never a billed figure: callers must label it as one.
 */
export function estimateCostUsd(usage: JevUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;

  return (
    ((inputTokens ?? 0) * JEV_PRICING.inputPerMillionUsd) / 1e6 +
    ((outputTokens ?? 0) * JEV_PRICING.outputPerMillionUsd) / 1e6
  );
}

/** Formats a USD amount for display, keeping small figures legible. */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0';
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
