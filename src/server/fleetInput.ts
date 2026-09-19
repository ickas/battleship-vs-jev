import { toPlacedShip } from '../engine/placement.js';
import type { GameConfig, PlacedShip } from '../engine/types.js';

/**
 * Rebuilds a fleet from untrusted input.
 *
 * Only the ship id, bow and orientation are taken from the caller; the cells
 * and length are derived from the config's own spec. A hand-edited payload
 * therefore cannot smuggle a malformed ship (duplicated cells, a scattered
 * run, a wrong length) past validation and into the engine.
 */
export function rebuildFleet(input: unknown[], config: GameConfig): PlacedShip[] {
  return input.map((raw, index) => {
    const ship = raw as {
      id?: unknown;
      bow?: { row?: unknown; col?: unknown };
      orientation?: unknown;
    };

    const spec = config.fleet.find((s) => s.id === ship.id);
    if (!spec) throw new Error(`Ship ${index} has unknown id "${String(ship.id)}"`);

    const row = Number(ship.bow?.row);
    const col = Number(ship.bow?.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      throw new Error(`Ship "${spec.id}" has a malformed bow`);
    }
    if (ship.orientation !== 'horizontal' && ship.orientation !== 'vertical') {
      throw new Error(`Ship "${spec.id}" has orientation "${String(ship.orientation)}"`);
    }

    return toPlacedShip(spec, { row, col }, ship.orientation);
  });
}
