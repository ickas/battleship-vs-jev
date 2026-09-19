import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { makeConfig } from '../config.js';
import { computeDensity, topCandidates } from '../density.js';
import { toPlacedShip } from '../placement.js';
import type { BoardView, PlacedShip } from '../types.js';

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

describe('computeDensity on an empty board', () => {
  const view: BoardView = new Board(config, fleet()).view();
  const { weights, probabilities, total } = computeDensity(view);

  it('favours the centre over the corners', () => {
    expect(weights[4]![4]!).toBeGreaterThan(weights[0]![0]!);
  });

  it('is symmetric across the board', () => {
    expect(weights[0]![0]).toBe(weights[0]![9]);
    expect(weights[0]![0]).toBe(weights[9]![9]);
    expect(weights[2]![3]).toBe(weights[7]![6]);
  });

  it('produces a normalized distribution', () => {
    expect(total).toBeGreaterThan(0);
    const sum = probabilities.flat().reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe('computeDensity with observations', () => {
  it('assigns zero weight to cells already fired at', () => {
    const board = new Board(config, fleet());
    board.fire({ row: 9, col: 9 });
    const { weights } = computeDensity(board.view());
    expect(weights[9]![9]).toBe(0);
  });

  it('concentrates around an unsunk hit', () => {
    const board = new Board(config, fleet());
    board.fire({ row: 2, col: 2 }); // hits the battleship
    const { weights } = computeDensity(board.view());
    // Neighbours of the live hit outrank a distant cell.
    expect(weights[2]![3]!).toBeGreaterThan(weights[7]![7]!);
    expect(weights[2]![1]!).toBeGreaterThan(weights[7]![7]!);
  });

  it('extends along an established line', () => {
    const board = new Board(config, fleet());
    board.fire({ row: 2, col: 1 });
    board.fire({ row: 2, col: 2 });
    const { weights } = computeDensity(board.view());
    // Continuing the horizontal run beats breaking off vertically.
    expect(weights[2]![3]!).toBeGreaterThan(weights[1]![2]!);
    expect(weights[2]![0]!).toBeGreaterThan(weights[3]![2]!);
  });

  it('ignores the cells of a ship that is already sunk', () => {
    const board = new Board(config, fleet());
    board.fire({ row: 8, col: 0 });
    board.fire({ row: 8, col: 1 });
    const { weights } = computeDensity(board.view());
    expect(weights[8]![0]).toBe(0);
    expect(weights[8]![1]).toBe(0);
  });
});

describe('topCandidates', () => {
  it('returns k untried cells in descending weight order', () => {
    const board = new Board(config, fleet());
    board.fire({ row: 2, col: 2 });
    const top = topCandidates(board.view(), 8);

    expect(top).toHaveLength(8);
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1]!.weight).toBeGreaterThanOrEqual(top[i]!.weight);
    }
    for (const c of top) {
      expect(board.view().cells[c.coord.row]![c.coord.col]).toBe('unknown');
    }
  });

  it('is deterministic across calls', () => {
    const view = new Board(config, fleet()).view();
    expect(topCandidates(view, 10)).toEqual(topCandidates(view, 10));
  });

  it('never returns more cells than remain', () => {
    const board = new Board(config, fleet());
    for (let col = 0; col < 10; col++) {
      for (let row = 0; row < 9; row++) board.fire({ row, col });
    }
    expect(topCandidates(board.view(), 50).length).toBe(10);
  });
});
