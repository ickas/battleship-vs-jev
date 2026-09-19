import { Board } from './board.js';
import { coordToLabel } from './coords.js';
import { totalShipCells } from './config.js';
import type { Rng } from './rng.js';
import type { GameConfig, PlacedShip, ShotOutcome } from './types.js';
import type { Heatmap, Strategy } from '../strategies/types.js';

export interface ShotRecord {
  /** 1-based index of this shot within the game. */
  index: number;
  label: string;
  outcome: ShotOutcome;
  /** Wall-clock time for the strategy's decision, in milliseconds. */
  latencyMs: number;
  heatmap?: Heatmap;
  confidence?: number;
  notes?: string;
  /** Token usage for this shot, when the decision came from a model. */
  usage?: { inputTokens?: number; outputTokens?: number };
  modelId?: string;
}

export interface GameResult {
  strategyId: string;
  strategyName: string;
  seed: number;
  config: GameConfig;
  /** The layout that was being hunted. Recorded so a game can be replayed exactly. */
  fleet: PlacedShip[];
  shots: ShotRecord[];
  /** Total shots taken to sink the fleet, or to hit `maxShots`. */
  shotCount: number;
  hits: number;
  misses: number;
  won: boolean;
  totalLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** The minimum possible score: every shot a hit. */
  perfectScore: number;
}

export interface PlayOptions {
  config: GameConfig;
  fleet: PlacedShip[];
  strategy: Strategy;
  rng: Rng;
  seed: number;
  /** Safety valve so a broken strategy cannot loop forever. Defaults to every cell. */
  maxShots?: number;
  /** Called after each shot, for live UI updates. */
  onShot?: (record: ShotRecord, board: Board) => void;
  abortSignal?: AbortSignal;
}

/** Runs one game: a single strategy firing until the fleet is sunk. */
export async function playGame(options: PlayOptions): Promise<GameResult> {
  const { config, fleet, strategy, rng, seed, onShot, abortSignal } = options;
  const maxShots = options.maxShots ?? config.rows * config.cols;

  const board = new Board(config, fleet);
  const shots: ShotRecord[] = [];

  while (!board.isFleetSunk && shots.length < maxShots) {
    abortSignal?.throwIfAborted();

    const startedAt = performance.now();
    const decision = await strategy.nextShot(board.view(), rng);
    const latencyMs = performance.now() - startedAt;

    if (board.hasBeenShot(decision.coord)) {
      throw new Error(
        `Strategy "${strategy.id}" chose ${coordToLabel(decision.coord)}, which was already fired at`,
      );
    }

    const outcome = board.fire(decision.coord);
    const record: ShotRecord = {
      index: shots.length + 1,
      label: coordToLabel(decision.coord),
      outcome,
      latencyMs,
      heatmap: decision.heatmap,
      confidence: decision.confidence,
      notes: decision.notes,
      usage: decision.usage,
      modelId: decision.modelId,
    };
    shots.push(record);
    onShot?.(record, board);
  }

  const hits = shots.filter((s) => s.outcome.result !== 'miss').length;
  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    seed,
    config,
    fleet,
    shots,
    shotCount: shots.length,
    hits,
    misses: shots.length - hits,
    won: board.isFleetSunk,
    totalLatencyMs: shots.reduce((sum, s) => sum + s.latencyMs, 0),
    totalInputTokens: shots.reduce((sum, s) => sum + (s.usage?.inputTokens ?? 0), 0),
    totalOutputTokens: shots.reduce((sum, s) => sum + (s.usage?.outputTokens ?? 0), 0),
    perfectScore: totalShipCells(config),
  };
}
