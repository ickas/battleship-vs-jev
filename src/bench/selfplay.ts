import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeConfig } from '../engine/config.js';
import { historyEffect, runSelfPlay } from '../selfplay/runner.js';
import { buildClient } from './strategies.js';
import { loadEnv } from '../env.js';

loadEnv();

/**
 * Phase 2 runner: Jev vs. Jev, one player using opponent history and one not.
 *
 *   npm run selfplay -- --games 50
 *   npm run selfplay -- --games 10 --mock
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
  };

  const games = Number(flag('games', '20'));
  const transport = argv.includes('--mock')
    ? ('mock' as const)
    : (flag('transport', 'gateway') as 'gateway' | 'direct' | 'mock');
  const out = flag('out', 'results');

  if (transport === 'mock') {
    console.warn('WARNING: mock client. These are NOT benchmark results.\n');
  }

  const config = makeConfig();
  const client = buildClient({
    transport,
    keepFullLog: false,
    minIntervalMs: Number(flag('minIntervalMs', '1500')),
    ...(flag('model', '') ? { model: flag('model', '') } : {}),
  });

  console.log(`Running ${games} self-play games (history on vs. history off)\n`);

  const report = await runSelfPlay({
    config,
    client,
    games,
    seed: Number(flag('seed', '1')),
    topK: Number(flag('topK', '16')),
    temperature: Number(flag('temperature', '0.7')),
    jevPlacement: !argv.includes('--randomPlacement'),
    onGame: (index, result, progress) => {
      const marker = result.winnerId === 'withHistory' ? 'H' : result.winnerId ? '.' : '-';
      process.stdout.write(marker);
      if ((index + 1) % 50 === 0) {
        process.stdout.write(` ${progress.winsWithHistory}/${progress.gamesPlayed}\n`);
      }
    },
  });

  const effect = historyEffect(report);

  console.log('\n');
  console.log(`Games completed      ${report.completed} of ${report.games}`);
  console.log(`Wins with history    ${report.winsWithHistory}`);
  console.log(`Wins without history ${report.winsWithoutHistory}`);
  console.log(`Draws                ${report.draws}`);
  console.log(`Mean shots (history) ${report.meanShotsWithHistory.toFixed(1)}`);
  console.log(`Mean shots (control) ${report.meanShotsWithoutHistory.toFixed(1)}`);
  console.log(
    `Win rate first half  ${(report.historyWinRateFirstHalf * 100).toFixed(1)}%  ` +
      `second half ${(report.historyWinRateSecondHalf * 100).toFixed(1)}%`,
  );
  console.log(
    `History used: placement in ${report.gamesWithPlacementSignal} games; ` +
      `firing prior in ${report.gamesWithFiringPrior}; ` +
      `a sentence about the opponent sent to Jev in ${report.gamesWithFiringSummaries}`,
  );
  if (report.contaminatedGames > 0) {
    console.log(
      `Excluded ${report.contaminatedGames} contaminated game(s): a Jev call failed and a ` +
        'random shot was substituted, so they are not a clean comparison.',
    );
  }
  console.log(`\n${effect.verdict}`);

  if (report.errors.length > 0) {
    console.log(`\n${report.errors.length} error(s); first few:`);
    for (const error of report.errors.slice(0, 5)) console.log(`  ${error}`);
  }
  if (report.modelIds.length > 0) console.log(`\nModel id(s) reported: ${report.modelIds.join(', ')}`);
  console.log(
    'The Gateway reports only the requested alias, not the Jev build that answered,\n' +
      'so results are comparable only within one model version and a silent update\n' +
      'would be invisible. Each generationId is recorded for the Gateway logs.',
  );

  await mkdir(out, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
  const path = join(out, `selfplay-${stamp}.json`);
  await writeFile(path, JSON.stringify({ report, effect }, null, 2));
  console.log(`\nWrote ${path}`);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
