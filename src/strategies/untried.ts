import type { BoardView, Coord } from '../engine/types.js';

/** Cells that have not been fired at yet — the only legal targets. */
export function untriedCells(view: BoardView): Coord[] {
  const result: Coord[] = [];
  for (let row = 0; row < view.config.rows; row++) {
    for (let col = 0; col < view.config.cols; col++) {
      if (view.cells[row]![col] === 'unknown') result.push({ row, col });
    }
  }
  return result;
}

/** Hit cells whose ship has not been sunk yet — the live leads worth chasing. */
export function unresolvedHits(view: BoardView): Coord[] {
  const result: Coord[] = [];
  for (let row = 0; row < view.config.rows; row++) {
    for (let col = 0; col < view.config.cols; col++) {
      if (view.cells[row]![col] === 'hit') result.push({ row, col });
    }
  }
  return result;
}
