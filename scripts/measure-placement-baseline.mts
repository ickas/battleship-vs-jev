/**
 * Measures how often each placement tendency appears in a purely random fleet.
 * These baselines decide which habits are worth reporting to Jev: a tendency
 * that random play already produces is not information about an opponent.
 *
 * Run with `npx tsx scripts/measure-placement-baseline.mts`.
 */
import { makeConfig } from '../src/engine/config.js';
import { randomFleet } from '../src/engine/placement.js';
import { makeRng } from '../src/engine/rng.js';
import type { Coord } from '../src/engine/types.js';

const config = makeConfig();
const SAMPLES = 3000;

const isEdge = (c: Coord) =>
  c.row === 0 || c.col === 0 || c.row === config.rows - 1 || c.col === config.cols - 1;

let anyEdgeGames = 0;
let edgeFractionSum = 0;
let horizontalMajorityGames = 0;

for (let i = 0; i < SAMPLES; i++) {
  const fleet = randomFleet(config, makeRng(i));
  const onEdge = fleet.filter((s) => s.cells.some(isEdge)).length;
  if (onEdge > 0) anyEdgeGames++;
  edgeFractionSum += onEdge / fleet.length;
  if (fleet.filter((s) => s.orientation === 'horizontal').length > fleet.length / 2) {
    horizontalMajorityGames++;
  }
}

console.log(`samples: ${SAMPLES}`);
console.log(`P(at least one ship on an edge): ${(anyEdgeGames / SAMPLES).toFixed(3)}`);
console.log(`mean fraction of ships on an edge: ${(edgeFractionSum / SAMPLES).toFixed(3)}`);
console.log(`P(horizontal majority): ${(horizontalMajorityGames / SAMPLES).toFixed(3)}`);
console.log(
  '\nThe first figure is why "at least one ship touches an edge" is useless as a signal.',
);
