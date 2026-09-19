import { makeRng, type Rng } from '../engine/rng.js';
import type { GameConfig } from '../engine/types.js';
import type { JevClient } from '../jev/types.js';
import { mean } from '../metrics/summary.js';
import { OpponentHistory } from './history.js';
import { HistoryAwareStrategy } from './historyStrategy.js';
import { playMatch, type MatchResult, type PlayerConfig } from './match.js';

/**
 * Runs a batch of self-play games between two Jev players and reports whether
 * history changed anything.
 *
 * The comparison that matters is player A (history on) against player B
 * (history off), both otherwise identical. Who opens alternates every game,
 * because the player who fires first has a real advantage.
 */
export interface SelfPlayOptions {
  config: GameConfig;
  client: JevClient;
  games: number;
  seed?: number;
  topK?: number;
  temperature?: number;
  /** Let Jev pick the layout as well as the shots. */
  jevPlacement?: boolean;
  onGame?: (index: number, result: MatchResult, report: SelfPlayProgress) => void;
  abortSignal?: AbortSignal;
}

export interface SelfPlayProgress {
  gamesPlayed: number;
  winsWithHistory: number;
  winsWithoutHistory: number;
  draws: number;
}

export interface SelfPlayReport {
  games: number;
  completed: number;
  /** Wins for the player using history. */
  winsWithHistory: number;
  winsWithoutHistory: number;
  draws: number;
  /** Win rate of the history player, over completed games. */
  historyWinRate: number;
  meanShotsWithHistory: number;
  meanShotsWithoutHistory: number;
  /** Win rate over the first and second half, to show any trend as history builds. */
  historyWinRateFirstHalf: number;
  historyWinRateSecondHalf: number;
  /** Games where the history player had signals available when placing its fleet. */
  gamesWithPlacementSignal: number;
  /** Games where the history player had signals available when choosing shots. */
  gamesWithFiringSignal: number;
  /**
   * Games excluded from the verdict because a Jev call failed and a random shot
   * was substituted. A rate-limited call must not be scored as a strategy loss.
   */
  contaminatedGames: number;
  errors: string[];
  modelIds: string[];
  perGame: Array<{
    index: number;
    winner: string | undefined;
    shotsWithHistory: number;
    shotsWithoutHistory: number;
  }>;
}

export const HISTORY_PLAYER = 'withHistory';
export const CONTROL_PLAYER = 'noHistory';

