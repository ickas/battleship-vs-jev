import { describe, expect, it, vi } from 'vitest';
import {
  DirectJevClient,
  fromTypeSafeAnswers,
  toTypeSafeQuestions,
} from '../direct.js';

/** Stands in for the TypeSafe SDK, so tests make no network call. */
function fakeClient(result: Record<string, unknown> = {}) {
  return {
    systemOne: vi.fn(async () => ({
      model: 'jev-1.13.0',
      answers: {
        target: {
          type: 'choice',
          choice: 'B6',
          confidence: 0.91,
          probabilities: { B6: 0.9, A2: 0.08, J10: 0.02 },
        },
      },
      usage: { input_tokens: 408, output_tokens: 62 },
      ...result,
    })),
  } as never;
}

const request = {
  state: { board: 'B5 was hit' },
  questions: {
    target: {
      type: 'choice' as const,
      instructions: 'Which cell holds a ship?',
      criteria: { B6: 'below the hit', A2: 'unexplored', J10: 'far corner' },
    },
  },
  label: 'test',
};

describe('DirectJevClient', () => {
  it('reports the model that actually answered, not the alias requested', async () => {
    const client = new DirectJevClient({ clientImpl: fakeClient(), model: 'jev-latest' });
    const response = await client.ask(request);

    // This is the whole point of the direct client: the Gateway cannot do it.
    expect(response.modelId).toBe('jev-1.13.0');
  });

  it('maps answers, probabilities, confidence and usage', async () => {
    const client = new DirectJevClient({ clientImpl: fakeClient() });
    const response = await client.ask(request);

    expect(response.answers.target).toEqual({
      type: 'choice',
      choice: 'B6',
      probabilities: { B6: 0.9, A2: 0.08, J10: 0.02 },
    });
    // TypeSafe puts confidence on the answer; this project keeps it in a map,
    // matching the Gateway's shape, so strategies work with either client.
    expect(response.confidence.target).toBe(0.91);
    // snake_case in, camelCase out.
    expect(response.usage).toEqual({ inputTokens: 408, outputTokens: 62, totalTokens: 470 });
  });

  it('passes the pinned model through on every request', async () => {
    const impl = fakeClient();
    const client = new DirectJevClient({ clientImpl: impl, model: 'jev-1.13.0' });
    await client.ask(request);

    const args = (impl as unknown as { systemOne: { mock: { calls: unknown[][] } } }).systemOne
      .mock.calls[0]![0] as { model: string };
    expect(args.model).toBe('jev-1.13.0');
  });

  it('accumulates stats and logs the call', async () => {
    const client = new DirectJevClient({ clientImpl: fakeClient() });
    await client.ask(request);
    await client.ask(request);

    expect(client.stats).toMatchObject({ calls: 2, failures: 0, inputTokens: 816, outputTokens: 124 });
    expect(client.log).toHaveLength(2);
    expect(client.log[0]!.label).toBe('test');
    expect(client.log[0]!.response?.modelId).toBe('jev-1.13.0');
  });

  it('records a failure and rethrows', async () => {
    const failing = {
      systemOne: vi.fn(async () => {
        const error = new Error('Too Many Requests');
        error.name = 'RateLimitError';
        (error as { status?: number }).status = 429;
        throw error;
      }),
    } as never;

    const client = new DirectJevClient({ clientImpl: failing });
    await expect(client.ask(request)).rejects.toThrow('Too Many Requests');
    expect(client.stats.failures).toBe(1);
    expect(client.log[0]!.error).toContain('429');
    expect(client.log[0]!.error).toContain('rate limit');
  });

  it('enforces the same request limits as the Gateway client', async () => {
    const client = new DirectJevClient({ clientImpl: fakeClient() });
    await expect(client.ask({ state: 'x', questions: {} })).rejects.toThrow(
      /at least one question/,
    );
  });

  it('omits state from the log when keepFullLog is off', async () => {
    const client = new DirectJevClient({ clientImpl: fakeClient(), keepFullLog: false });
    await client.ask(request);
    expect(client.log[0]!.state).toBe('[omitted]');
  });

  it('paces requests when asked', async () => {
    const client = new DirectJevClient({ clientImpl: fakeClient(), minIntervalMs: 50 });
    const start = Date.now();
    await client.ask(request);
    await client.ask(request);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('refuses to construct without a key and without an injected client', () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(() => new DirectJevClient()).toThrow(/TYPESAFE_API_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });
});

describe('question translation', () => {
  it('turns a boolean question into a Noul', () => {
    // The naming differs between TypeSafe and the AI SDK; this is the boundary.
    const out = toTypeSafeQuestions({
      passed: {
        type: 'boolean',
        instructions: 'Did it pass?',
        criteria: { true: 'exit 0', false: 'non-zero' },
      },
    });
    expect(out.passed).toEqual({
      type: 'noul',
      instructions: 'Did it pass?',
      criteria: { true: 'exit 0', false: 'non-zero' },
    });
  });

  it('omits criteria for a boolean question that has none', () => {
    const out = toTypeSafeQuestions({ q: { type: 'boolean', instructions: 'Is it?' } });
    expect(out.q).toEqual({ type: 'noul', instructions: 'Is it?' });
  });

  it('passes choice and score through unchanged', () => {
    const out = toTypeSafeQuestions({
      pick: { type: 'choice', instructions: 'Pick', criteria: { a: 'A', b: 'B' } },
      rate: { type: 'score', instructions: 'Rate', criteria: ['low', 'high'] },
    });
    expect(out.pick).toEqual({
      type: 'choice',
      instructions: 'Pick',
      criteria: { a: 'A', b: 'B' },
    });
    expect(out.rate).toEqual({ type: 'score', instructions: 'Rate', criteria: ['low', 'high'] });
  });
});

describe('answer translation', () => {
  it('turns a Noul back into a boolean probability', () => {
    const { answers, confidence } = fromTypeSafeAnswers({
      passed: { type: 'noul', noul: 0.98 },
    });
    expect(answers.passed).toEqual({ type: 'boolean', probability: 0.98 });
    // Noul answers carry no confidence, matching what the Gateway reports.
    expect(confidence).toEqual({});
  });

  it('lifts confidence out of choice and score answers', () => {
    const { answers, confidence } = fromTypeSafeAnswers({
      pick: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 1, b: 0 } },
      rate: { type: 'score', score: 2.5, confidence: 0.6, probabilities: { 0: 0, 1: 0.5, 2: 0.5 } },
    });

    expect(answers.pick).toEqual({ type: 'choice', choice: 'a', probabilities: { a: 1, b: 0 } });
    expect(answers.rate).toEqual({
      type: 'score',
      score: 2.5,
      probabilities: { 0: 0, 1: 0.5, 2: 0.5 },
    });
    expect(confidence).toEqual({ pick: 0.8, rate: 0.6 });
  });

  it('handles a mixed response', () => {
    const { answers, confidence } = fromTypeSafeAnswers({
      hunting: { type: 'noul', noul: 0.4 },
      target: { type: 'choice', choice: 'x', confidence: 0.5, probabilities: { x: 1 } },
    });
    expect(Object.keys(answers)).toEqual(['hunting', 'target']);
    expect(confidence).toEqual({ target: 0.5 });
  });
});
