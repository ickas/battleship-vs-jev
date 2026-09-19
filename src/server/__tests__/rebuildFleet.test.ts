import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/config.js';
import { randomFleet, validateFleet } from '../../engine/placement.js';
import { makeRng } from '../../engine/rng.js';
import { rebuildFleet } from '../fleetInput.js';

const config = makeConfig();

describe('rebuildFleet', () => {
  it('round-trips a legitimate fleet unchanged', () => {
    const fleet = randomFleet(config, makeRng(3));
    expect(rebuildFleet(fleet, config)).toEqual(fleet);
  });

  it('ignores client-supplied cells entirely', () => {
    const fleet = randomFleet(config, makeRng(3));
    const tampered = fleet.map((ship) => ({
      ...ship,
      cells: [{ row: 9, col: 9 }],
    }));

    const rebuilt = rebuildFleet(tampered, config);
    expect(rebuilt).toEqual(fleet);
    expect(validateFleet(rebuilt, config)).toEqual([]);
  });

  it('ignores a tampered length', () => {
    const fleet = randomFleet(config, makeRng(4));
    const rebuilt = rebuildFleet(
      fleet.map((ship) => ({ ...ship, length: 1 })),
      config,
    );
    expect(rebuilt.map((s) => s.length)).toEqual(config.fleet.map((s) => s.length));
  });

  it('rejects an unknown ship id', () => {
    expect(() => rebuildFleet([{ id: 'mystery', bow: { row: 0, col: 0 }, orientation: 'horizontal' }], config)).toThrow(
      /unknown id/,
    );
  });

  it('rejects a malformed bow', () => {
    for (const bow of [undefined, { row: 'x', col: 0 }, { row: 1.5, col: 0 }, {}]) {
      expect(() =>
        rebuildFleet([{ id: 'carrier', bow, orientation: 'horizontal' }], config),
      ).toThrow(/malformed bow/);
    }
  });

  it('rejects an invalid orientation', () => {
    expect(() =>
      rebuildFleet([{ id: 'carrier', bow: { row: 0, col: 0 }, orientation: 'diagonal' }], config),
    ).toThrow(/orientation/);
  });

  it('produces a fleet that still fails validation when the layout is illegal', () => {
    // Rebuilding sanitises ship shape, not placement: overlaps must still be caught.
    const overlapping = [
      { id: 'carrier', bow: { row: 0, col: 0 }, orientation: 'horizontal' },
      { id: 'battleship', bow: { row: 0, col: 0 }, orientation: 'horizontal' },
      { id: 'cruiser', bow: { row: 4, col: 0 }, orientation: 'horizontal' },
      { id: 'submarine', bow: { row: 6, col: 0 }, orientation: 'horizontal' },
      { id: 'destroyer', bow: { row: 8, col: 0 }, orientation: 'horizontal' },
    ];
    expect(validateFleet(rebuildFleet(overlapping, config), config).join(' ')).toContain('overlaps');
  });
});