export async function runSelfPlay(options: SelfPlayOptions): Promise<SelfPlayReport> {
  const { config, client, games, onGame, abortSignal } = options;
  const seed = options.seed ?? 1;

  const histories: Record<string, OpponentHistory> = {
    [HISTORY_PLAYER]: new OpponentHistory(config),
    [CONTROL_PLAYER]: new OpponentHistory(config),
  };

  const makePlayer = (id: string, useHistory: boolean): PlayerConfig => ({
    id,
    useHistory,
    jevPlacement: options.jevPlacement ?? true,
    client,
    temperature: options.temperature ?? 0.7,
    strategy: new HistoryAwareStrategy({
      client,
      history: histories[id]!,
      useHistory,
      topK: options.topK ?? 8,
      temperature: options.temperature ?? 0.7,
    }),
  });

  const withHistory = makePlayer(HISTORY_PLAYER, true);
  const control = makePlayer(CONTROL_PLAYER, false);
  const historyStrategy = withHistory.strategy as HistoryAwareStrategy;

  const report: SelfPlayReport = {
    games,
    completed: 0,
    winsWithHistory: 0,
    winsWithoutHistory: 0,
    draws: 0,
    historyWinRate: 0,
    meanShotsWithHistory: 0,
    meanShotsWithoutHistory: 0,
    historyWinRateFirstHalf: 0,
    historyWinRateSecondHalf: 0,
    gamesWithPlacementSignal: 0,
    gamesWithFiringSignal: 0,
    contaminatedGames: 0,
    errors: [],
    modelIds: [],
    perGame: [],
  };

  const shotsWithHistory: number[] = [];
  const shotsWithoutHistory: number[] = [];
  const winsInOrder: boolean[] = [];

  for (let i = 0; i < games; i++) {
    abortSignal?.throwIfAborted();
    const rng: Rng = makeRng(seed + i);

    // Alternate who fires first, so the first-move advantage cancels out.
    const players: [PlayerConfig, PlayerConfig] =
      i % 2 === 0 ? [withHistory, control] : [control, withHistory];

    try {
      const result = await playMatch({ config, players, histories, rng, abortSignal });

      report.completed++;
      report.errors.push(...result.errors);
      if (result.usedHistory[HISTORY_PLAYER]) report.gamesWithPlacementSignal++;
      if (historyStrategy.lastShotUsedHistory) report.gamesWithFiringSignal++;

      if (result.contaminated) {
        // Counted, reported, but kept out of every figure the verdict uses.
        report.contaminatedGames++;
        continue;
      }

      if (result.winnerId === HISTORY_PLAYER) report.winsWithHistory++;
      else if (result.winnerId === CONTROL_PLAYER) report.winsWithoutHistory++;
      else report.draws++;

      winsInOrder.push(result.winnerId === HISTORY_PLAYER);
      shotsWithHistory.push(result.shotsByPlayer[HISTORY_PLAYER] ?? 0);
      shotsWithoutHistory.push(result.shotsByPlayer[CONTROL_PLAYER] ?? 0);

      report.perGame.push({
        index: i,
        winner: result.winnerId,
        shotsWithHistory: result.shotsByPlayer[HISTORY_PLAYER] ?? 0,
        shotsWithoutHistory: result.shotsByPlayer[CONTROL_PLAYER] ?? 0,
      });

      onGame?.(i, result, {
        gamesPlayed: report.completed,
        winsWithHistory: report.winsWithHistory,
        winsWithoutHistory: report.winsWithoutHistory,
        draws: report.draws,
      });
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      report.errors.push(
        `game ${i}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const decided = report.winsWithHistory + report.winsWithoutHistory;
  report.historyWinRate = decided > 0 ? report.winsWithHistory / decided : 0;
  report.meanShotsWithHistory = mean(shotsWithHistory);
  report.meanShotsWithoutHistory = mean(shotsWithoutHistory);

  const half = Math.floor(winsInOrder.length / 2);
  report.historyWinRateFirstHalf = half > 0 ? mean(winsInOrder.slice(0, half).map(Number)) : 0;
  report.historyWinRateSecondHalf =
    winsInOrder.length - half > 0 ? mean(winsInOrder.slice(half).map(Number)) : 0;

  report.modelIds = [
    ...new Set(client.log.map((entry) => entry.response?.modelId).filter((m): m is string => !!m)),
  ];

  return report;
}

/**
 * Whether the history player's advantage is large enough to be worth claiming.
 * Uses a normal approximation to a two-sided binomial test against p = 0.5.
 * With a few dozen games the honest answer is usually "not distinguishable".
 */
export function historyEffect(report: SelfPlayReport): {
  winRate: number;
  decidedGames: number;
  z: number;
  significant: boolean;
  verdict: string;
} {
  const decided = report.winsWithHistory + report.winsWithoutHistory;
  const excluded = report.contaminatedGames ?? 0;
  const suffix = excluded > 0 ? ` (${excluded} contaminated game(s) excluded)` : '';

  if (decided < 10) {
    return {
      winRate: report.historyWinRate,
      decidedGames: decided,
      z: 0,
      significant: false,
      verdict: `only ${decided} decided games: far too few to tell whether history helped${suffix}`,
    };
  }

  const z = (report.winsWithHistory - decided / 2) / Math.sqrt(decided * 0.25);
  const significant = Math.abs(z) >= 1.96;

  return {
    winRate: report.historyWinRate,
    decidedGames: decided,
    z,
    significant,
    verdict: significant
      ? `history changed the outcome: ${(report.historyWinRate * 100).toFixed(1)}% win rate over ${decided} games (z = ${z.toFixed(2)})${suffix}`
      : `no measurable effect: ${(report.historyWinRate * 100).toFixed(1)}% win rate over ${decided} games is within noise (z = ${z.toFixed(2)})${suffix}`,
  };
}
