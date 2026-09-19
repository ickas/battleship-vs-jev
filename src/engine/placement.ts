import { allCoords, coordKey, inBounds, shipCells, surroundingCells } from './coords.js';
import type { Rng } from './rng.js';
import type { Coord, GameConfig, Orientation, PlacedShip, ShipSpec } from './types.js';

export const ORIENTATIONS: Orientation[] = ['horizontal', 'vertical'];

export interface PlacementCandidate {
  bow: Coord;
  orientation: Orientation;
  cells: Coord[];
}

/** Every bow/orientation pair for a ship of this length that fits on the board. */
export function candidatePlacements(length: number, config: GameConfig): PlacementCandidate[] {
  const candidates: PlacementCandidate[] = [];
  for (const bow of allCoords(config)) {
    for (const orientation of ORIENTATIONS) {
      // A length-1 ship would otherwise be counted twice.
      if (length === 1 && orientation === 'vertical') continue;
      const cells = shipCells(bow, length, orientation);
      if (cells.every((c) => inBounds(c, config))) candidates.push({ bow, orientation, cells });
    }
  }
  return candidates;
}

/**
 * Whether `cells` can be added to a board already holding `occupied`.
 * When `allowTouching` is false, ships may not be orthogonally or diagonally adjacent.
 */
export function placementFits(
  cells: Coord[],
  occupied: Set<string>,
  config: GameConfig,
): boolean {
  if (!cells.every((c) => inBounds(c, config))) return false;
  if (cells.some((c) => occupied.has(coordKey(c)))) return false;

  if (!config.allowTouching) {
    for (const cell of cells) {
      for (const neighbour of surroundingCells(cell, config)) {
        if (occupied.has(coordKey(neighbour))) return false;
      }
    }
  }
  return true;
}

export function toPlacedShip(
  spec: ShipSpec,
  bow: Coord,
  orientation: Orientation,
): PlacedShip {
  return {
    id: spec.id,
    name: spec.name,
    length: spec.length,
    bow,
    orientation,
    cells: shipCells(bow, spec.length, orientation),
  };
}

/** Validates a complete fleet layout against the config. Returns the reasons it is invalid. */
export function validateFleet(fleet: PlacedShip[], config: GameConfig): string[] {
  const errors: string[] = [];
  const expected = new Map(config.fleet.map((s) => [s.id, s]));

  if (fleet.length !== config.fleet.length) {
    errors.push(`Expected ${config.fleet.length} ships, got ${fleet.length}`);
  }

  const occupied = new Set<string>();
  for (const ship of fleet) {
    const spec = expected.get(ship.id);
    if (!spec) {
      errors.push(`Unknown ship id "${ship.id}"`);
    } else if (spec.length !== ship.length || ship.cells.length !== spec.length) {
      errors.push(`Ship "${ship.id}" must occupy ${spec.length} cells, got ${ship.cells.length}`);
    }

    for (const cell of ship.cells) {
      if (!inBounds(cell, config)) {
        errors.push(`Ship "${ship.id}" leaves the board at (${cell.row},${cell.col})`);
        continue;
      }
      if (occupied.has(coordKey(cell))) {
        errors.push(`Ship "${ship.id}" overlaps another ship at (${cell.row},${cell.col})`);
      }
    }
    for (const cell of ship.cells) occupied.add(coordKey(cell));
  }

  if (!config.allowTouching) {
    // Re-check adjacency per ship, ignoring the ship's own cells.
    for (const ship of fleet) {
      const own = new Set(ship.cells.map(coordKey));
      for (const cell of ship.cells) {
        for (const neighbour of surroundingCells(cell, config)) {
          const key = coordKey(neighbour);
          if (!own.has(key) && occupied.has(key)) {
            errors.push(`Ship "${ship.id}" touches another ship at (${neighbour.row},${neighbour.col})`);
          }
        }
      }
    }
  }

  const seenIds = new Set<string>();
  for (const ship of fleet) {
    if (seenIds.has(ship.id)) errors.push(`Duplicate ship id "${ship.id}"`);
    seenIds.add(ship.id);
  }

  return [...new Set(errors)];
}

export function isValidFleet(fleet: PlacedShip[], config: GameConfig): boolean {
  return validateFleet(fleet, config).length === 0;
}

/**
 * Places the whole fleet at random. Retries the whole layout if it paints itself
 * into a corner, which is possible when `allowTouching` is false.
 */
export function randomFleet(config: GameConfig, rng: Rng, maxAttempts = 200): PlacedShip[] {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const occupied = new Set<string>();
    const fleet: PlacedShip[] = [];
    // Longest first: the hardest ships to fit get the emptiest board.
    const specs = [...config.fleet].sort((a, b) => b.length - a.length);

    let failed = false;
    for (const spec of specs) {
      const options = candidatePlacements(spec.length, config).filter((c) =>
        placementFits(c.cells, occupied, config),
      );
      if (options.length === 0) {
        failed = true;
        break;
      }
      const chosen = rng.pick(options);
      fleet.push(toPlacedShip(spec, chosen.bow, chosen.orientation));
      for (const cell of chosen.cells) occupied.add(coordKey(cell));
    }

    if (!failed) {
      // Return in the config's declared order, so layouts compare cleanly.
      const byId = new Map(fleet.map((s) => [s.id, s]));
      return config.fleet.map((spec) => byId.get(spec.id)!);
    }
  }
  throw new Error(`Could not place the fleet in ${maxAttempts} attempts; the config may be infeasible`);
}
