/**
 * Paired comparison across every backend that has played the layout set.
 *
 * Scans results/, groups games by strategy and by the model that answered, and
 * compares every pair on the layouts they both played. When two runs exist for
 * the same strategy and model the newest wins, so a re-run supersedes the run
 * it replaced without anything having to be deleted.
 *
 * Pairing is verified rather than assumed: two runs are only compared when the
 * fleets they played are byte-identical, layout by layout. Same seed and same
 * family is not sufficient evidence on its own, and comparing means over two
 * different layout sets is the failure this whole script exists to avoid.
 *
 *   npx tsx scripts/compare-backends.mts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pairedTTest, requiredPairs, signTest, wilsonInterval } from '../src/metrics/significance.js';

interface GameRow {
  strategyId: string;
  seed: number;
  shotCount: number;
  fleet: unknown;
  totalCostUsd?: number;
  costIsEstimated?: boolean;
  totalLatencyMs?: number;
}

interface Backend {
  label: string;
  strategyId: string;
  modelId: string;
  file: string;
  finishedAt: string;
  bySeed: Map<number, GameRow>;
  costUsd: number;
  costIsEstimated: boolean;
}

const RESULTS_DIR = 'results';

/**
 * One candidate per (player, file). Choosing the winner per player has to
 * happen after every file is read, not while reading: picking "newest file
 * wins" as it goes let a later 2-game spot check overwrite the complete
 * 60-game run and silently drop that player from the comparison entirely.
 */
function load(): Backend[] {
  const byLabelAndFile = new Map<string, Backend>();

  for (const name of readdirSync(RESULTS_DIR)) {
    if (!name.startsWith('bench-') || !name.endsWith('.json')) continue;
    const file = join(RESULTS_DIR, name);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      finishedAt: string;
      layoutFamily?: string;
      summaries?: Array<{ strategyId: string; modelIds?: string[] }>;
      results?: GameRow[];
    };
    if (!doc.results?.length || !doc.summaries?.length) continue;
    // Only the mixed family is comparable; other families rank differently.
    if (doc.layoutFamily && doc.layoutFamily !== 'mixed') continue;

    const modelOf = new Map(
      doc.summaries.map((s) => [s.strategyId, s.modelIds?.[0] ?? 'code-only']),
    );

    for (const row of doc.results) {
      const modelId = modelOf.get(row.strategyId) ?? 'code-only';
      const label = `${row.strategyId} @ ${modelId}`;
      const key = `${label}|${file}`;
      let backend = byLabelAndFile.get(key);

      if (!backend) {
        backend = {
          label,
          strategyId: row.strategyId,
          modelId,
          file,
          finishedAt: doc.finishedAt,
          bySeed: new Map(),
          costUsd: 0,
          costIsEstimated: false,
        };
        byLabelAndFile.set(key, backend);
      }

      backend.bySeed.set(row.seed, row);
      backend.costUsd += row.totalCostUsd ?? 0;
      if (row.costIsEstimated) backend.costIsEstimated = true;
    }
  }

  // Only full 60-layout runs take part; a short run cannot be paired safely.
  // Among the complete ones for a player, the newest supersedes the rest, so a
  // re-run replaces what it re-ran without anything having to be deleted.
  const best = new Map<string, Backend>();
  for (const candidate of byLabelAndFile.values()) {
    if (candidate.bySeed.size < 60) continue;
    const current = best.get(candidate.label);
    if (!current || candidate.finishedAt > current.finishedAt) {
      best.set(candidate.label, candidate);
    }
  }
  return [...best.values()];
}

/** Seeds both played, but only if the fleet was identical on every one. */
function pairedSeeds(a: Backend, b: Backend): number[] {
  const shared = [...a.bySeed.keys()].filter((s) => b.bySeed.has(s)).sort((x, y) => x - y);
  const mismatched = shared.filter(
    (s) => JSON.stringify(a.bySeed.get(s)!.fleet) !== JSON.stringify(b.bySeed.get(s)!.fleet),
  );
  if (mismatched.length > 0) {
    throw new Error(
      `${a.label} and ${b.label} disagree on the fleet for seed(s) ` +
        `${mismatched.slice(0, 3).join(', ')}. They are not the same layout set.`,
    );
  }
  return shared;
}

