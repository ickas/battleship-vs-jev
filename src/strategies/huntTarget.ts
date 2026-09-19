import { orthogonalNeighbours } from '../engine/coords.js';
import type { Rng } from '../engine/rng.js';
import type { BoardView, Coord } from '../engine/types.js';
import type { ShotDecision, Strategy } from './types.js';
import { untriedCells, unresolvedHits } from './untried.js';

/**
 * The classic baseline. In "target" mode it works outwards from unsunk hits,
 * extending along an established line when two hits already share a row or
 * column. In "hunt" mode it fires on a parity lattice: the shortest ship covers
 * two cells, so half the board is enough to find every ship.
 */
export class HuntTargetStrategy implements Strategy {
  readonly id = 'huntTarget';
  readonly name = 'Hunt / Target';
  readonly usesModel = false;

  async nextShot(view: BoardView, rng: Rng): Promise<ShotDecision> {
    const untried = untriedCells(view);
    if (untried.length === 0) throw new Error('No untried cells left to fire at');

    const targets = this.targetCells(view);
    if (targets.length > 0) {
      return { coord: rng.pick(targets), notes: 'target: adjacent to an unsunk hit' };
    }

    const minLength = Math.min(...view.remainingShipLengths, 2);
    const parity = untried.filter((c) => (c.row + c.col) % minLength === 0);
    const pool = parity.length > 0 ? parity : untried;
    return { coord: rng.pick(pool), notes: `hunt: parity ${minLength} lattice` };
  }

  /** Untried cells adjacent to a live hit, preferring cells that extend a known line. */
  private targetCells(view: BoardView): Coord[] {
    const hits = unresolvedHits(view);
    if (hits.length === 0) return [];

    const isUntried = (c: Coord) => view.cells[c.row]![c.col] === 'unknown';
    const hitAt = (row: number, col: number) =>
      row >= 0 &&
      row < view.config.rows &&
      col >= 0 &&
      col < view.config.cols &&
      view.cells[row]![col] === 'hit';

    const aligned: Coord[] = [];
    for (const hit of hits) {
      // Horizontal run: extend past either end.
      if (hitAt(hit.row, hit.col - 1) || hitAt(hit.row, hit.col + 1)) {
        let left = hit.col;
        while (hitAt(hit.row, left - 1)) left--;
        let right = hit.col;
        while (hitAt(hit.row, right + 1)) right++;
        for (const c of [
          { row: hit.row, col: left - 1 },
          { row: hit.row, col: right + 1 },
        ]) {
          if (c.col >= 0 && c.col < view.config.cols && isUntried(c)) aligned.push(c);
        }
      }
      // Vertical run.
      if (hitAt(hit.row - 1, hit.col) || hitAt(hit.row + 1, hit.col)) {
        let top = hit.row;
        while (hitAt(top - 1, hit.col)) top--;
        let bottom = hit.row;
        while (hitAt(bottom + 1, hit.col)) bottom++;
        for (const c of [
          { row: top - 1, col: hit.col },
          { row: bottom + 1, col: hit.col },
        ]) {
          if (c.row >= 0 && c.row < view.config.rows && isUntried(c)) aligned.push(c);
        }
      }
    }
    if (aligned.length > 0) return dedupe(aligned);

    // No line established yet: probe around every live hit.
    return dedupe(hits.flatMap((h) => orthogonalNeighbours(h, view.config).filter(isUntried)));
  }
}

function dedupe(coords: Coord[]): Coord[] {
  const seen = new Set<string>();
  return coords.filter((c) => {
    const key = `${c.row},${c.col}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
