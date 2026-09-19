import { playGame, type GameResult } from '../engine/game.js';
import { makeLayoutSet, type LayoutFamily } from '../engine/layouts.js';
import { makeRng } from '../engine/rng.js';
import type { GameConfig, PlacedShip } from '../engine/types.js';
import { summarize, type StrategySummary } from '../metrics/summary.js';
import type { Strategy } from '../strategies/types.js';

export interface BenchOptions {
  config: GameConfig;
  strategies: Strategy[];
  games: number;
  /** Base seed. Layout for game i is derived from `seed + i`, so every strategy
   *  faces exactly the same set of layouts — the comparison is paired. */
  seed?: number;
  /** Pre-built layouts. Overrides seeded generation when supplied. */
  layouts?: PlacedShip[][];
  /**
   * Which family of fleet layout to benchmark against. Defaults to 'mixed':
   * uniform-random layouts are exactly what the density baseline assumes, so
   * benchmarking only on those flatters it. See src/engine/layouts.ts.
   */
  layoutFamily?: LayoutFamily;
  onProgress?: (event: ProgressEvent) => void;
  abortSignal?: AbortSignal;
  /** Stops a strategy after this many consecutive failures. Defaults to 3. */
  failureLimit?: number;
}

export interface ProgressEvent {
  strategyId: string;
  gameIndex: number;
  totalGames: number;
  result?: GameResult;
  error?: string;
}

export interface BenchReport {
  startedAt: string;
  finishedAt: string;
  config: GameConfig;
  games: number;
  seed: number;
  /** Which layout family the run used. Results are not comparable across families. */
  layoutFamily: LayoutFamily;
  summaries: StrategySummary[];
  results: GameResult[];
  errors: Array<{ strategyId: string; gameIndex: number; error: string }>;
  /**
   * Whether every strategy completed the same set of games. When false the
   * means below are computed over different layouts and are NOT a paired
   * comparison; `pairingNote` says which strategies are short.
   */
  paired: boolean;
  pairingNote?: string;
  /** Game indices each strategy actually completed. */
  completedByStrategy: Record<string, number[]>;
}

/**
 * Runs every strategy over the same layouts and summarizes the outcome.
 *
 * Each strategy gets its own RNG stream derived from the game seed, so the
 * randomness inside a strategy is reproducible without one strategy's draws
 * shifting another's.
 */
export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const { config, strategies, games, onProgress, abortSignal } = options;
  const seed = options.seed ?? 1;
  const failureLimit = options.failureLimit ?? 3;

  const layoutFamily = options.layoutFamily ?? 'mixed';
  const layouts = options.layouts ?? makeLayoutSet(layoutFamily, games, config, seed);

  if (layouts.length < games) {
    throw new Error(`Need ${games} layouts, got ${layouts.length}`);
  }

  const startedAt = new Date().toISOString();
  const results: GameResult[] = [];
  const errors: BenchReport['errors'] = [];
  const summaries: StrategySummary[] = [];

  for (const strategy of strategies) {
    const strategyResults: GameResult[] = [];
    let consecutiveFailures = 0;

    for (let i = 0; i < games; i++) {
      abortSignal?.throwIfAborted();

      try {
        const result = await playGame({
          config,
          fleet: layouts[i]!,
          strategy,
          // Distinct stream per strategy, still deterministic per seed.
          rng: makeRng(hash(strategy.id) ^ (seed + i)),
          seed: seed + i,
          abortSignal,
        });
        strategyResults.push(result);
        results.push(result);
        consecutiveFailures = 0;
        onProgress?.({ strategyId: strategy.id, gameIndex: i, totalGames: games, result });
      } catch (error) {
        if (abortSignal?.aborted) throw error;

        const message = error instanceof Error ? error.message : String(error);
        errors.push({ strategyId: strategy.id, gameIndex: i, error: message });
        onProgress?.({ strategyId: strategy.id, gameIndex: i, totalGames: games, error: message });

        consecutiveFailures++;
        if (consecutiveFailures >= failureLimit) {
          errors.push({
            strategyId: strategy.id,
            gameIndex: i,
            error: `Stopped after ${failureLimit} consecutive failures`,
          });
          break;
        }
      }
    }

    if (strategyResults.length > 0) summaries.push(summarize(strategyResults));
  }

  const completedByStrategy: Record<string, number[]> = {};
  for (const strategy of strategies) {
    completedByStrategy[strategy.id] = results
      .filter((r) => r.strategyId === strategy.id)
      .map((r) => r.seed - seed)
      .sort((a, b) => a - b);
  }

  const { paired, pairingNote } = assessPairing(completedByStrategy, games);

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    config,
    games,
    seed,
    layoutFamily,
    summaries,
    results,
    errors,
    paired,
    pairingNote,
    completedByStrategy,
  };
}

/**
 * A paired comparison only holds if every strategy played every layout. A
 * strategy that lost games to rate limits is compared over a different subset,
 * which can move a mean by more than the strategies differ - so say so loudly
 * rather than printing a table that looks comparable.
 */
export function assessPairing(
  completedByStrategy: Record<string, number[]>,
  games: number,
): { paired: boolean; pairingNote?: string } {
  const entries = Object.entries(completedByStrategy);
  if (entries.length === 0) return { paired: true };

  const short = entries.filter(([, indices]) => indices.length < games);
  if (short.length === 0) return { paired: true };

  const detail = short
    .map(([id, indices]) => `${id} completed ${indices.length}/${games}`)
    .join('; ');

  return {
    paired: false,
    pairingNote:
      `NOT a paired comparison: ${detail}. Means are computed over different ` +
      'layout sets and should not be compared directly.',
  };
}

/** Small string hash, used to give each strategy its own RNG stream. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
