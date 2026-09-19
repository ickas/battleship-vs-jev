import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { makeConfig } from '../config.js';
import { computeDensity } from '../density.js';
import { toPlacedShip } from '../placement.js';
import type { BoardView, PlacedShip } from '../types.js';

/**
 * Independent check of the density counts.
 *
 * The production code counts placements via `candidatePlacements` and
 * `placementFits`. These tests re-derive the same numbers by brute force from
 * first principles, so a bug in the shared helpers cannot hide behind a test
 * that reuses them. A wrong density silently degrades the strongest baseline
 * and every jevHybrid shortlist, so it is worth checking exactly.
 */
const config = makeConfig();

function fleet(): PlacedShip[] {
  return [
    toPlacedShip(config.fleet[0]!, { row: 0, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[1]!, { row: 2, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[2]!, { row: 4, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[3]!, { row: 6, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[4]!, { row: 8, col: 0 }, 'horizontal'),
  ];
}

/** Brute-force count of placements covering (row, col), written independently. */
function bruteForceCount(view: BoardView, row: number, col: number): number {
  const { rows, cols } = view.config;
  const blocked = (r: number, c: number) => {
    const state = view.cells[r]![c]!;
    return state === 'miss' || state === 'sunk';
  };

  let total = 0;
  for (const length of view.remainingShipLengths) {
    // Horizontal runs through (row, col).
    for (let start = col - length + 1; start <= col; start++) {
      if (start < 0 || start + length > cols) continue;
      let ok = true;
      for (let i = 0; i < length; i++) if (blocked(row, start + i)) ok = false;
      if (ok) total++;
    }
    // Vertical runs through (row, col).
    for (let start = row - length + 1; start <= row; start++) {
      if (start < 0 || start + length > rows) continue;
      let ok = true;
      for (let i = 0; i < length; i++) if (blocked(start + i, col)) ok = false;
      if (ok) total++;
    }
  }
  return total;
}

describe('density counts exactly', () => {
  it('matches a brute-force count at every cell on an empty board', () => {
    const view = new Board(config, fleet()).view();
    const { weights } = computeDensity(view);

    for (let row = 0; row < config.rows; row++) {
      for (let col = 0; col < config.cols; col++) {
        expect(weights[row]![col]).toBe(bruteForceCount(view, row, col));
      }
    }
  });

  it('matches a brute-force count after a scatter of misses', () => {
    const board = new Board(config, fleet());
    // Fire into open water only, so no live hits complicate the weighting.
    for (const coord of [
      { row: 9, col: 9 },
      { row: 9, col: 0 },
      { row: 5, col: 5 },
      { row: 3, col: 7 },
      { row: 7, col: 3 },
    ]) {
      expect(board.fire(coord).result).toBe('miss');
    }

    const view = board.view();
    const { weights } = computeDensity(view);
    for (let row = 0; row < config.rows; row++) {
      for (let col = 0; col < config.cols; col++) {
        expect(weights[row]![col]).toBe(bruteForceCount(view, row, col));
      }
    }
  });

  it('gives the empty-board corner and centre their exact values', () => {
    // Pinned so a change in the counting logic has to be deliberate.
    const view = new Board(config, fleet()).view();
    const { weights } = computeDensity(view);

    expect(weights[0]![0]).toBe(10);
    expect(weights[4]![4]).toBe(34);
    expect(weights[0]![9]).toBe(10);
    expect(weights[9]![9]).toBe(10);
  });
});

describe('density under the no-touching rule', () => {
  const strict = makeConfig({ allowTouching: false });

  it('rules out every cell adjacent to a sunk ship', () => {
    const strictFleet: PlacedShip[] = [
      toPlacedShip(strict.fleet[0]!, { row: 0, col: 0 }, 'horizontal'),
      toPlacedShip(strict.fleet[1]!, { row: 2, col: 0 }, 'horizontal'),
      toPlacedShip(strict.fleet[2]!, { row: 4, col: 0 }, 'horizontal'),
      toPlacedShip(strict.fleet[3]!, { row: 6, col: 0 }, 'horizontal'),
      toPlacedShip(strict.fleet[4]!, { row: 8, col: 0 }, 'horizontal'),
    ];
    const board = new Board(strict, strictFleet);

    // Sink the destroyer at A9-B9.
    board.fire({ row: 8, col: 0 });
    board.fire({ row: 8, col: 1 });
    expect(board.isSunk('destroyer')).toBe(true);

    const { weights } = computeDensity(board.view());

    // Ships may not touch, so every neighbour of the sunk ship is impossible.
    for (const [row, col] of [
      [7, 0],
      [7, 1],
      [7, 2],
      [9, 0],
      [9, 1],
      [9, 2],
      [8, 2],
    ] as const) {
      expect(weights[row]![col]).toBe(0);
    }
    // A cell far from it is still live.
    expect(weights[3]![5]!).toBeGreaterThan(0);
  });

  it('leaves those cells available when touching is allowed', () => {
    const board = new Board(config, fleet());
    board.fire({ row: 8, col: 0 });
    board.fire({ row: 8, col: 1 });

    const { weights } = computeDensity(board.view());
    expect(weights[7]![0]!).toBeGreaterThan(0);
    expect(weights[9]![0]!).toBeGreaterThan(0);
  });
});
