import { describe, expect, it } from 'vitest';
import type { GameResult } from '../../engine/game.js';
import { makeConfig } from '../../engine/config.js';
import {
  formatComparisonTable,
  mean,
  median,
  percentile,
  resultsToCsv,
  stdDev,
  summarize,
} from '../summary.js';

const config = makeConfig();

function makeResult(overrides: Partial<GameResult> = {}): GameResult {
  const shots = (overrides.shotCount ?? 2) as number;
  return {
    strategyId: 'test',
    strategyName: 'Test',
    seed: 1,
    config,
    fleet: [],
    shots: Array.from({ length: shots }, (_, i) => ({
      index: i + 1,
      label: `A${i + 1}`,
      outcome: { coord: { row: 0, col: i }, result: 'hit' as const, gameOver: false },
      latencyMs: 10 * (i + 1),
      confidence: 0.8,
      modelId: 'jev-1.13.0',
      usage: { inputTokens: 50, outputTokens: 2 },
    })),
    shotCount: shots,
    hits: shots,
    misses: 0,
    won: true,
    totalLatencyMs: 30,
    totalInputTokens: 50 * shots,
    totalOutputTokens: 2 * shots,
    totalCostUsd: 0.000012 * shots,
    costIsEstimated: false,
    generationIds: Array.from({ length: shots }, (_, i) => `gen_${i}`),
    perfectScore: 17,
    ...overrides,
  };
}

describe('statistics helpers', () => {
  it('computes mean, median and standard deviation', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });

  it('handles empty and single-element inputs', () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(stdDev([5])).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('computes percentiles by nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 1)).toBe(100);
    expect(percentile([7], 0.5)).toBe(7);
  });
});

describe('summarize', () => {
  it('aggregates shots, accuracy, tokens, confidence and model ids', () => {
    const summary = summarize([
      makeResult({ shotCount: 40, hits: 17, misses: 23 }),
      makeResult({ shotCount: 60, hits: 17, misses: 43 }),
    ]);

    expect(summary.games).toBe(2);
    expect(summary.wins).toBe(2);
    expect(summary.meanShots).toBe(50);
    expect(summary.minShots).toBe(40);
    expect(summary.maxShots).toBe(60);
    expect(summary.accuracy).toBeCloseTo(34 / 100, 5);
    expect(summary.meanConfidence).toBeCloseTo(0.8, 5);
    expect(summary.modelIds).toEqual(['jev-1.13.0']);
    expect(summary.totalInputTokens).toBe(50 * 100);
  });

  it('reports no confidence when no shot carried one', () => {
    const result = makeResult({ shotCount: 1 });
    result.shots[0]!.confidence = undefined;
    expect(summarize([result]).meanConfidence).toBeUndefined();
  });

  it('counts a loss when the fleet was not sunk', () => {
    expect(summarize([makeResult({ won: false })]).wins).toBe(0);
  });

  it('rejects an empty result set', () => {
    expect(() => summarize([])).toThrow(/empty result set/);
  });
});

describe('output formats', () => {
  it('orders the table by mean shots, best first', () => {
    const table = formatComparisonTable([
      { ...summarize([makeResult({ shotCount: 90 })]), strategyName: 'Worse', meanShots: 90 },
      { ...summarize([makeResult({ shotCount: 40 })]), strategyName: 'Better', meanShots: 40 },
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toContain('strategy');
    expect(lines[2]).toContain('Better');
    expect(lines[3]).toContain('Worse');
  });

  it('writes one CSV row per game plus a header', () => {
    const csv = resultsToCsv([makeResult({ seed: 1 }), makeResult({ seed: 2 })]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('strategyId,strategyName,seed');
    expect(lines[1]).toContain('jev-1.13.0');
  });

  it('quotes fields containing commas', () => {
    const csv = resultsToCsv([makeResult({ strategyName: 'Jev, pure' })]);
    expect(csv).toContain('"Jev, pure"');
  });
});
