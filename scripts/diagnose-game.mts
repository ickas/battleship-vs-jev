/**
 * Replays one recorded game and reports where the model's choice sat in the
 * code's own ranking at every shot.
 *
 * A model player that picks the shortlist's top cell every time is adding
 * nothing to the solver; one that picks the bottom is actively discarding it.
 * A bad game is otherwise ambiguous between "the model chose badly" and "the
 * shortlist never contained the target", and those call for opposite fixes.
 *
 *   npx tsx scripts/diagnose-game.mts results/bench-....json 1031
 */
import { readFileSync } from 'node:fs';
import { Board } from '../src/engine/board.js';
import { topCandidates } from '../src/engine/density.js';
import { coordToLabel, labelToCoord } from '../src/engine/coords.js';

const [file, seedArg, strategyArg] = process.argv.slice(2);
if (!file || !seedArg) {
  console.error('usage: diagnose-game.mts <results.json> <seed|all> [strategyId]');
  process.exit(1);
}
const seed = Number(seedArg);
const doc = JSON.parse(readFileSync(file, 'utf8'));
// A results file may hold every strategy, so an unfiltered "all" would mix
// the code-only baselines into the model player's statistics.
let games = (doc.results as Array<{ seed: number; strategyId: string }>).filter(
  (r) => Number.isNaN(seed) || r.seed === seed,
);
if (strategyArg) games = games.filter((r) => r.strategyId === strategyArg);
else {
  const ids = [...new Set(games.map((r) => r.strategyId))];
  if (ids.length > 1) {
    console.error(`This file holds ${ids.length} strategies: ${ids.join(', ')}`);
    console.error('Name one as the third argument, or the numbers will be mixed.');
    process.exit(1);
  }
}
if (games.length === 0) {
  console.error(`No game with seed ${seedArg} in ${file}`);
  process.exit(1);
}

const TOP_K = 16;
const ranks: number[] = [];
const missedChances: number[] = [];
let totalShots = 0;
let totalHits = 0;

for (const game of games) {
const board = new Board(game.config, game.fleet);
totalShots += game.shotCount;
totalHits += game.hits;

for (const shot of game.shots) {
  const view = board.view();
  const candidates = topCandidates(view, TOP_K);
  const chosen = shot.outcome.coord ?? labelToCoord(shot.outcome.label ?? '');
  const rank = candidates.findIndex(
    (c) => c.coord.row === chosen.row && c.coord.col === chosen.col,
  );
  ranks.push(rank);

  // Was a ship cell sitting in the shortlist while the model picked elsewhere?
  const shipCells = new Set(game.fleet.flatMap((s: { cells: Array<{row:number;col:number}> }) =>
    s.cells.map((c) => `${c.row},${c.col}`)));
  const hadHit = candidates.some(
    (c) => shipCells.has(`${c.coord.row},${c.coord.col}`) && view.cells[c.coord.row]![c.coord.col] === 'unknown',
  );
  if (hadHit && shot.outcome.result === 'miss') missedChances.push(shot.index);

  board.fire(chosen);
}
}

const inList = ranks.filter((r) => r >= 0);
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const hist = new Map<number, number>();
for (const r of inList) hist.set(r, (hist.get(r) ?? 0) + 1);

console.log(`${games.length} game(s): ${totalShots} shots, ${totalHits} hits\n`);
console.log(`chosen cell was outside the top ${TOP_K}: ${ranks.filter((r) => r < 0).length} shots`);
console.log(`mean rank chosen (0 = the solver's own top pick): ${mean(inList).toFixed(2)}`);
console.log(`picked rank 0: ${hist.get(0) ?? 0} of ${inList.length} shots`);
console.log(
  `\nshots that missed while a real ship cell sat in the shortlist: ` +
    `${missedChances.length} of ${totalShots}`,
);
console.log('\nrank histogram (rank: count)');
const peak = Math.max(...hist.values());
for (let r = 0; r < TOP_K; r++) {
  const n = hist.get(r) ?? 0;
  const bar = '#'.repeat(Math.round((n / peak) * 44));
  console.log(`  ${String(r).padStart(2)}: ${bar.padEnd(44)} ${n}`);
}
