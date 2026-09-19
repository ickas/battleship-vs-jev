import { describe, expect, it } from 'vitest';
import { makeConfig, totalShipCells } from '../config.js';
import { coordKey } from '../coords.js';
import {
  candidatePlacements,
  isValidFleet,
  placementFits,
  randomFleet,
  toPlacedShip,
  validateFleet,
} from '../placement.js';
import { makeRng } from '../rng.js';
import type { PlacedShip } from '../types.js';

const config = makeConfig();
const strict = makeConfig({ allowTouching: false });

describe('candidatePlacements', () => {
  it('counts placements correctly on a 10x10 board', () => {
    // A length-5 ship has 6 bow positions per row/column, in two orientations.
    expect(candidatePlacements(5, config)).toHaveLength(6 * 10 * 2);
    expect(candidatePlacements(2, config)).toHaveLength(9 * 10 * 2);
  });

  it('counts a length-1 ship once per cell, not twice', () => {
    expect(candidatePlacements(1, config)).toHaveLength(100);
  });

  it('never leaves the board', () => {
    for (const c of candidatePlacements(4, config)) {
      for (const cell of c.cells) {
        expect(cell.row).toBeGreaterThanOrEqual(0);
        expect(cell.row).toBeLessThan(config.rows);
        expect(cell.col).toBeGreaterThanOrEqual(0);
        expect(cell.col).toBeLessThan(config.cols);
      }
    }
  });
});

describe('placementFits', () => {
  it('rejects overlap', () => {
    const occupied = new Set([coordKey({ row: 0, col: 1 })]);
    const cells = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ];
    expect(placementFits(cells, occupied, config)).toBe(false);
  });

  it('allows touching when the config allows it, and rejects it when not', () => {
    const occupied = new Set([coordKey({ row: 1, col: 0 })]);
    const cells = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ];
    expect(placementFits(cells, occupied, config)).toBe(true);
    expect(placementFits(cells, occupied, strict)).toBe(false);
  });

  it('rejects diagonal contact in strict mode', () => {
    const occupied = new Set([coordKey({ row: 1, col: 2 })]);
    const cells = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ];
    expect(placementFits(cells, occupied, strict)).toBe(false);
  });
});

describe('validateFleet', () => {
  const valid = (): PlacedShip[] => [
    toPlacedShip(config.fleet[0]!, { row: 0, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[1]!, { row: 2, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[2]!, { row: 4, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[3]!, { row: 6, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[4]!, { row: 8, col: 0 }, 'horizontal'),
  ];

  it('accepts a well-formed fleet', () => {
    expect(validateFleet(valid(), config)).toEqual([]);
    expect(isValidFleet(valid(), config)).toBe(true);
  });

  it('rejects a missing ship', () => {
    expect(validateFleet(valid().slice(1), config).join(' ')).toContain('Expected 5 ships');
  });

  it('rejects overlapping ships', () => {
    const fleet = valid();
    fleet[1] = toPlacedShip(config.fleet[1]!, { row: 0, col: 0 }, 'horizontal');
    expect(validateFleet(fleet, config).join(' ')).toContain('overlaps');
  });

  it('rejects a ship that leaves the board', () => {
    const fleet = valid();
    fleet[0] = toPlacedShip(config.fleet[0]!, { row: 0, col: 8 }, 'horizontal');
    expect(validateFleet(fleet, config).join(' ')).toContain('leaves the board');
  });

  it('rejects a ship whose cells repeat a coordinate', () => {
    // Such a ship covers fewer distinct cells than its length, so it could
    // never be sunk and the game would be unwinnable.
    const fleet = valid();
    fleet[0] = {
      ...fleet[0]!,
      cells: [
        { row: 0, col: 0 },
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 0, col: 2 },
        { row: 0, col: 3 },
      ],
    };
    expect(validateFleet(fleet, config).join(' ')).toContain('straight horizontal run');
  });

  it('rejects a ship whose cells are scattered rather than contiguous', () => {
    const fleet = valid();
    fleet[0] = {
      ...fleet[0]!,
      cells: [
        { row: 0, col: 0 },
        { row: 0, col: 2 },
        { row: 0, col: 4 },
        { row: 0, col: 6 },
        { row: 0, col: 8 },
      ],
    };
    expect(validateFleet(fleet, config).join(' ')).toContain('straight horizontal run');
  });

  it('rejects cells that disagree with the declared bow or orientation', () => {
    const fleet = valid();
    fleet[0] = { ...fleet[0]!, bow: { row: 5, col: 5 } };
    expect(validateFleet(fleet, config).join(' ')).toContain('straight horizontal run');

    const flipped = valid();
    flipped[0] = { ...flipped[0]!, orientation: 'vertical' };
    expect(validateFleet(flipped, config).join(' ')).toContain('straight vertical run');
  });

  it('accepts every ship produced by toPlacedShip', () => {
    // The constructor and the validator must agree, or valid play breaks.
    for (const orientation of ['horizontal', 'vertical'] as const) {
      const fleet = config.fleet.map((spec, i) =>
        toPlacedShip(spec, orientation === 'horizontal' ? { row: i * 2, col: 0 } : { row: 0, col: i * 2 }, orientation),
      );
      expect(validateFleet(fleet, config)).toEqual([]);
    }
  });

  it('rejects touching ships only in strict mode', () => {
    const fleet = [
      toPlacedShip(strict.fleet[0]!, { row: 0, col: 0 }, 'horizontal'),
      toPlacedShip(strict.fleet[1]!, { row: 1, col: 0 }, 'horizontal'),
      toPlacedShip(strict.fleet[2]!, { row: 4, col: 0 }, 'horizontal'),
      toPlacedShip(strict.fleet[3]!, { row: 6, col: 0 }, 'horizontal'),
      toPlacedShip(strict.fleet[4]!, { row: 8, col: 0 }, 'horizontal'),
    ];
    expect(isValidFleet(fleet, config)).toBe(true);
    expect(validateFleet(fleet, strict).join(' ')).toContain('touches');
  });
});

describe('randomFleet', () => {
  it('produces a valid fleet for many seeds, in both modes', () => {
    for (let seed = 0; seed < 100; seed++) {
      const loose = randomFleet(config, makeRng(seed));
      expect(validateFleet(loose, config)).toEqual([]);
      expect(loose.flatMap((s) => s.cells)).toHaveLength(totalShipCells(config));

      const tight = randomFleet(strict, makeRng(seed));
      expect(validateFleet(tight, strict)).toEqual([]);
    }
  });

  it('is deterministic for a given seed and returns ships in config order', () => {
    expect(randomFleet(config, makeRng(42))).toEqual(randomFleet(config, makeRng(42)));
    expect(randomFleet(config, makeRng(42)).map((s) => s.id)).toEqual(
      config.fleet.map((s) => s.id),
    );
  });

  it('produces different layouts for different seeds', () => {
    const a = JSON.stringify(randomFleet(config, makeRng(1)));
    const b = JSON.stringify(randomFleet(config, makeRng(2)));
    expect(a).not.toBe(b);
  });
});
