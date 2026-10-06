import { describe, expect, it, vi } from 'vitest';
import {
  describeOpenRouterError,
  isRetryableStatus,
  isWorkersAiServed,
  OpenRouterClient,
} from '../openrouter.js';

/** The Decisions API returns answers at the top level, with no envelope. */
function reply(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

const CHOICE_PAYLOAD = {
  id: 'gen-dec-1789738314-X5e5eKGQdvR9rblyX250',
  model: 'cloudflare/clef-20261001',
  provider: 'Cloudflare',
  answers: {
    target: {
      type: 'choice',
      choice: 'B6',
      confidence: 0.91,
      probabilities: { B6: 0.9, A2: 0.08, J10: 0.02 },
    },
  },
  usage: { cost: 0.000019992, input_tokens: 476, output_tokens: 70 },
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

function client(payload: unknown = CHOICE_PAYLOAD, status = 200, opts = {}) {
  const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => reply(payload, status));
  return {
    fetchImpl,
    client: new OpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch, ...opts }),
  };
}

describe('OpenRouterClient', () => {
  it('sends the full slug in the body and posts to the decisions endpoint', async () => {
    const { client: c, fetchImpl } = client(CHOICE_PAYLOAD, 200, {
      model: 'cloudflare/clef-flash',
    });
    await c.ask(request);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    const body = JSON.parse(init.body as string);
    // One spelling, in the body. Workers AI needs two; this does not.
    expect(body.model).toBe('cloudflare/clef-flash');
    expect(body.questions.target.type).toBe('choice');
  });

  it('reads answers from the top level rather than from an envelope', async () => {
    const { client: c } = client();
    const res = await c.ask(request);
    expect(res.answers.target).toMatchObject({ type: 'choice', choice: 'B6' });
    expect(res.confidence.target).toBeCloseTo(0.91);
  });

  it('reports the billed cost as measured, not estimated', async () => {
    const { client: c } = client();
    const res = await c.ask(request);
    expect(res.billedCostUsd).toBeCloseTo(0.000019992);
    // Nothing is derived from a hardcoded rate on this transport.
    expect(res.estimatedCostUsd).toBeUndefined();
    expect(c.stats.billedCostUsd).toBeCloseTo(0.000019992);
  });

  it('records the fully resolved model build and the generation id', async () => {
    const { client: c } = client();
    const res = await c.ask(request);
    expect(res.modelId).toBe('cloudflare/clef-20261001');
    expect(res.generationId).toBe('gen-dec-1789738314-X5e5eKGQdvR9rblyX250');
  });

  it('passes a session id through when one is given', async () => {
    const { client: c, fetchImpl } = client(CHOICE_PAYLOAD, 200, { sessionId: 'bench-run-7' });
    await c.ask(request);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.session_id).toBe('bench-run-7');
  });

  it('omits the session id when none is given', async () => {
    const { client: c, fetchImpl } = client();
    await c.ask(request);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body).not.toHaveProperty('session_id');
  });

  it('rejects an empty question map before spending a call', async () => {
    const { client: c, fetchImpl } = client();
    await expect(c.ask({ ...request, questions: {} })).rejects.toThrow(/at least one question/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('counts a failure and still logs the call', async () => {
    const { client: c } = client({ error: { code: 429, message: 'Rate limit exceeded' } }, 429, {
      retries: 0,
    });
    await expect(c.ask(request)).rejects.toThrow(/429/);
    expect(c.stats.failures).toBe(1);
    expect(c.log.at(-1)?.error).toMatch(/rate limit/i);
  });

  it('requires a key when it would really reach the network', () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => new OpenRouterClient()).toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });
});

describe('describeOpenRouterError', () => {
  it('names a credit exhaustion separately from a generic failure', () => {
    const msg = describeOpenRouterError(402, {
      error: { code: 402, message: 'Insufficient credits.' },
    });
    expect(msg).toMatch(/out of credits/);
  });

  it('names a rate limit separately', () => {
    expect(describeOpenRouterError(429, { error: { message: 'Rate limit exceeded' } })).toMatch(
      /rate limit/i,
    );
  });

  it('falls back when the body carries no error object', () => {
    expect(describeOpenRouterError(500, {})).toBe('Decisions request failed (500)');
  });
});

describe('isWorkersAiServed', () => {
  it('flags the Clef models, which inherit the Workers AI state truncation', () => {
    expect(isWorkersAiServed('cloudflare/clef')).toBe(true);
    expect(isWorkersAiServed('cloudflare/clef-flash')).toBe(true);
  });

  it('does not flag Jev, which TypeSafe serves itself', () => {
    expect(isWorkersAiServed('typesafe/jev-1.13')).toBe(false);
  });
});

describe('transient failure handling', () => {
  /** Fails with `status` the given number of times, then succeeds. */
  function flakyClient(status: number, failures: number) {
    let n = 0;
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
      if (n++ < failures) {
        return reply({ error: { code: status, message: 'Clef inference failed' } }, status);
      }
      return reply(CHOICE_PAYLOAD, 200);
    });
    return {
      fetchImpl,
      client: new OpenRouterClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        backoffMs: 1,
      }),
    };
  }

  it('retries a 529, the status Workers AI returned during the probe', async () => {
    const { client: c, fetchImpl } = flakyClient(529, 2);
    const res = await c.ask(request);
    expect(res.answers.target).toMatchObject({ choice: 'B6' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(res.attempts).toBe(3);
  });

  it('reports backoff separately so it cannot inflate the latency figure', async () => {
    const { client: c } = flakyClient(529, 1);
    const res = await c.ask(request);
    // One backoff of backoffMs=1 happened, and it is not inside latencyMs.
    expect(res.retryWaitMs).toBe(1);
    expect(res.latencyMs).toBeLessThan(50);
  });

  it('gives up after the configured number of retries', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      reply({ error: { message: 'still failing' } }, 503),
    );
    const c = new OpenRouterClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 2,
      backoffMs: 1,
    });
    await expect(c.ask(request)).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 402, which is not transient', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      reply({ error: { code: 402, message: 'Insufficient credits.' } }, 402),
    );
    const c = new OpenRouterClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 1,
    });
    await expect(c.ask(request)).rejects.toThrow(/out of credits/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 400, which would fail identically every time', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      reply({ error: { code: 400, message: 'Invalid request parameters' } }, 400),
    );
    const c = new OpenRouterClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      backoffMs: 1,
    });
    await expect(c.ask(request)).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableStatus', () => {
  it('covers the transient statuses and excludes the permanent ones', () => {
    for (const s of [429, 500, 502, 503, 524, 529]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [400, 401, 402, 403, 404, 413]) expect(isRetryableStatus(s)).toBe(false);
  });
});
