/**
 * Lists the Jev models this TypeSafe account can use, with release dates.
 *
 * This answers the Phase 0 question the Gateway could not: which concrete
 * versions exist, and therefore which can be pinned with `--model`.
 * Run with `npx tsx scripts/list-models.mts`.
 */
import { loadEnv } from '../src/env.js';
loadEnv();

const { TypeSafeClient } = await import('@typesafe-ai/sdk');

if (!process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not set. Put it in .env.local first.');
  process.exit(1);
}

const client = new TypeSafeClient();
const models = await client.models.list();

console.log(`${models.length} model(s) available:\n`);
for (const model of models) {
  console.log(`  ${model.name}`);
  console.log(`    released: ${model.release_date}`);
  console.log(`    ${model.description}`);
}

console.log(
  '\nPin one with --model on any runner, e.g.\n' +
    '  npm run repr -- --transport direct --model <name> --positions 200',
);
