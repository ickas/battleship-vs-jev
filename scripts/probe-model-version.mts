/**
 * Phase 0 open point: which Jev version does `typesafe-ai/jev` resolve to, and
 * can a version be pinned? Run with `npx tsx scripts/probe-model-version.mts`.
 */
import { loadEnv } from '../src/env.js';
loadEnv();
const { experimental_evaluate: evaluate } = await import('ai');

const probe = { q: { type: 'boolean' as const, instructions: 'Is this a test?' } };

const result = await evaluate({ model: 'typesafe-ai/jev', state: 'x', questions: probe });

console.log('response.modelId :', result.response?.modelId);
console.log('response keys    :', Object.keys(result.response ?? {}).join(', '));
console.log('providerMetadata :', JSON.stringify(result.providerMetadata));
console.log('warnings         :', JSON.stringify(result.warnings));
console.log('rounding         :', JSON.stringify(result.rounding));
console.log('response.body    :', JSON.stringify(result.response?.body).slice(0, 400));
console.log('response.headers :', JSON.stringify(result.response?.headers).slice(0, 600));

console.log('\n--- can a version be pinned? ---');
for (const id of ['typesafe-ai/jev-1.13.0', 'typesafe-ai/jev-1.13', 'typesafe-ai/jev-latest']) {
  try {
    const pinned = await evaluate({ model: id, state: 'x', questions: probe });
    console.log(`OK   ${id} -> modelId ${pinned.response?.modelId}`);
  } catch (error) {
    console.log(`FAIL ${id}: ${(error as Error).message.split('\n')[0].slice(0, 120)}`);
  }
}
