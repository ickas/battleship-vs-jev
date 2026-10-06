/**
 * Does Clef round probabilities the way Jev does, and how much of the
 * distribution survives across ~90 options?
 *
 * The Jev benchmark turned up a limitation worth re-testing on any System One
 * backend: probabilities come back rounded to two decimals, so spread across
 * ~90 options most of the distribution collapses to zero and the heatmap goes
 * nearly empty. Jev also reports the rounding it applied; Cloudflare's output
 * schema has no such field, so the only way to know is to look at the numbers.
 *
 * Rounding is inferred from the values themselves: the number of decimal
 * places actually used, across every option of every call.
 *
 *   npx tsx scripts/probe-probability-rounding.mts --positions 6
 */
import { loadEnv } from '../src/env.js';
loadEnv();

import { Board } from '../src/engine/board.js';
import { makeConfig } from '../src/engine/config.js';
import { coordToLabel } from '../src/engine/coords.js';
import { makeLayout } from '../src/engine/layouts.js';
import { makeRng } from '../src/engine/rng.js';
import { DensityStrategy } from '../src/strategies/density.js';
import { untriedCells } from '../src/strategies/untried.js';
import { cellListRepresentation } from '../src/jev/representations.js';
import type { ChoiceAnswer, JevClient } from '../src/jev/types.js';

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const POSITIONS = Number(flag('positions', '6'));

const config = makeConfig();

/** Mid-game positions with roughly 90 untried cells, as jevPure would see them. */
async function buildPositions(count: number) {
  const density = new DensityStrategy();
  const out = [];
  for (let g = 0; out.length < count; g++) {
    const board = new Board(config, makeLayout('mixed', config, makeRng(g + 400)));
    const rng = makeRng(g + 900);
    for (let i = 0; i < 10 && !board.isFleetSunk; i++) {
      board.fire((await density.nextShot(board.view(), rng)).coord);
    }
    if (board.isFleetSunk) continue;
    out.push(board.view());
  }
  return out;
}

/** How many decimal places a value actually uses, up to 6. */
function decimalsUsed(v: number): number {
  for (let d = 0; d <= 6; d++) {
    if (Math.abs(v - Number(v.toFixed(d))) < 1e-12) return d;
  }
  return 7;
}

async function build(): Promise<Array<{ name: string; client: JevClient }>> {
  const out: Array<{ name: string; client: JevClient }> = [];
  if (process.env.TYPESAFE_API_KEY) {
    const { DirectJevClient } = await import('../src/jev/direct.js');
    out.push({ name: 'jev', client: new DirectJevClient({ keepFullLog: false }) });
  }
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
    const { ClefClient } = await import('../src/jev/clef.js');
    out.push({ name: 'clef', client: new ClefClient({ model: 'clef', keepFullLog: false }) });
    out.push({ name: 'clef-flash', client: new ClefClient({ model: 'clef-flash', keepFullLog: false }) });
  }
  return out;
}

const backends = await build();
if (backends.length === 0) {
  console.error('No credentials found.');
  process.exit(1);
}

const positions = await buildPositions(POSITIONS);
console.log(`${positions.length} positions, ~${untriedCells(positions[0]!).length} options each\n`);

const rows: string[][] = [];
for (const { name, client } of backends) {
  const maxDecimals: number[] = [];
  const nonZero: number[] = [];
  const offered: number[] = [];
  const massKept: number[] = [];
  let failures = 0;

  for (const view of positions) {
    const cells = untriedCells(view);
    const criteria: Record<string, string> = {};
    for (const c of cells) criteria[coordToLabel(c)] = 'A cell that has not been fired at yet.';

    try {
      const response = await client.ask({
        label: `rounding.${name}`,
        state: cellListRepresentation.describe(view, cells),
        questions: {
          target: {
            type: 'choice',
            instructions:
              'Which of these cells is most likely to contain part of a ship that is still afloat?',
            criteria,
          },
        },
      });

      const probs = (response.answers.target as ChoiceAnswer).probabilities ?? {};
      const values = Object.values(probs);
      if (values.length === 0) continue;

      offered.push(cells.length);
      maxDecimals.push(Math.max(...values.map(decimalsUsed)));
      nonZero.push(values.filter((v) => v > 0).length);
      massKept.push(values.reduce((a, b) => a + b, 0));
    } catch (error) {
      failures++;
      if (failures <= 2) {
        console.warn(`  ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  rows.push([
    name,
    String(offered.length),
    offered.length ? avg(offered).toFixed(0) : '-',
    maxDecimals.length ? String(Math.max(...maxDecimals)) : '-',
    nonZero.length ? avg(nonZero).toFixed(1) : '-',
    nonZero.length ? `${((avg(nonZero) / avg(offered)) * 100).toFixed(0)}%` : '-',
    massKept.length ? avg(massKept).toFixed(3) : '-',
    String(failures),
  ]);
}

const head = ['backend', 'n', 'options', 'max dp', 'non-zero', 'share', 'mass', 'fail'];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
const line = (c: string[]) => c.map((x, i) => (i === 0 ? x.padEnd(w[i]!) : x.padStart(w[i]!))).join('  ');
console.log(line(head));
console.log(w.map((n) => '-'.repeat(n)).join('  '));
for (const r of rows) console.log(line(r));

console.log(
  '\nmax dp   the most decimal places seen in any returned probability.\n' +
    '         2 means the backend rounds to two decimals, as Jev documents.\n' +
    'non-zero how many options came back above zero, of the options offered.\n' +
    'mass     the returned probabilities summed; well under 1 means rounding\n' +
    '         discarded real distribution rather than it being concentrated.',
);
