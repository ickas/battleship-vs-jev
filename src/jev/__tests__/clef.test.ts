import { describe, expect, it, vi } from 'vitest';
import {
  assertClefRequestIsWithinLimits,
  ClefClient,
  CLEF_LIMITS,
  describeCloudflareError,
  unwrapEnvelope,
} from '../clef.js';

/** Cloudflare's envelope around the documented model output. */
function envelope(result: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => ({ result, success: ok, errors: [], messages: [] }),
  } as unknown as Response;
}

const CHOICE_RESULT = {
  model: 'clef',
  answers: {
    target: {
      type: 'choice',
      choice: 'B6',
      confidence: 0.91,
      probabilities: { B6: 0.9, A2: 0.08, J10: 0.02 },
    },
  },
  usage: { input_tokens: 408, output_tokens: 62 },
};

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

function client(result: unknown = CHOICE_RESULT, opts = {}) {
  const fetchImpl = vi.fn(async () => envelope(result));
  return {
    client: new ClefClient({ fetchImpl: fetchImpl as unknown as typeof fetch, ...opts }),
    fetchImpl,
  };
}

describe('ClefClient request shape', () => {
  it('puts the full slug in the URL and the bare name in the body', async () => {
    const { client: c, fetchImpl } = client();
    await c.ask(request);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The two spellings are not interchangeable; the body pattern rejects the slug.
    expect(url).toContain('/ai/run/@cf/cloudflare/clef');
    expect(JSON.parse(init.body as string).model).toBe('clef');
  });

  it('uses the flash slug and name when asked', async () => {
    const { client: c, fetchImpl } = client(CHOICE_RESULT, { model: 'clef-flash' });
    await c.ask(request);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('@cf/cloudflare/clef-flash');
    expect(JSON.parse(init.body as string).model).toBe('clef-flash');
  });

  it('sends a bearer token and the account id in the path', async () => {
    const { client: c, fetchImpl } = client(CHOICE_RESULT, {
      accountId: 'acct123',
      apiToken: 'tok456',
    });
    await c.ask(request);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/accounts/acct123/ai/run/');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok456');
  });

  it('translates questions into the System One wire format', async () => {
    const { client: c, fetchImpl } = client();
    await c.ask({
      state: 'x',
      questions: {
        hunting: { type: 'boolean', instructions: 'Is a ship hit?' },
        target: { type: 'choice', instructions: 'Pick', criteria: { a: 'A', b: 'B' } },
      },
    });

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    // boolean is the AI SDK's name; the wire format calls it noul, same as Jev.
    expect(body.questions.hunting.type).toBe('noul');
    expect(body.questions.target.type).toBe('choice');
  });
});

describe('ClefClient response handling', () => {
  it('unwraps the Cloudflare envelope and maps the answer', async () => {
    const { client: c } = client();
    const response = await c.ask(request);

    expect(response.answers.target).toEqual({
      type: 'choice',
      choice: 'B6',
      probabilities: { B6: 0.9, A2: 0.08, J10: 0.02 },
    });
    expect(response.confidence.target).toBe(0.91);
  });

  it('reports the model that answered and maps snake_case usage', async () => {
    const { client: c } = client();
    const response = await c.ask(request);

    expect(response.modelId).toBe('clef');
    expect(response.usage).toEqual({ inputTokens: 408, outputTokens: 62, totalTokens: 470 });
  });

  it('estimates cost at the Clef rate, not the Jev rate', async () => {
    const { client: c } = client();
    const response = await c.ask(request);
    // 408 input tokens at $0.240 per million.
    expect(response.estimatedCostUsd).toBeCloseTo((408 * 0.24) / 1e6, 12);
  });

  it('estimates cost at the cheaper flash rate for flash', async () => {
    const { client: c } = client({ ...CHOICE_RESULT, model: 'clef-flash' }, { model: 'clef-flash' });
    const response = await c.ask(request);
    expect(response.estimatedCostUsd).toBeCloseTo((408 * 0.09) / 1e6, 12);
  });

  it('records the call and accumulates stats', async () => {
    const { client: c } = client();
    await c.ask(request);
    await c.ask(request);

    expect(c.stats).toMatchObject({ calls: 2, failures: 0, inputTokens: 816, outputTokens: 124 });
    expect(c.log).toHaveLength(2);
    expect(c.log[0]!.response?.modelId).toBe('clef');
  });

  it('surfaces a Cloudflare error body and counts the failure', async () => {
    const failing = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        result: null,
        success: false,
        errors: [{ code: 7001, message: 'questions: too many entries' }],
      }),
    })) as unknown as typeof fetch;

    const c = new ClefClient({ fetchImpl: failing });
    await expect(c.ask(request)).rejects.toThrow(/7001: questions: too many entries/);
    expect(c.stats.failures).toBe(1);
    expect(c.log[0]!.error).toContain('400');
  });

  it('refuses to construct without credentials', () => {
    const saved = [process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_API_TOKEN];
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      expect(() => new ClefClient()).toThrow(/CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/);
    } finally {
      if (saved[0]) process.env.CLOUDFLARE_ACCOUNT_ID = saved[0];
      if (saved[1]) process.env.CLOUDFLARE_API_TOKEN = saved[1];
    }
  });
});

