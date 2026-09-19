/**
 * How many plausible cells does jevHybrid's shortlist hide from the model?
 *
 * When a ship has been hit but not sunk, the cells that could complete it form
 * a "frontier": up to `longest - 1` cells in each of four directions, so up to
 * 16 for a 5-long carrier. If topK is smaller than the frontier, code is
 * pre-excluding cells the model never gets to consider - which matters when the
 * point of the exercise is to measure the model's judgement.
 *
 * Run with `npx tsx scripts/measure-frontier-coverage.mts`.
 */
import { Board } from '../src/engine/board.js';
import { makeConfig } from '../src/engine/config.js';
import { coordKey } from '../src/engine/coords.js';
import { topCandidates } from '../src/engine/density.js';
import { randomFleet } from '../src/engine/placement.js';
import { makeRng } from '../src/engine/rng.js';
import { DensityStrategy } from '../src/strategies/density.js';
import { unresolvedHits, untriedCells } from '../src/strategies/untried.js';
import type { BoardView } from '../src/engine/types.js';

const config = makeConfig();
const GAMES = 200;
const K_VALUES = [4, 8, 12, 16, 24];

/** Untried cells in line with a live hit, within reach of the longest ship afloat. */
function frontier(view: BoardView): Set<string> {
  const longest = Math.max(...view.remainingShipLengths, 0);
  const out = new Set<string>();

  for (const hit of unresolvedHits(view)) {
    for (const [dr, dc] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const) {
      for (let step = 1; step < longest; step++) {
        const row = hit.row + dr * step;
        const col = hit.col + dc * step;
        if (row < 0 || row >= config.rows || col < 0 || col >= config.cols) break;
        const state = view.cells[row]![col]!;
        // A miss or a sunk cell blocks the line; nothing beyond it can help.
        if (state === 'miss' || state === 'sunk') break;
        if (state === 'unknown') out.add(coordKey({ row, col }));
      }
    }
  }
  return out;
}

const stats = new Map(K_VALUES.map((k) => [k, { cells: 0, full: 0 }]));
let positions = 0;
let frontierTotal = 0;
const density = new DensityStrategy();

for (let game = 0; game < GAMES; game++) {
  const board = new Board(config, randomFleet(config, makeRng(game)));
  const rng = makeRng(game + 7000);

  while (!board.isFleetSunk && untriedCells(board.view()).length > 20) {
    const view = board.view();
    const cells = frontier(view);

    if (cells.size > 0) {
      positions++;
      frontierTotal += cells.size;
      for (const k of K_VALUES) {
        const offered = new Set(topCandidates(view, k).map((c) => coordKey(c.coord)));
        const covered = [...cells].filter((c) => offered.has(c)).length;
        const entry = stats.get(k)!;
        entry.cells += covered;
        if (covered === cells.size) entry.full++;
      }
    }

    board.fire((await density.nextShot(view, rng)).coord);
  }
}

console.log(`${positions} positions with a ship hit but not sunk, over ${GAMES} games`);
console.log(`mean frontier size: ${(frontierTotal / positions).toFixed(1)} cells\n`);
console.log('topK   frontier cells offered   positions with the whole frontier offered');
console.log('----   ---------------------   ----------------------------------------');
for (const k of K_VALUES) {
  const { cells, full } = stats.get(k)!;
  console.log(
    `${String(k).padEnd(6)} ${((100 * cells) / frontierTotal).toFixed(1).padStart(20)}%   ${(
      (100 * full) /
      positions
    )
      .toFixed(1)
      .padStart(38)}%`,
  );
}
console.log(
  '\nA topK below the mean frontier size hides cells the model would need to see.\n' +
    'Scores at these values are not distinguishable at small sample sizes, so the\n' +
    'coverage figure - not a score - is the reason to prefer a larger topK.',
);
