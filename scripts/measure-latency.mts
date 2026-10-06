/**
 * End-to-end latency for each backend, measured from this machine.
 *
 * Cloudflare's announcement quotes medians of 38.8 ms (clef-flash), 209.3 ms
 * (clef) and 524.1 ms (Jev) without saying how they were measured. Those
 * figures almost certainly exclude the network, since 38.8 ms is barely a
 * round trip to anywhere. This script measures what a caller actually waits
 * for, which is a different and more useful quantity, and the write-up must
 * not present the two as comparable.
 *
 * Calls are interleaved round-robin rather than run in blocks, so a slow
 * minute on the network hits every backend equally instead of penalising
 * whichever happened to run during it. Every backend answers the identical
 * state and question.
 *
 *   npx tsx scripts/measure-latency.mts --calls 60
 */
import { loadEnv } from '../src/env.js';
loadEnv();

import { mean, median, percentile } from '../src/metrics/summary.js';
import type { JevClient, JevRequest } from '../src/jev/types.js';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const CALLS = Number(flag('calls', '60'));
const WARMUP = Number(flag('warmup', '3'));

/** One fixed mid-game decision, identical for every backend. */
const REQUEST: JevRequest = {
  label: 'latency',
  state: {
    boardSize: '10 rows by 10 columns, labelled A1 to J10',
    shipsStillAfloat: ['a ship 4 cells long', 'a ship 3 cells long'],
    cellsHitButNotYetSunk: ['H8'],
  },
  questions: {
    target: {
      type: 'choice',
      instructions:
        'Which of these cells is most likely to contain part of a ship that is still afloat?',
      criteria: {
        H7: 'directly continues 1 hit in a row below; has room for the longest ship still afloat',
        G8: 'directly continues 1 hit in a row right; has room for the longest ship still afloat',
        I8: 'directly continues 1 hit in a row left; has room for the longest ship still afloat',
        B4: 'is in completely unexplored space; is in the open middle of the board',
      },
    },
  },
};

async function build(): Promise<Array<{ name: string; client: JevClient }>> {
  const out: Array<{ name: string; client: JevClient }> = [];

  if (process.env.TYPESAFE_API_KEY) {
    const { DirectJevClient } = await import('../src/jev/direct.js');
    out.push({ name: 'jev', client: new DirectJevClient({ keepFullLog: false }) });
  }
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
    const { ClefClient } = await import('../src/jev/clef.js');
    out.push({ name: 'clef', client: new ClefClient({ model: 'clef', keepFullLog: false }) });
    out.push({
      name: 'clef-flash',
      client: new ClefClient({ model: 'clef-flash', keepFullLog: false }),
    });
  }
  return out;
}

const backends = await build();
if (backends.length === 0) {
  console.error('No credentials found. Set TYPESAFE_API_KEY and/or the two CLOUDFLARE_ vars.');
  process.exit(1);
}

console.log(`Measuring ${CALLS} calls per backend (plus ${WARMUP} warm-up), interleaved.\n`);

const samples = new Map<string, number[]>(backends.map((b) => [b.name, []]));
const tokens = new Map<string, number[]>(backends.map((b) => [b.name, []]));
const modelIds = new Map<string, Set<string>>(backends.map((b) => [b.name, new Set()]));
const failures = new Map<string, number>(backends.map((b) => [b.name, 0]));

for (let i = 0; i < CALLS + WARMUP; i++) {
  for (const { name, client } of backends) {
    try {
      const response = await client.ask(REQUEST);
      // Warm-up calls are made but not counted: the first call to a backend
      // pays for TLS and connection setup that later calls reuse.
      if (i >= WARMUP) {
        samples.get(name)!.push(response.latencyMs);
        if (response.usage.inputTokens) tokens.get(name)!.push(response.usage.inputTokens);
        modelIds.get(name)!.add(response.modelId);
      }
    } catch (error) {
      failures.set(name, failures.get(name)! + 1);
      if (failures.get(name)! <= 2) {
        console.warn(`  ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if ((i + 1) % 10 === 0) process.stdout.write(`${i + 1 - WARMUP > 0 ? i + 1 - WARMUP : 0} `);
}

console.log('\n');
const head = ['backend', 'n', 'median', 'p95', 'min', 'max', 'mean', 'in.tok', 'fail'];
const rows = backends.map(({ name }) => {
  const s = samples.get(name)!;
  return [
    name,
    String(s.length),
    s.length ? median(s).toFixed(0) : '-',
    s.length ? percentile(s, 0.95).toFixed(0) : '-',
    s.length ? Math.min(...s).toFixed(0) : '-',
    s.length ? Math.max(...s).toFixed(0) : '-',
    s.length ? mean(s).toFixed(0) : '-',
    tokens.get(name)!.length ? mean(tokens.get(name)!).toFixed(0) : '-',
    String(failures.get(name)),
  ];
});
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
const line = (c: string[]) =>
  c.map((x, i) => (i === 0 ? x.padEnd(w[i]!) : x.padStart(w[i]!))).join('  ');
console.log(line(head));
console.log(w.map((n) => '-'.repeat(n)).join('  '));
for (const r of rows) console.log(line(r));

console.log('\nAll times are milliseconds, end to end from this machine, including network.');
console.log('Model id(s) reported:');
for (const { name } of backends) {
  console.log(`  ${name}: ${[...modelIds.get(name)!].join(', ') || 'none'}`);
}
