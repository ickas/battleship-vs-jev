import { Board } from './board.js';
import { coordKey } from './coords.js';
import { computeDensity } from './density.js';
import { candidatePlacements, placementFits, randomFleet, toPlacedShip } from './placement.js';
import { makeRng, type Rng } from './rng.js';
import type { GameConfig, PlacedShip } from './types.js';

/**
 * Families of fleet layout to benchmark against.
 *
 * This matters more than it looks. The `density` baseline computes the posterior
 * over ship positions under a *uniform* placement prior, so uniform-random
 * layouts are precisely the case it is built for. Measured over 200 layouts per
 * family, the ranking between the code baselines inverts:
 *
 *   family        density      huntTarget   gap
 *   random        43.4 shots   51.8 shots   density wins by 8.3
 *   edge          52.3 shots   50.1 shots   density LOSES by 2.2
 *   adversarial   53.0 shots   49.8 shots   density LOSES by 3.1
 *
 * Benchmarking only on random layouts therefore flatters the very baseline the
 * model is being measured against. `mixed` is the honest default.
 */
export type LayoutFamily = 'random' | 'edge' | 'centre' | 'adversarial' | 'mixed';

export const LAYOUT_FAMILIES: LayoutFamily[] = [
  'random',
  'edge',
  'centre',
  'adversarial',
  'mixed',
];

export interface LayoutDescription {
  family: LayoutFamily;
  description: string;
}

export const LAYOUT_DESCRIPTIONS: Record<LayoutFamily, string> = {
  random: 'Uniform over all legal layouts. The case the density baseline assumes.',
  edge: 'Every ship against a board edge, where the uniform prior rates cells lowest.',
  centre: 'Every ship away from the edges, where the uniform prior rates cells highest.',
  adversarial: 'Greedily placed on the cells an empty-board density map rates lowest.',
  mixed: 'Equal parts of the four families above. The honest default.',
};

/** Builds one layout of the requested family. */
export function makeLayout(family: LayoutFamily, config: GameConfig, rng: Rng): PlacedShip[] {
  switch (family) {
    case 'random':
      return randomFleet(config, rng);
    case 'edge':
      return constrainedFleet(config, rng, (cell) => isEdge(cell, config));
    case 'centre':
      return constrainedFleet(config, rng, (cell) => !isEdge(cell, config));
    case 'adversarial':
      return adversarialFleet(config, rng);
    case 'mixed':
      // Caller should use `makeLayoutSet` for a balanced mix; a single draw
      // picks a family at random so one-off use is still sensible.
      return makeLayout(
        (['random', 'edge', 'centre', 'adversarial'] as const)[rng.int(4)]!,
        config,
        rng,
      );
  }
}

/**
 * Builds `count` layouts. For `mixed` the families are interleaved rather than
 * drawn at random, so any prefix of the set stays balanced - which matters when
 * a run is cut short by rate limits.
 */
export function makeLayoutSet(
  family: LayoutFamily,
  count: number,
  config: GameConfig,
  seed: number,
): PlacedShip[][] {
  if (family !== 'mixed') {
    return Array.from({ length: count }, (_, i) => makeLayout(family, config, makeRng(seed + i)));
  }

  const cycle: LayoutFamily[] = ['random', 'edge', 'centre', 'adversarial'];
  return Array.from({ length: count }, (_, i) =>
    makeLayout(cycle[i % cycle.length]!, config, makeRng(seed + i)),
  );
}

function isEdge(cell: { row: number; col: number }, config: GameConfig): boolean {
  return (
    cell.row === 0 || cell.col === 0 || cell.row === config.rows - 1 || cell.col === config.cols - 1
  );
}

/** Places every ship so all its cells satisfy `predicate`. Falls back to random. */
function constrainedFleet(
  config: GameConfig,
  rng: Rng,
  predicate: (cell: { row: number; col: number }) => boolean,
  maxAttempts = 400,
): PlacedShip[] {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const occupied = new Set<string>();
    const fleet: PlacedShip[] = [];
    let failed = false;

    for (const spec of [...config.fleet].sort((a, b) => b.length - a.length)) {
      const options = candidatePlacements(spec.length, config).filter(
        (c) => placementFits(c.cells, occupied, config) && c.cells.every(predicate),
      );
      if (options.length === 0) {
        failed = true;
        break;
      }
      const chosen = rng.pick(options);
      fleet.push(toPlacedShip(spec, chosen.bow, chosen.orientation));
      for (const cell of chosen.cells) occupied.add(coordKey(cell));
    }

    if (!failed) return inConfigOrder(fleet, config);
  }

  // The constraint may be infeasible for an unusual fleet; a valid layout beats
  // throwing, and the caller is told which family was requested either way.
  return randomFleet(config, rng);
}

/**
 * Places ships greedily on the cells an empty-board density map rates lowest,
 * which is the worst case for any strategy relying on a uniform prior.
 */
function adversarialFleet(config: GameConfig, rng: Rng): PlacedShip[] {
  const referenceFleet = randomFleet(config, rng);
  const emptyView = new Board(config, referenceFleet).view();
  const { weights } = computeDensity({
    ...emptyView,
    remainingShipLengths: config.fleet.map((s) => s.length).sort((a, b) => b - a),
  });

  const occupied = new Set<string>();
  const fleet: PlacedShip[] = [];

  for (const spec of [...config.fleet].sort((a, b) => b.length - a.length)) {
    const options = candidatePlacements(spec.length, config)
      .filter((c) => placementFits(c.cells, occupied, config))
      .map((c) => ({
        candidate: c,
        score: c.cells.reduce((sum, cell) => sum + weights[cell.row]![cell.col]!, 0),
      }))
      .sort((a, b) => a.score - b.score);

    if (options.length === 0) return randomFleet(config, rng);

    // Sample among the lowest-density placements so layouts are not identical.
    const chosen = options[rng.int(Math.min(6, options.length))]!.candidate;
    fleet.push(toPlacedShip(spec, chosen.bow, chosen.orientation));
    for (const cell of chosen.cells) occupied.add(coordKey(cell));
  }

  return inConfigOrder(fleet, config);
}

function inConfigOrder(fleet: PlacedShip[], config: GameConfig): PlacedShip[] {
  const byId = new Map(fleet.map((s) => [s.id, s]));
  return config.fleet.map((spec) => byId.get(spec.id)!);
}
