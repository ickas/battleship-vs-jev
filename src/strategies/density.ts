import { computeDensity } from '../engine/density.js';
import type { Rng } from '../engine/rng.js';
import type { BoardView } from '../engine/types.js';
import { normalizeHeatmap, type ShotDecision, type Strategy } from './types.js';
import { untriedCells } from './untried.js';

/**
 * Fires at the cell covered by the most valid remaining-ship placements.
 * The strongest player here that uses no model at all, and the bar Jev has to clear.
 */
export class DensityStrategy implements Strategy {
  readonly id = 'density';
  readonly name = 'Probability density';
  readonly usesModel = false;

  async nextShot(view: BoardView, rng: Rng): Promise<ShotDecision> {
    const untried = untriedCells(view);
    if (untried.length === 0) throw new Error('No untried cells left to fire at');

    const { weights } = computeDensity(view);

    let best = untried[0]!;
    let bestWeight = -1;
    const ties: typeof untried = [];
    for (const coord of untried) {
      const weight = weights[coord.row]![coord.col]!;
      if (weight > bestWeight) {
        bestWeight = weight;
        best = coord;
        ties.length = 0;
        ties.push(coord);
      } else if (weight === bestWeight) {
        ties.push(coord);
      }
    }

    // Every remaining cell scored zero (possible only in degenerate states): fall back.
    const coord = bestWeight <= 0 ? rng.pick(untried) : rng.pick(ties);

    return {
      coord,
      heatmap: normalizeHeatmap(weights),
      notes: `density: ${bestWeight} placements cover the chosen cell`,
    };
  }
}
