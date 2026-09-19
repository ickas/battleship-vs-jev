import { describe, expect, it, vi } from 'vitest';
import {
  assertRequestIsWithinLimits,
  extractConfidence,
  extractGatewayMetadata,
  GatewayJevClient,
  JEV_LIMITS,
} from '../gateway.js';

/** Stands in for the AI SDK's `experimental_evaluate` so tests make no network calls. */
function fakeEvaluate(overrides: Record<string, unknown> = {}) {
  return vi.fn(async () => ({
    answers: { cell: { type: 'choice', choice: 'A1', probabilities: { A1: 0.7, B2: 0.3 } } },
    usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
    warnings: undefined,
    rounding: { probabilityDecimals: 4 },
    providerMetadata: { typesafe: { confidence: { cell: 0.82 } } },
    response: { timestamp: new Date(), modelId: 'jev-1.13.0' },
    ...overrides,
  })) as never;
}

const choiceRequest = {
  state: { board: 'empty' },
  questions: {
    cell: { type: 'choice' as const, instructions: 'Pick a cell.', criteria: { A1: 'a', B2: 'b' } },
  },
  label: 'test',
};

describe('GatewayJevClient.ask', () => {
  it('returns answers, confidence, usage, model id and measured latency', async () => {
    const client = new GatewayJevClient({ evaluateFn: fakeEvaluate() });
    const response = await client.ask(choiceRequest);

    expect(response.answers.cell).toEqual({
      type: 'choice',
      choice: 'A1',
      probabilities: { A1: 0.7, B2: 0.3 },
    });
    expect(response.confidence.cell).toBe(0.82);
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 8, totalTokens: 128 });
    expect(response.modelId).toBe('jev-1.13.0');
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    expect(response.rounding).toEqual({ probabilityDecimals: 4 });
  });

  it('logs the call and accumulates stats', async () => {
    const client = new GatewayJevClient({ evaluateFn: fakeEvaluate() });
    await client.ask(choiceRequest);
    await client.ask(choiceRequest);

    expect(client.log).toHaveLength(2);
    expect(client.log[0]!.label).toBe('test');
    expect(client.log[0]!.state).toEqual({ board: 'empty' });
    expect(client.log[0]!.response?.modelId).toBe('jev-1.13.0');
    expect(client.stats).toMatchObject({ calls: 2, failures: 0, inputTokens: 240, outputTokens: 16 });
  });

  it('omits state from the log when keepFullLog is off', async () => {
    const client = new GatewayJevClient({ evaluateFn: fakeEvaluate(), keepFullLog: false });
    await client.ask(choiceRequest);
    expect(client.log[0]!.state).toBe('[omitted]');
  });

  it('records the failure, counts it, and rethrows', async () => {
    const failing = vi.fn(async () => {
      const error = new Error('Too Many Requests');
      error.name = 'RateLimitError';
      (error as { statusCode?: number }).statusCode = 429;
      throw error;
    }) as never;

    const client = new GatewayJevClient({ evaluateFn: failing });
    await expect(client.ask(choiceRequest)).rejects.toThrow('Too Many Requests');

    expect(client.stats).toMatchObject({ calls: 1, failures: 1 });
    expect(client.log[0]!.error).toContain('429');
    expect(client.log[0]!.response).toBeUndefined();
  });

  it('passes maxRetries and gateway provider options through', async () => {
    const evaluateFn = fakeEvaluate();
    const client = new GatewayJevClient({
      evaluateFn,
      maxRetries: 5,
      gatewayOptions: { zeroDataRetention: true },
    });
    await client.ask(choiceRequest);

    const args = (evaluateFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      maxRetries: number;
      providerOptions: { gateway: { zeroDataRetention: boolean } };
      model: string;
    };
    expect(args.maxRetries).toBe(5);
    expect(args.providerOptions.gateway.zeroDataRetention).toBe(true);
    expect(args.model).toBe('typesafe-ai/jev');
  });

  it('tolerates a response with no probabilities or confidence', async () => {
    const client = new GatewayJevClient({
      evaluateFn: fakeEvaluate({
        answers: { cell: { type: 'choice', choice: 'A1' } },
        providerMetadata: undefined,
      }),
    });
    const response = await client.ask(choiceRequest);
    expect(response.confidence).toEqual({});
    expect((response.answers.cell as { probabilities?: unknown }).probabilities).toBeUndefined();
  });
});

