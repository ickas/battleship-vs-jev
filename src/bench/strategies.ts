import { GatewayJevClient } from '../jev/gateway.js';
import { MockJevClient } from '../jev/mock.js';
import type { JevClient } from '../jev/types.js';
import { DensityStrategy } from '../strategies/density.js';
import { HuntTargetStrategy } from '../strategies/huntTarget.js';
import { JevHybridStrategy } from '../strategies/jevHybrid.js';
import { JevPureStrategy } from '../strategies/jevPure.js';
import { RandomStrategy } from '../strategies/random.js';
import type { Strategy } from '../strategies/types.js';

export interface BuildOptions {
  client: JevClient;
  representation?: string;
  topK?: number;
  temperature?: number;
}

/** The five strategies named in the plan, by id. */
export function buildStrategy(id: string, options: BuildOptions): Strategy {
  const { client, representation, topK, temperature } = options;

  switch (id) {
    case 'random':
      return new RandomStrategy();
    case 'huntTarget':
      return new HuntTargetStrategy();
    case 'density':
      return new DensityStrategy();
    case 'jevPure':
      return new JevPureStrategy({ client, representation, temperature });
    case 'jevHybrid':
      return new JevHybridStrategy({ client, representation, topK, temperature });
    default:
      throw new Error(`Unknown strategy "${id}". Known: ${ALL_STRATEGY_IDS.join(', ')}`);
  }
}

export const ALL_STRATEGY_IDS = ['random', 'huntTarget', 'density', 'jevPure', 'jevHybrid'] as const;
export const CODE_ONLY_STRATEGY_IDS = ['random', 'huntTarget', 'density'] as const;

export function strategyUsesModel(id: string): boolean {
  return id === 'jevPure' || id === 'jevHybrid';
}

/**
 * Builds the client the bench will use. Falls back to the mock only when
 * explicitly asked, so a missing API key fails loudly instead of silently
 * producing numbers that did not come from the model.
 */
export function buildClient(
  options: {
    mock?: boolean;
    keepFullLog?: boolean;
    /** Minimum gap between requests, for free-tier rate limits. */
    minIntervalMs?: number;
    rateLimitRetries?: number;
  } = {},
): JevClient {
  if (options.mock) return new MockJevClient();

  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      'AI_GATEWAY_API_KEY is not set. Export it, or pass --mock to run the code-only baselines ' +
        'with a stand-in client (mock results are not benchmark results).',
    );
  }

  return new GatewayJevClient({
    keepFullLog: options.keepFullLog ?? false,
    minIntervalMs: options.minIntervalMs ?? 0,
    rateLimitRetries: options.rateLimitRetries ?? 4,
  });
}
