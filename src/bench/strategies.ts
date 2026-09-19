import { DirectJevClient } from '../jev/direct.js';
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

/** How a runner reaches Jev. */
export type Transport = 'gateway' | 'direct' | 'mock';

export interface ClientOptions {
  transport?: Transport;
  keepFullLog?: boolean;
  /** Minimum gap between requests, for rate-limited tiers. */
  minIntervalMs?: number;
  rateLimitRetries?: number;
  /** Model to request on the direct transport. A concrete version pins it. */
  model?: string;
}

/**
 * Builds the client a runner will use. Falls back to the mock only when
 * explicitly asked, so a missing API key fails loudly instead of silently
 * producing numbers that did not come from the model.
 *
 * `direct` talks to the TypeSafe API and is the better transport for a real
 * benchmark: it reports the model that actually answered, always returns
 * probabilities and confidence, and is not subject to the Gateway free tier's
 * rate limit. `gateway` is kept because the plan's premise is Gateway access,
 * and comparing the two is how Gateway overhead gets measured.
 */
export function buildClient(options: ClientOptions = {}): JevClient {
  const transport = options.transport ?? 'gateway';

  if (transport === 'mock') return new MockJevClient();

  if (transport === 'direct') {
    if (!process.env.TYPESAFE_API_KEY) {
      throw new Error(
        'TYPESAFE_API_KEY is not set, which --transport direct requires. Get a key from ' +
          'https://typesafe.ai and put it in .env.local, or use --transport gateway.',
      );
    }
    return new DirectJevClient({
      keepFullLog: options.keepFullLog ?? false,
      minIntervalMs: options.minIntervalMs ?? 0,
      ...(options.model ? { model: options.model } : {}),
    });
  }

  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      'AI_GATEWAY_API_KEY is not set. Export it, pass --transport direct to use the TypeSafe ' +
        'API instead, or pass --transport mock to run the code-only baselines with a stand-in ' +
        'client (mock results are not benchmark results).',
    );
  }

  return new GatewayJevClient({
    keepFullLog: options.keepFullLog ?? false,
    minIntervalMs: options.minIntervalMs ?? 0,
    rateLimitRetries: options.rateLimitRetries ?? 4,
  });
}
