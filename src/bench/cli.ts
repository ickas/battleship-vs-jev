import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeConfig } from '../engine/config.js';
import { formatComparisonTable, resultsToCsv } from '../metrics/summary.js';
import { runBench } from './runner.js';
import {
  ALL_STRATEGY_IDS,
  buildClient,
  buildStrategy,
  strategyUsesModel,
  type Transport,
} from './strategies.js';
import { loadEnv } from '../env.js';

loadEnv();

/**
 * Headless benchmark runner.
 *
 *   npm run bench -- --games 20 --strategies density,jevHybrid
 *   npm run bench -- --games 5 --mock        # no API key, code baselines only
 */
interface Args {
  games: number;
  strategies: string[];
  seed: number;
  representation: string;
  topK: number;
  temperature: number;
  model?: string;
  transport: Transport;
  out: string;
  allowTouching: boolean;
  minIntervalMs: number;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, 'true');
    }
  }

  const games = Number(flags.get('games') ?? 10);
  if (!Number.isInteger(games) || games <= 0) {
    throw new Error(`--games must be a positive integer, got "${flags.get('games')}"`);
  }

  const strategies = (flags.get('strategies') ?? ALL_STRATEGY_IDS.join(',')).split(',').map((s) => s.trim());
  for (const id of strategies) {
    if (!ALL_STRATEGY_IDS.includes(id as never)) {
      throw new Error(`Unknown strategy "${id}". Known: ${ALL_STRATEGY_IDS.join(', ')}`);
    }
  }

  return {
    games,
    strategies,
    seed: Number(flags.get('seed') ?? 1),
    representation: flags.get('representation') ?? 'semantic',
    topK: Number(flags.get('topK') ?? 8),
    temperature: Number(flags.get('temperature') ?? 0),
    transport: parseTransport(flags),
    out: flags.get('out') ?? 'results',
    minIntervalMs: Number(flags.get('minIntervalMs') ?? 1500),
    ...(flags.get('model') ? { model: flags.get('model')! } : {}),
    allowTouching: flags.get('allowTouching') !== 'false',
  };
}

/**
 * The Gateway reports the alias that was requested, never the Jev build that
 * answered, and no concrete version can be pinned. Results are only comparable
 * within one model version, so this has to be said rather than implied.
 */
const MODEL_VERSION_NOTE =
  'Results are only comparable within one model version. The Gateway reports only\n' +
  'the alias that was requested, not the build that answered, so a silent model\n' +
  'update would be invisible here. Each call\'s generationId is recorded in the\n' +
  'JSON output for cross-checking against the Gateway request logs.';

/**
 * `--transport direct|gateway|mock`, with `--mock` kept as a shorthand.
 * Direct talks to the TypeSafe API; gateway goes through Vercel AI Gateway.
 */
function parseTransport(flags: Map<string, string>): Transport {
  if (flags.get('mock') === 'true') return 'mock';
  const value = flags.get('transport') ?? 'gateway';
  if (value !== 'gateway' && value !== 'direct' && value !== 'mock') {
    throw new Error(`--transport must be gateway, direct or mock, got "${value}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = makeConfig({ allowTouching: args.allowTouching });

  // A real client is only required when a model strategy will actually call it.
  const needsModel = args.strategies.some(strategyUsesModel);
  const client = buildClient({
    transport: needsModel ? args.transport : 'mock',
    minIntervalMs: args.minIntervalMs,
    ...(args.model ? { model: args.model } : {}),
  });

  if (args.transport === 'mock' && needsModel) {
    console.warn(
      'WARNING: running Jev strategies against the mock client. These are NOT benchmark results.\n',
    );
  }

  const strategies = args.strategies.map((id) =>
    buildStrategy(id, {
      client,
      representation: args.representation,
      topK: args.topK,
      temperature: args.temperature,
    }),
  );

  console.log(
    `Running ${args.games} games per strategy (${strategies.length} strategies, seed ${args.seed})\n`,
  );

  let lastStrategy = '';
  const report = await runBench({
    config,
    strategies,
    games: args.games,
    seed: args.seed,
    onProgress: (event) => {
      if (event.strategyId !== lastStrategy) {
        lastStrategy = event.strategyId;
        process.stdout.write(`\n${event.strategyId}: `);
      }
      process.stdout.write(event.error ? 'E' : '.');
    },
  });

  console.log('\n');
  console.log(formatComparisonTable(report.summaries));

  if (!report.paired) {
    console.log(`\nWARNING: ${report.pairingNote}`);
  }

  if (report.errors.length > 0) {
    console.log(`\n${report.errors.length} error(s):`);
    for (const error of report.errors.slice(0, 10)) {
      console.log(`  ${error.strategyId} game ${error.gameIndex}: ${error.error}`);
    }
  }

  const modelIds = [...new Set(report.summaries.flatMap((s) => s.modelIds))];
  if (modelIds.length > 0) {
    console.log(`\nModel id(s) reported: ${modelIds.join(', ')}`);
    console.log(MODEL_VERSION_NOTE);
  }

  await mkdir(args.out, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
  const jsonPath = join(args.out, `bench-${stamp}.json`);
  const csvPath = join(args.out, `bench-${stamp}.csv`);

  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(csvPath, resultsToCsv(report.results));
  console.log(`\nWrote ${jsonPath}\nWrote ${csvPath}`);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
