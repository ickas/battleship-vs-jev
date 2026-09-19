import { describe, expect, it } from 'vitest';
import {
  allCoords,
  coordToLabel,
  inBounds,
  labelToCoord,
  orthogonalNeighbours,
  shipCells,
  surroundingCells,
} from '../coords.js';
import { makeConfig } from '../config.js';

const config = makeConfig();

describe('coordToLabel / labelToCoord', () => {
  it('maps the corners of a 10x10 board', () => {
    expect(coordToLabel({ row: 0, col: 0 })).toBe('A1');
    expect(coordToLabel({ row: 9, col: 9 })).toBe('J10');
    expect(labelToCoord('A1')).toEqual({ row: 0, col: 0 });
    expect(labelToCoord('J10')).toEqual({ row: 9, col: 9 });
  });

  it('round-trips every cell on the board', () => {
    for (const coord of allCoords(config)) {
      expect(labelToCoord(coordToLabel(coord))).toEqual(coord);
    }
  });

  it('accepts lowercase and surrounding whitespace', () => {
    expect(labelToCoord(' c7 ')).toEqual({ row: 6, col: 2 });
  });

  it('rejects malformed labels', () => {
    expect(() => labelToCoord('1A')).toThrow();
    expect(() => labelToCoord('AA1')).toThrow();
    expect(() => labelToCoord('')).toThrow();
  });
});

describe('shipCells', () => {
  it('extends right when horizontal and down when vertical', () => {
    expect(shipCells({ row: 2, col: 3 }, 3, 'horizontal')).toEqual([
      { row: 2, col: 3 },
      { row: 2, col: 4 },
      { row: 2, col: 5 },
    ]);
    expect(shipCells({ row: 2, col: 3 }, 3, 'vertical')).toEqual([
      { row: 2, col: 3 },
      { row: 3, col: 3 },
      { row: 4, col: 3 },
    ]);
  });
});

describe('neighbours', () => {
  it('clips to the board at a corner', () => {
    expect(orthogonalNeighbours({ row: 0, col: 0 }, config)).toHaveLength(2);
    expect(surroundingCells({ row: 0, col: 0 }, config)).toHaveLength(3);
  });

  it('returns the full set in the middle', () => {
    expect(orthogonalNeighbours({ row: 5, col: 5 }, config)).toHaveLength(4);
    expect(surroundingCells({ row: 5, col: 5 }, config)).toHaveLength(8);
  });
});

describe('inBounds', () => {
  it('rejects negative and overflowing coordinates', () => {
    expect(inBounds({ row: -1, col: 0 }, config)).toBe(false);
    expect(inBounds({ row: 0, col: 10 }, config)).toBe(false);
    expect(inBounds({ row: 9, col: 9 }, config)).toBe(true);
  });
});
