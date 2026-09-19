import { describe, expect, it } from 'vitest';
import { makeConfig, totalShipCells } from '../config.js';
import { LAYOUT_FAMILIES, makeLayout, makeLayoutSet } from '../layouts.js';
import { validateFleet } from '../placement.js';
import { makeRng } from '../rng.js';
import type { Coord } from '../types.js';

const config = makeConfig();
const onEdge = (c: Coord) => c.row === 0 || c.col === 0 || c.row === 9 || c.col === 9;

describe('layout families', () => {
  it('every family produces a legal fleet across many seeds', () => {
    for (const family of LAYOUT_FAMILIES) {
      for (let seed = 0; seed < 40; seed++) {
        const fleet = makeLayout(family, config, makeRng(seed));
        expect(validateFleet(fleet, config), `${family} seed ${seed}`).toEqual([]);
        expect(fleet.flatMap((s) => s.cells)).toHaveLength(totalShipCells(config));
        expect(fleet.map((s) => s.id)).toEqual(config.fleet.map((s) => s.id));
      }
    }
  });

  it('is deterministic for a seed', () => {
    for (const family of LAYOUT_FAMILIES) {
      expect(makeLayout(family, config, makeRng(5))).toEqual(makeLayout(family, config, makeRng(5)));
    }
  });

  it('edge layouts really do hug the edge', () => {
    for (let seed = 0; seed < 25; seed++) {
      const fleet = makeLayout('edge', config, makeRng(seed));
      expect(fleet.every((s) => s.cells.every(onEdge))).toBe(true);
    }
  });

  it('centre layouts really do avoid the edge', () => {
    for (let seed = 0; seed < 25; seed++) {
      const fleet = makeLayout('centre', config, makeRng(seed));
      expect(fleet.every((s) => s.cells.every((c) => !onEdge(c)))).toBe(true);
    }
  });

  it('adversarial layouts sit further from the centre than random ones', () => {
    // The whole point: they avoid where a uniform prior expects ships.
    const meanEdgeShare = (family: 'random' | 'adversarial') => {
      let total = 0;
      for (let seed = 0; seed < 40; seed++) {
        const cells = makeLayout(family, config, makeRng(seed)).flatMap((s) => s.cells);
        total += cells.filter(onEdge).length / cells.length;
      }
      return total / 40;
    };
    expect(meanEdgeShare('adversarial')).toBeGreaterThan(meanEdgeShare('random'));
  });
});

describe('makeLayoutSet', () => {
  it('returns the requested number of legal layouts', () => {
    for (const family of LAYOUT_FAMILIES) {
      const set = makeLayoutSet(family, 8, config, 1);
      expect(set).toHaveLength(8);
      for (const fleet of set) expect(validateFleet(fleet, config)).toEqual([]);
    }
  });

  it('keeps a mixed set balanced in any prefix', () => {
    // A run cut short by rate limits must not end up all one family.
    const set = makeLayoutSet('mixed', 8, config, 1);
    const edgeShare = (fleet: (typeof set)[number]) => {
      const cells = fleet.flatMap((s) => s.cells);
      return cells.filter(onEdge).length / cells.length;
    };

    // Positions 1 and 5 are both 'random'; 2 and 6 both 'edge'.
    expect(edgeShare(set[1]!)).toBe(1);
    expect(edgeShare(set[5]!)).toBe(1);
    expect(edgeShare(set[2]!)).toBe(0);
    expect(edgeShare(set[6]!)).toBe(0);
  });

  it('is deterministic for a seed', () => {
    expect(makeLayoutSet('mixed', 4, config, 3)).toEqual(makeLayoutSet('mixed', 4, config, 3));
  });
});
