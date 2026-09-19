import type { GameResult } from '../engine/game.js';
import { formatUsd } from '../jev/pricing.js';

/** Aggregated results for one strategy across a batch of games. */
export interface StrategySummary {
  strategyId: string;
  strategyName: string;
  games: number;
  wins: number;
  /** Shots to sink the whole fleet. The headline benchmark number: lower is better. */
  meanShots: number;
  medianShots: number;
  minShots: number;
  maxShots: number;
  /** Sample standard deviation of shot counts. */
  stdDevShots: number;
  /** Hits divided by shots. */
  accuracy: number;
  /** Mean per-shot decision latency, end to end through the Gateway. */
  meanShotLatencyMs: number;
  /** 95th percentile per-shot latency. */
  p95ShotLatencyMs: number;
  meanGameLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  meanTokensPerGame: number;
  /** List-price cost across every game, in USD, from the Gateway's own figures. */
  totalCostUsd: number;
  /** Mean of the model's reported confidence, over shots that carried one. */
  meanConfidence?: number;
  /** Distinct model versions seen. Results are comparable only within one. */
  modelIds: string[];
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Nearest-rank percentile. `p` in [0,1]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

export function summarize(results: GameResult[]): StrategySummary {
  if (results.length === 0) throw new Error('Cannot summarize an empty result set');

  const first = results[0]!;
  const shotCounts = results.map((r) => r.shotCount);
  const shotLatencies = results.flatMap((r) => r.shots.map((s) => s.latencyMs));
  const confidences = results.flatMap((r) =>
    r.shots.map((s) => s.confidence).filter((c): c is number => typeof c === 'number'),
  );
  const modelIds = [
    ...new Set(
      results.flatMap((r) => r.shots.map((s) => s.modelId).filter((m): m is string => !!m)),
    ),
  ];

  const totalShots = shotCounts.reduce((sum, c) => sum + c, 0);
  const totalHits = results.reduce((sum, r) => sum + r.hits, 0);
  const totalInputTokens = results.reduce((sum, r) => sum + r.totalInputTokens, 0);
  const totalOutputTokens = results.reduce((sum, r) => sum + r.totalOutputTokens, 0);
  const totalCostUsd = results.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0);

  return {
    strategyId: first.strategyId,
    strategyName: first.strategyName,
    games: results.length,
    wins: results.filter((r) => r.won).length,
    meanShots: mean(shotCounts),
    medianShots: median(shotCounts),
    minShots: Math.min(...shotCounts),
    maxShots: Math.max(...shotCounts),
    stdDevShots: stdDev(shotCounts),
    accuracy: totalShots > 0 ? totalHits / totalShots : 0,
    meanShotLatencyMs: mean(shotLatencies),
    p95ShotLatencyMs: percentile(shotLatencies, 0.95),
    meanGameLatencyMs: mean(results.map((r) => r.totalLatencyMs)),
    totalInputTokens,
    totalOutputTokens,
    meanTokensPerGame: (totalInputTokens + totalOutputTokens) / results.length,
    totalCostUsd,
    meanConfidence: confidences.length > 0 ? mean(confidences) : undefined,
    modelIds,
  };
}

/** Fixed-width comparison table, best mean shots first. */
export function formatComparisonTable(summaries: StrategySummary[]): string {
  const sorted = [...summaries].sort((a, b) => a.meanShots - b.meanShots);

  const headers = [
    'strategy', 'games', 'mean', 'median', 'sd', 'min', 'max', 'acc', 'ms/shot', 'tok/game', 'cost',
  ];
  const rows = sorted.map((s) => [
    s.strategyName,
    String(s.games),
    s.meanShots.toFixed(1),
    s.medianShots.toFixed(1),
    s.stdDevShots.toFixed(1),
    String(s.minShots),
    String(s.maxShots),
    `${(s.accuracy * 100).toFixed(0)}%`,
    s.meanShotLatencyMs >= 1 ? s.meanShotLatencyMs.toFixed(0) : '<1',
    s.meanTokensPerGame > 0 ? s.meanTokensPerGame.toFixed(0) : '-',
    s.totalCostUsd > 0 ? formatUsd(s.totalCostUsd) : '-',
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ');

  return [
    line(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(line),
  ].join('\n');
}

/** Flat CSV, one row per game, for analysis outside this repo. */
export function resultsToCsv(results: GameResult[]): string {
  const header = [
    'strategyId',
    'strategyName',
    'seed',
    'shots',
    'hits',
    'misses',
    'won',
    'totalLatencyMs',
    'inputTokens',
    'outputTokens',
    'costUsd',
    'modelIds',
    'generationIds',
  ].join(',');

  const rows = results.map((r) =>
    [
      r.strategyId,
      quote(r.strategyName),
      r.seed,
      r.shotCount,
      r.hits,
      r.misses,
      r.won,
      r.totalLatencyMs.toFixed(1),
      r.totalInputTokens,
      r.totalOutputTokens,
      (r.totalCostUsd ?? 0).toFixed(8),
      quote([...new Set(r.shots.map((s) => s.modelId).filter(Boolean))].join(' ')),
      // Every generation id, so any row can be found in the Gateway request logs.
      quote((r.generationIds ?? []).join(' ')),
    ].join(','),
  );

  return [header, ...rows].join('\n');
}

function quote(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
