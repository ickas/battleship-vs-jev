import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Board } from '../engine/board.js';
import { makeConfig } from '../engine/config.js';
import { coordKey, coordToLabel } from '../engine/coords.js';
import { topCandidates } from '../engine/density.js';
import { randomFleet } from '../engine/placement.js';
import { makeRng } from '../engine/rng.js';
import type { BoardView, Coord, PlacedShip } from '../engine/types.js';
import { buildClient } from './strategies.js';
import { REPRESENTATIONS, type BoardRepresentation } from '../jev/representations.js';
import type { ChoiceAnswer, JevClient } from '../jev/types.js';
import { DensityStrategy } from '../strategies/density.js';
import { mean, percentile } from '../metrics/summary.js';
import { untriedCells } from '../strategies/untried.js';
import { loadEnv } from '../env.js';

loadEnv();

/**
 * Phase 0: which board representation should go in Jev's `state`?
 *
 * Full games are an expensive and noisy way to answer that. Instead this builds
 * a fixed set of mid-game positions, and asks every representation the same
 * question about each one. Because the harness knows where the ships actually
 * are, each answer is scored directly:
 *
 *   - hitRate      did the chosen cell contain a ship? (the honest measure)
 *   - topRate      did it match the code-optimal density pick?
 *   - meanRank     where the choice sat in the density ranking (1 = best)
 *
 * Every representation sees exactly the same positions, so the comparison is
 * paired and differences are attributable to the representation alone.
 */

export interface Position {
  index: number;
  view: BoardView;
  fleet: PlacedShip[];
  /** Cells holding a ship that is still afloat — the correct answers. */
  liveShipCells: Set<string>;
  /** Density ranking of untried cells, best first. */
  ranking: Coord[];
  shotsTaken: number;
}

/**
 * Builds positions by letting the density baseline play partway into a game and
 * snapshotting at fixed depths. Stopping at a spread of depths covers opening,
 * mid-game chases and late endgames.
 */
export async function buildPositions(options: {
  count: number;
  seed?: number;
  depths?: number[];
}): Promise<Position[]> {
  const config = makeConfig();
  const seed = options.seed ?? 1;
  const depths = options.depths ?? [0, 5, 12, 20, 30, 45];
  const positions: Position[] = [];
  const density = new DensityStrategy();

  for (let g = 0; positions.length < options.count; g++) {
    const fleet = randomFleet(config, makeRng(seed + g));
    const board = new Board(config, fleet);
    const rng = makeRng(seed + g + 500);
    const targetDepth = depths[g % depths.length]!;

    for (let shot = 0; shot < targetDepth && !board.isFleetSunk; shot++) {
      const decision = await density.nextShot(board.view(), rng);
      board.fire(decision.coord);
    }
    if (board.isFleetSunk) continue;

    const view = board.view();
    const untried = untriedCells(view);
    if (untried.length < 2) continue;

    // Ground truth: cells of ships that have not been sunk, not yet fired at.
    const sunk = new Set(view.sunkShipIds);
    const liveShipCells = new Set(
      fleet
        .filter((s) => !sunk.has(s.id))
        .flatMap((s) => s.cells)
        .filter((c) => view.cells[c.row]![c.col] === 'unknown')
        .map(coordKey),
    );
    if (liveShipCells.size === 0) continue;

    positions.push({
      index: positions.length,
      view,
      fleet,
      liveShipCells,
      ranking: topCandidates(view, untried.length).map((r) => r.coord),
      shotsTaken: view.history.length,
    });
  }

  return positions;
}

export interface RepresentationScore {
  representationId: string;
  representationName: string;
  positions: number;
  failures: number;
  /** Share of choices that landed on a live ship cell. */
  hitRate: number;
  /** Baseline hit rate from choosing uniformly at random among untried cells. */
  randomBaseline: number;
  /** Hit rate of the code-optimal density pick on the same positions. */
  densityBaseline: number;
  /** Share of choices matching the density top pick. */
  topRate: number;
  /** Mean position of the choice in the density ranking (1 = best). */
  meanRank: number;
  meanConfidence?: number;
  meanInputTokens: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  modelIds: string[];
}

