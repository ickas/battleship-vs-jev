import { describe, expect, it } from 'vitest';
import { Board } from '../board.js';
import { makeConfig, totalShipCells } from '../config.js';
import { randomFleet, toPlacedShip } from '../placement.js';
import { makeRng } from '../rng.js';
import type { PlacedShip } from '../types.js';

const config = makeConfig();

function fixedFleet(): PlacedShip[] {
  return [
    toPlacedShip(config.fleet[0]!, { row: 0, col: 0 }, 'horizontal'), // carrier A1-E1
    toPlacedShip(config.fleet[1]!, { row: 2, col: 0 }, 'horizontal'), // battleship
    toPlacedShip(config.fleet[2]!, { row: 4, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[3]!, { row: 6, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[4]!, { row: 8, col: 0 }, 'horizontal'), // destroyer A9-B9
  ];
}

describe('Board construction', () => {
  it('rejects an invalid layout', () => {
    const fleet = fixedFleet();
    fleet[1] = toPlacedShip(config.fleet[1]!, { row: 0, col: 0 }, 'horizontal');
    expect(() => new Board(config, fleet)).toThrow(/Invalid fleet layout/);
  });
});

describe('fire', () => {
  it('reports a miss on empty water', () => {
    const board = new Board(config, fixedFleet());
    expect(board.fire({ row: 9, col: 9 }).result).toBe('miss');
  });

  it('reports hit, then sunk on the final cell of a ship', () => {
    const board = new Board(config, fixedFleet());
    expect(board.fire({ row: 8, col: 0 }).result).toBe('hit');
    const last = board.fire({ row: 8, col: 1 });
    expect(last.result).toBe('sunk');
    expect(last.shipId).toBe('destroyer');
    expect(board.isSunk('destroyer')).toBe(true);
  });

  it('rejects a repeated shot', () => {
    const board = new Board(config, fixedFleet());
    board.fire({ row: 0, col: 0 });
    expect(() => board.fire({ row: 0, col: 0 })).toThrow(/already been fired at/);
  });

  it('rejects an out-of-bounds shot', () => {
    const board = new Board(config, fixedFleet());
    expect(() => board.fire({ row: 10, col: 0 })).toThrow(/out of bounds/);
    expect(() => board.fire({ row: -1, col: 0 })).toThrow(/out of bounds/);
  });

  it('sets gameOver only on the very last ship cell', () => {
    const board = new Board(config, fixedFleet());
    const all = fixedFleet().flatMap((s) => s.cells);
    const outcomes = all.map((c) => board.fire(c));
    expect(outcomes.filter((o) => o.gameOver)).toHaveLength(1);
    expect(outcomes.at(-1)!.gameOver).toBe(true);
    expect(board.isFleetSunk).toBe(true);
    expect(board.shotCount).toBe(totalShipCells(config));
  });
});

describe('view', () => {
  it('hides ship positions and starts fully unknown', () => {
    const board = new Board(config, fixedFleet());
    const view = board.view();
    expect(view.cells.flat().every((c) => c === 'unknown')).toBe(true);
    expect(JSON.stringify(view)).not.toContain('bow');
    expect(view.remainingShipLengths).toEqual([5, 4, 3, 3, 2]);
  });

  it('upgrades hit cells to sunk once the ship goes down', () => {
    const board = new Board(config, fixedFleet());
    board.fire({ row: 8, col: 0 });
    expect(board.view().cells[8]![0]).toBe('hit');
    board.fire({ row: 8, col: 1 });
    const view = board.view();
    expect(view.cells[8]![0]).toBe('sunk');
    expect(view.cells[8]![1]).toBe('sunk');
    expect(view.sunkShipIds).toEqual(['destroyer']);
    expect(view.remainingShipLengths).toEqual([5, 4, 3, 3]);
  });

  it('returns a detached copy of history', () => {
    const board = new Board(config, fixedFleet());
    board.fire({ row: 9, col: 9 });
    const view = board.view();
    view.history[0]!.result = 'hit';
    expect(board.history[0]!.result).toBe('miss');
  });
});

describe('random boards', () => {
  it('always ends after every ship cell is hit, for many seeds', () => {
    for (let seed = 0; seed < 30; seed++) {
      const fleet = randomFleet(config, makeRng(seed));
      const board = new Board(config, fleet);
      for (const cell of fleet.flatMap((s) => s.cells)) board.fire(cell);
      expect(board.isFleetSunk).toBe(true);
    }
  });
});