describe('extractGatewayMetadata', () => {
  it('reads the generation id and both cost figures, parsing string numbers', () => {
    expect(
      extractGatewayMetadata({
        gateway: { generationId: 'gen_123', marketCost: '0.000011424', cost: '0' },
      }),
    ).toEqual({ generationId: 'gen_123', marketCostUsd: 0.000011424, billedCostUsd: 0 });
  });

  it('returns an empty object when the gateway block is absent', () => {
    expect(extractGatewayMetadata(undefined)).toEqual({});
    expect(extractGatewayMetadata({ typesafe: {} })).toEqual({});
  });

  it('ignores unparseable cost values rather than reporting NaN', () => {
    const metadata = extractGatewayMetadata({ gateway: { marketCost: 'free', cost: null } });
    expect(metadata.marketCostUsd).toBeUndefined();
    expect(metadata.billedCostUsd).toBeUndefined();
  });
});

describe('extractConfidence', () => {
  it('reads a per-question record', () => {
    expect(extractConfidence({ typesafe: { confidence: { a: 0.5, b: 0.9 } } }, ['a', 'b'])).toEqual({
      a: 0.5,
      b: 0.9,
    });
  });

  it('broadcasts a single number to every question', () => {
    expect(extractConfidence({ typesafe: { confidence: 0.6 } }, ['a', 'b'])).toEqual({
      a: 0.6,
      b: 0.6,
    });
  });

  it('returns an empty record when absent', () => {
    expect(extractConfidence(undefined, ['a'])).toEqual({});
    expect(extractConfidence({}, ['a'])).toEqual({});
    expect(extractConfidence({ typesafe: {} }, ['a'])).toEqual({});
  });

  it('returns an empty record for the empty object a boolean-only call returns', () => {
    // Observed live: boolean questions carry no confidence, so the provider
    // sends `confidence: {}` rather than omitting the field.
    expect(extractConfidence({ typesafe: { confidence: {} } }, ['a'])).toEqual({});
  });
});

describe('assertRequestIsWithinLimits', () => {
  it('rejects a request with no questions', () => {
    expect(() => assertRequestIsWithinLimits({ state: 'x', questions: {} })).toThrow(
      /at least one question/,
    );
  });

  it('rejects a Choice with more than 255 options', () => {
    const criteria = Object.fromEntries(
      Array.from({ length: JEV_LIMITS.maxChoiceOptions + 1 }, (_, i) => [`opt${i}`, 'x']),
    );
    expect(() =>
      assertRequestIsWithinLimits({
        state: 'x',
        questions: { q: { type: 'choice', instructions: 'pick', criteria } },
      }),
    ).toThrow(/at most 255/);
  });

  it('accepts exactly 255 options', () => {
    const criteria = Object.fromEntries(
      Array.from({ length: JEV_LIMITS.maxChoiceOptions }, (_, i) => [`opt${i}`, 'x']),
    );
    expect(() =>
      assertRequestIsWithinLimits({
        state: 'x',
        questions: { q: { type: 'choice', instructions: 'pick', criteria } },
      }),
    ).not.toThrow();
  });

  it('rejects an empty Choice and a one-level Score', () => {
    expect(() =>
      assertRequestIsWithinLimits({
        state: 'x',
        questions: { q: { type: 'choice', instructions: 'pick', criteria: {} } },
      }),
    ).toThrow(/no options/);
    expect(() =>
      assertRequestIsWithinLimits({
        state: 'x',
        questions: { q: { type: 'score', instructions: 'rate', criteria: ['only'] } },
      }),
    ).toThrow(/at least two ordered levels/);
  });

  it('rejects state far over the 32k state budget', () => {
    expect(() =>
      assertRequestIsWithinLimits({
        state: 'x'.repeat(200_000),
        questions: { q: { type: 'boolean', instructions: 'is it?' } },
      }),
    ).toThrow(/over Jev's 32000 limit/);
  });
});