export async function scoreRepresentation(
  representation: BoardRepresentation,
  positions: Position[],
  client: JevClient,
): Promise<RepresentationScore> {
  const hits: number[] = [];
  const tops: number[] = [];
  const ranks: number[] = [];
  const confidences: number[] = [];
  const inputTokens: number[] = [];
  const latencies: number[] = [];
  const modelIds = new Set<string>();
  let failures = 0;

  for (const position of positions) {
    const candidates = untriedCells(position.view);
    const criteria: Record<string, string> = {};
    for (const coord of candidates) {
      criteria[coordToLabel(coord)] = 'A cell that has not been fired at yet.';
    }

    try {
      const response = await client.ask({
        label: `representation.${representation.id}.position${position.index}`,
        state: representation.describe(position.view, candidates),
        questions: {
          target: {
            type: 'choice',
            instructions:
              'Which of these cells is most likely to contain part of a ship that is still afloat? Choose exactly one cell.',
            criteria,
          },
        },
      });

      const answer = response.answers.target as ChoiceAnswer;
      const chosen = candidates.find((c) => coordToLabel(c) === answer.choice);
      if (!chosen) {
        failures++;
        continue;
      }

      hits.push(position.liveShipCells.has(coordKey(chosen)) ? 1 : 0);
      tops.push(coordKey(chosen) === coordKey(position.ranking[0]!) ? 1 : 0);
      const rank = position.ranking.findIndex((c) => coordKey(c) === coordKey(chosen));
      ranks.push(rank >= 0 ? rank + 1 : position.ranking.length);

      if (typeof response.confidence.target === 'number') {
        confidences.push(response.confidence.target);
      }
      if (typeof response.usage.inputTokens === 'number') {
        inputTokens.push(response.usage.inputTokens);
      }
      latencies.push(response.latencyMs);
      modelIds.add(response.modelId);
    } catch (error) {
      failures++;
      console.warn(
        `  ${representation.id} position ${position.index}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    representationId: representation.id,
    representationName: representation.name,
    positions: hits.length,
    failures,
    hitRate: mean(hits),
    randomBaseline: mean(
      positions.map((p) => p.liveShipCells.size / untriedCells(p.view).length),
    ),
    densityBaseline: mean(
      positions.map((p) => (p.liveShipCells.has(coordKey(p.ranking[0]!)) ? 1 : 0)),
    ),
    topRate: mean(tops),
    meanRank: mean(ranks),
    meanConfidence: confidences.length > 0 ? mean(confidences) : undefined,
    meanInputTokens: mean(inputTokens),
    meanLatencyMs: mean(latencies),
    p95LatencyMs: percentile(latencies, 0.95),
    modelIds: [...modelIds],
  };
}

export function formatScoreTable(scores: RepresentationScore[]): string {
  const sorted = [...scores].sort((a, b) => b.hitRate - a.hitRate);
  const headers = ['representation', 'n', 'hit%', 'random%', 'density%', 'top%', 'rank', 'conf', 'tok', 'ms'];

  const rows = sorted.map((s) => [
    s.representationName,
    String(s.positions),
    (s.hitRate * 100).toFixed(1),
    (s.randomBaseline * 100).toFixed(1),
    (s.densityBaseline * 100).toFixed(1),
    (s.topRate * 100).toFixed(1),
    s.meanRank.toFixed(1),
    s.meanConfidence !== undefined ? s.meanConfidence.toFixed(2) : '-',
    s.meanInputTokens.toFixed(0),
    s.meanLatencyMs.toFixed(0),
  ]);

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');

  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
  };
  const positionCount = Number(flag('positions', '24'));
  const mock = argv.includes('--mock');
  const out = flag('out', 'results');

  if (mock) {
    console.warn('WARNING: mock client. These are NOT benchmark results.\n');
  }

  const client = buildClient({ mock });
  console.log(`Building ${positionCount} positions...`);
  const positions = await buildPositions({ count: positionCount });

  const scores = [];
  for (const representation of REPRESENTATIONS) {
    process.stdout.write(`Scoring ${representation.id}...`);
    scores.push(await scoreRepresentation(representation, positions, client));
    process.stdout.write(' done\n');
  }

  console.log(`\n${formatScoreTable(scores)}`);
  console.log(
    '\nhit%     chosen cell contained a live ship (higher is better)\n' +
      'random%  hit rate from picking uniformly among untried cells\n' +
      'density% hit rate of the code-optimal pick on the same positions\n' +
      'top%     agreement with the code-optimal pick\n' +
      'rank     mean position in the density ranking (1 = best)',
  );

  const modelIds = [...new Set(scores.flatMap((s) => s.modelIds))];
  if (modelIds.length > 0) console.log(`\nModel version(s): ${modelIds.join(', ')}`);

  await mkdir(out, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
  const path = join(out, `representation-${stamp}.json`);
  await writeFile(
    path,
    JSON.stringify({ generatedAt: new Date().toISOString(), positionCount, scores }, null, 2),
  );
  console.log(`\nWrote ${path}`);
}

// Only run when invoked directly, so the module stays importable from tests.
if (process.argv[1]?.includes('representation')) {
  main().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