describe('unwrapEnvelope', () => {
  it('returns the result when the envelope is present', () => {
    expect(unwrapEnvelope({ result: { model: 'clef' }, success: true })).toEqual({ model: 'clef' });
  });

  it('tolerates an unwrapped body, in case the envelope ever goes away', () => {
    expect(unwrapEnvelope({ model: 'clef', answers: {} })).toEqual({ model: 'clef', answers: {} });
  });
});

describe('describeCloudflareError', () => {
  it('includes every error code and message', () => {
    const msg = describeCloudflareError(400, {
      errors: [{ code: 1, message: 'bad model' }, { code: 2, message: 'bad state' }],
    });
    expect(msg).toContain('1: bad model');
    expect(msg).toContain('2: bad state');
  });

  it('falls back to the status when the body carries no errors', () => {
    expect(describeCloudflareError(500, {})).toBe('Clef request failed (500)');
  });
});

describe('assertClefRequestIsWithinLimits', () => {
  const choice = (n: number) => ({
    type: 'choice' as const,
    instructions: 'pick',
    criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, 'x'])),
  });

  it('accepts the ~90 options the pure player offers', () => {
    expect(() =>
      assertClefRequestIsWithinLimits({ state: 'x', questions: { q: choice(90) } }),
    ).not.toThrow();
  });

  it('accepts exactly 255 options and rejects 256', () => {
    expect(() =>
      assertClefRequestIsWithinLimits({ state: 'x', questions: { q: choice(255) } }),
    ).not.toThrow();
    expect(() =>
      assertClefRequestIsWithinLimits({ state: 'x', questions: { q: choice(256) } }),
    ).toThrow(/at most 255/);
  });

  it('rejects a single-option choice, which the schema forbids', () => {
    expect(() =>
      assertClefRequestIsWithinLimits({ state: 'x', questions: { q: choice(1) } }),
    ).toThrow(/at least 2 options/);
  });

  it('enforces the 64-question cap that Jev does not document', () => {
    const questions = Object.fromEntries(
      Array.from({ length: CLEF_LIMITS.maxQuestions + 1 }, (_, i) => [
        `q${i}`,
        { type: 'boolean' as const, instructions: 'is it?' },
      ]),
    );
    expect(() => assertClefRequestIsWithinLimits({ state: 'x', questions })).toThrow(
      /at most 64 questions/,
    );
  });

  it('rejects question ids the schema would reject', () => {
    expect(() =>
      assertClefRequestIsWithinLimits({
        state: 'x',
        questions: { 'bad id!': { type: 'boolean', instructions: 'q' } },
      }),
    ).toThrow(/letters, digits/);

    expect(() =>
      assertClefRequestIsWithinLimits({
        state: 'x',
        questions: { ['a'.repeat(101)]: { type: 'boolean', instructions: 'q' } },
      }),
    ).toThrow(/exceeds 100 characters/);
  });

  it('rejects an empty question map', () => {
    expect(() => assertClefRequestIsWithinLimits({ state: 'x', questions: {} })).toThrow(
      /at least one question/,
    );
  });
});
