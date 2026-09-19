import type { BoardView, Coord, GameConfig, PlacedShip } from '../engine/types.js';
import type { Rng } from '../engine/rng.js';

/** Per-cell probabilities in [0,1], indexed `[row][col]`. Rendered as the UI heatmap. */
export type Heatmap = number[][];

export interface ShotDecision {
  coord: Coord;
  /**
   * The strategy's belief per cell, when it has one. Code strategies derive it
   * from position counting; Jev strategies pass through the model's own
   * per-option probabilities.
   */
  heatmap?: Heatmap;
  /**
   * Where `heatmap` came from. 'model' means Jev's own per-option
   * probabilities; 'code-density' means the model returned no distribution and
   * the code-side ranking is being shown instead.
   */
  heatmapSource?: 'model' | 'code-density';
  /** Model-reported confidence, when the decision came from Jev. */
  confidence?: number;
  /** Free-form detail for the metrics panel and logs. */
  notes?: string;
  /** Token usage reported by the model for this decision. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Resolved model id, recorded so results are comparable only within a version. */
  modelId?: string;
}

export interface PlacementContext {
  config: GameConfig;
  rng: Rng;
  /** Semantic summaries of the opponent's past behaviour, when history is enabled. */
  historySummary?: string[];
}

export interface Strategy {
  /** Stable id used in benchmark output. */
  readonly id: string;
  readonly name: string;
  /** True when the strategy calls Jev, so the bench can account for cost and latency. */
  readonly usesModel: boolean;

  /** Chooses the next cell to fire at. Must return a cell that is still 'unknown'. */
  nextShot(view: BoardView, rng: Rng): Promise<ShotDecision>;

  /** Lays out a fleet. Defaults to a random valid layout when not implemented. */
  placeFleet?(context: PlacementContext): Promise<PlacedShip[]>;
}

export function emptyHeatmap(config: GameConfig): Heatmap {
  return Array.from({ length: config.rows }, () => Array.from({ length: config.cols }, () => 0));
}

/** Scales a grid of non-negative weights so the maximum becomes 1. Used for display. */
export function normalizeHeatmap(weights: number[][]): Heatmap {
  let max = 0;
  for (const row of weights) for (const w of row) if (w > max) max = w;
  if (max <= 0) return weights.map((row) => row.map(() => 0));
  return weights.map((row) => row.map((w) => w / max));
}