const backends = load();
if (backends.length < 2) {
  console.error(`Need at least two complete 60-game runs in ${RESULTS_DIR}/.`);
  process.exit(1);
}

const order = (b: Backend) =>
  [...b.bySeed.values()].reduce((s, r) => s + r.shotCount, 0) / b.bySeed.size;
backends.sort((x, y) => order(x) - order(y));

console.log('All runs below are the mixed layout family, seed 1000, 60 games.\n');
console.log('SCOREBOARD (lower is better)\n');
console.log('player                                  n   mean  median     sd    cost');
console.log('-'.repeat(74));
for (const b of backends) {
  const shots = [...b.bySeed.values()].map((r) => r.shotCount).sort((p, q) => p - q);
  const n = shots.length;
  const m = shots.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(shots.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  const med = n % 2 ? shots[(n - 1) / 2]! : (shots[n / 2 - 1]! + shots[n / 2]!) / 2;
  const cost = b.costUsd > 0 ? `$${b.costUsd.toFixed(4)}${b.costIsEstimated ? '*' : ''}` : '-';
  console.log(
    b.label.padEnd(38),
    String(n).padStart(3),
    m.toFixed(1).padStart(6),
    med.toFixed(1).padStart(7),
    sd.toFixed(1).padStart(6),
    cost.padStart(8),
  );
}
console.log('\n* estimated from a published rate rather than billed.');

console.log('\n\nPAIRED COMPARISONS\n');
console.log(
  'A vs B                                               n   diff        95% CI        p   wins  verdict',
);
console.log('-'.repeat(104));

const inconclusive: string[] = [];

for (let i = 0; i < backends.length; i++) {
  for (let j = i + 1; j < backends.length; j++) {
    const a = backends[i]!;
    const b = backends[j]!;
    const seeds = pairedSeeds(a, b);
    if (seeds.length < 2) continue;

    const sa = seeds.map((s) => a.bySeed.get(s)!.shotCount);
    const sb = seeds.map((s) => b.bySeed.get(s)!.shotCount);
    const r = pairedTTest(sa, sb);

    const decided = seeds.length - r.ties;
    const sign = signTest(r.winsA, decided);
    const [lo, hi] = wilsonInterval(r.winsA, decided);

    // A result is only called a win when the interval excludes zero. Anything
    // else is a tie, however suggestive the means look.
    const verdict =
      r.p < 0.05 && r.ci95[0] * r.ci95[1] > 0
        ? r.meanDiff < 0
          ? 'A wins'
          : 'B wins'
        : 'TIE';
    if (verdict === 'TIE') {
      inconclusive.push(
        `${a.label} vs ${b.label}: gap ${Math.abs(r.meanDiff).toFixed(1)}, ` +
          `detectable ${r.detectableDiff.toFixed(1)}, ` +
          `needs ~${requiredPairs(r.sdDiff, Math.abs(r.meanDiff))} games`,
      );
    }

    console.log(
      `${a.label.split(' @ ')[0]}/${a.modelId}`.slice(0, 24).padEnd(25),
      `${b.label.split(' @ ')[0]}/${b.modelId}`.slice(0, 24).padEnd(25),
      String(seeds.length).padStart(3),
      r.meanDiff.toFixed(1).padStart(6),
      `[${r.ci95[0].toFixed(1)}, ${r.ci95[1].toFixed(1)}]`.padStart(16),
      (r.p < 0.0001 ? r.p.toExponential(1) : r.p.toFixed(4)).padStart(9),
      `${r.winsA}/${decided}`.padStart(6),
      ` ${verdict}`,
      verdict === 'TIE' ? `(sign p=${sign.toFixed(2)}, win rate ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%)` : '',
    );
  }
}

if (inconclusive.length) {
  console.log('\n\nWHAT THE TIES WOULD TAKE TO SETTLE\n');
  for (const line of inconclusive) console.log(`  ${line}`);
  console.log(
    '\nA tie is a tie. None of the rows above labelled TIE should be reported as a win,\n' +
      'and the sample size named beside each one is what it would take to decide it.',
  );
}
