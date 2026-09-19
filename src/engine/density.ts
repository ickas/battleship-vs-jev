import { candidatePlacements, placementFits } from './placement.js';
import { coordKey } from './coords.js';
import type { BoardView, Coord } from './types.js';

/**
 * Probability density over the board: for each cell, how many valid placements
 * of the remaining ships would cover it, given everything observed so far.
 *
 * A placement is valid when it stays on the board, avoids misses and sunk-ship
 * cells, and — when `allowTouching` is false — does not touch a sunk ship.
 * Placements covering unsunk hits are weighted up by `hitWeight` per hit, which
 * is what makes the density concentrate around a live lead.
 *
 * This is the "all arithmetic lives in code" half of the design: Jev never
 * counts positions, it only judges the candidates this produces.
 */
export interface DensityOptions {
  /** Multiplier applied per unsunk hit a placement covers. */
  hitWeight?: number;
}

export interface DensityResult {
  /** Raw placement counts per cell, `[row][col]`. Untried cells only; others are 0. */
  weights: number[][];
  /** `weights` scaled to sum to 1 across the board. Zero grid if nothing is possible. */
  probabilities: number[][];
  /** Total weight summed over the board. */
  total: number;
}

export function computeDensity(view: BoardView, options: DensityOptions = {}): DensityResult {
  const hitWeight = options.hitWeight ?? 12;
  const { config } = view;

  const blocked = new Set<string>();
  const liveHits = new Set<string>();
  for (let row = 0; row < config.rows; row++) {
    for (let col = 0; col < config.cols; col++) {
      const state = view.cells[row]![col];
      const key = coordKey({ row, col });
      // A ship still afloat cannot sit on a miss or on an already-sunk ship.
      if (state === 'miss' || state === 'sunk') blocked.add(key);
      if (state === 'hit') liveHits.add(key);
    }
  }

  // With no-touching rules, cells adjacent to a sunk ship cannot hold another ship.
  if (!config.allowTouching) {
    for (let row = 0; row < config.rows; row++) {
      for (let col = 0; col < config.cols; col++) {
        if (view.cells[row]![col] !== 'sunk') continue;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const r = row + dr;
            const c = col + dc;
            if (r < 0 || r >= config.rows || c < 0 || c >= config.cols) continue;
            if (view.cells[r]![c] === 'unknown') blocked.add(coordKey({ row: r, col: c }));
          }
        }
      }
    }
  }

  const weights = Array.from({ length: config.rows }, () =>
    Array.from({ length: config.cols }, () => 0),
  );

  for (const length of view.remainingShipLengths) {
    for (const candidate of candidatePlacements(length, config)) {
      if (!placementFits(candidate.cells, blocked, { ...config, allowTouching: true })) continue;

      let coveredHits = 0;
      for (const cell of candidate.cells) if (liveHits.has(coordKey(cell))) coveredHits++;
      const weight = Math.pow(hitWeight, coveredHits);

      for (const cell of candidate.cells) {
        // Only untried cells are worth firing at; hits already covered count
        // towards the weight but are not themselves targets.
        if (view.cells[cell.row]![cell.col] === 'unknown') {
          weights[cell.row]![cell.col]! += weight;
        }
      }
    }
  }

  let total = 0;
  for (const row of weights) for (const w of row) total += w;

  const probabilities =
    total > 0
      ? weights.map((row) => row.map((w) => w / total))
      : weights.map((row) => row.map(() => 0));

  return { weights, probabilities, total };
}

export interface RankedCell {
  coord: Coord;
  weight: number;
  probability: number;
}

/** The `k` highest-density untried cells, best first. Ties broken by position for determinism. */
export function topCandidates(view: BoardView, k: number, options?: DensityOptions): RankedCell[] {
  const { weights, probabilities } = computeDensity(view, options);
  const ranked: RankedCell[] = [];

  for (let row = 0; row < view.config.rows; row++) {
    for (let col = 0; col < view.config.cols; col++) {
      if (view.cells[row]![col] !== 'unknown') continue;
      ranked.push({
        coord: { row, col },
        weight: weights[row]![col]!,
        probability: probabilities[row]![col]!,
      });
    }
  }

  ranked.sort(
    (a, b) =>
      b.weight - a.weight || a.coord.row - b.coord.row || a.coord.col - b.coord.col,
  );
  return ranked.slice(0, k);
}
