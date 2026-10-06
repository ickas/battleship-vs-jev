import type {
  JevAnswer,
  JevCallLog,
  JevClient,
  JevRequest,
  JevResponse,
} from './types.js';
import { fromSystemOneAnswers, toSystemOneQuestions } from './systemOne.js';

/**
 * The OpenRouter Decisions API, which serves Jev and both Clef models behind
 * one transport.
 *
 * This exists because it is the only route that puts every model in this
 * benchmark on an identical network path. Comparing Jev reached through the
 * Vercel Gateway against Clef reached through Workers AI would confound the
 * model with its transport, and latency is one of the things being measured.
 *
 * Differences from the other two transports, all verified against the
 * published OpenAPI document on 2026-10-06
 * (https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md):
 *
 *   - One bearer key, rather than Cloudflare's account id in the path plus a
 *     token, or the Gateway's own credential.
 *   - No response envelope. Workers AI wraps the answers in
 *     {result, success, errors, messages}; here `answers` sits at the top
 *     level and failures come back as {error: {code, message}}.
 *   - `usage.cost` is the real billed figure. Workers AI returns no cost at
 *     all, which is why ClefClient can only ever report an estimate against a
 *     hardcoded rate. Anything this client reports as cost was measured.
 *   - `model` echoes a fully resolved build, e.g. `typesafe/jev-1.13-20260917`.
 *     The Gateway only ever returned an alias, which is why the earlier runs
 *     could not record which Jev answered.
 *   - The model slug is the full namespaced name in the body. Workers AI wants
 *     the bare name in the body and the slug in the URL; here there is one
 *     spelling and it goes in the body.
 *
 * The question and answer shapes are the same System One shapes Jev uses, so
 * the translation is shared verbatim (see systemOne.ts).
 */

/**
 * Slugs are passed through as given so a new model needs no code change. The
 * union documents the three this benchmark uses.
 */
export type OpenRouterDecisionModel =
  | 'typesafe/jev-1.13'
  | 'cloudflare/clef'
  | 'cloudflare/clef-flash'
  | (string & {});

/**
 * Clef is served by Workers AI, which truncates long text state to roughly the
 * first 2K tokens. That limit is a property of the serving stack rather than of
 * the Decisions API, so it applies to Clef through OpenRouter as well.
 *
 * This matters for the benchmark rather than for the client: a state that
 * crosses it is silently half-read, and a model player reading half a board
 * would be measured as a worse player rather than as a truncated one. Probed
 * empirically by scripts/probe-state-truncation.mts; do not treat the number as
 * exact.
 */
export const WORKERS_AI_STATE_TOKEN_LIMIT = 2_000;

/** Models whose serving stack imposes the truncation above. */
export function isWorkersAiServed(model: string): boolean {
  return model.startsWith('cloudflare/');
}

export interface OpenRouterClientOptions {
  model?: OpenRouterDecisionModel;
  apiKey?: string;
  /** Overridable so tests never reach the network. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Groups a benchmark run in OpenRouter's own logs. Never sent to the provider. */
  sessionId?: string;
  keepFullLog?: boolean;
  maxLogEntries?: number;
  minIntervalMs?: number;
  timeoutMs?: number;
  onCall?: (log: JevCallLog) => void;
}

export class OpenRouterClient implements JevClient {
  readonly model: OpenRouterDecisionModel;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly sessionId?: string;
  private readonly keepFullLog: boolean;
  private readonly maxLogEntries: number;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly onCall?: (log: JevCallLog) => void;
  private readonly calls: JevCallLog[] = [];

  private pacingChain: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  readonly stats = {
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalLatencyMs: 0,
    retryWaitMs: 0,
    /** Summed from `usage.cost`, so this is billed rather than estimated. */
    billedCostUsd: 0,
  };

  constructor(options: OpenRouterClientOptions = {}) {
    this.model = options.model ?? 'cloudflare/clef';
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';

    if (!options.fetchImpl && !this.apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY must be set to call the Decisions API. ' +
          'Create one at https://openrouter.ai/keys.',
      );
    }

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/alpha/decisions';
    this.sessionId = options.sessionId;
    this.keepFullLog = options.keepFullLog ?? true;
    this.maxLogEntries = options.maxLogEntries ?? 500;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onCall = options.onCall;
  }

  get log(): readonly JevCallLog[] {
    return this.calls;
  }

  async ask(request: JevRequest): Promise<JevResponse> {
    if (Object.keys(request.questions).length === 0) {
      throw new Error('A Decisions request needs at least one question');
    }

    await this.pace(request.abortSignal);

    const startedAt = new Date().toISOString();
    const start = performance.now();

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        state: request.state ?? null,
        questions: toSystemOneQuestions(request.questions),
      };
      if (this.sessionId) body.session_id = this.sessionId;

      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = request.abortSignal
        ? AbortSignal.any([request.abortSignal, timeout])
        : timeout;

      const res = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });

      const latencyMs = performance.now() - start;
      const payload = (await res.json()) as Record<string, unknown>;

      if (!res.ok) throw new Error(describeOpenRouterError(res.status, payload));

      const { answers, confidence } = fromSystemOneAnswers(
        (payload.answers ?? {}) as Record<string, unknown>,
      );

      const rawUsage = payload.usage as
        | { cost?: number; input_tokens?: number; output_tokens?: number }
        | undefined;
      const usage = {
        inputTokens: rawUsage?.input_tokens,
        outputTokens: rawUsage?.output_tokens,
        totalTokens:
          rawUsage === undefined
            ? undefined
            : (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0),
      };

      const response: JevResponse = {
        answers: answers as Record<string, JevAnswer>,
        confidence,
        usage,
        // Fully resolved build, not an alias. This is the field the Gateway
        // could never give us.
        modelId: (payload.model as string) ?? this.model,
        generationId: payload.id as string | undefined,
        // Measured, not derived from a hardcoded rate.
        billedCostUsd: rawUsage?.cost,
        latencyMs,
        attempts: 1,
        retryWaitMs: 0,
      };

      this.record({
        label: request.label ?? 'unlabelled',
        state: this.keepFullLog ? request.state : '[omitted]',
        questions: this.keepFullLog ? request.questions : {},
        response,
        latencyMs,
        startedAt,
      });

      this.stats.calls++;
      this.stats.inputTokens += usage.inputTokens ?? 0;
      this.stats.outputTokens += usage.outputTokens ?? 0;
      this.stats.totalLatencyMs += latencyMs;
      this.stats.billedCostUsd += rawUsage?.cost ?? 0;

      return response;
    } catch (error) {
      const latencyMs = performance.now() - start;
      this.stats.calls++;
      this.stats.failures++;
      this.stats.totalLatencyMs += latencyMs;

      this.record({
        label: request.label ?? 'unlabelled',
        state: this.keepFullLog ? request.state : '[omitted]',
        questions: this.keepFullLog ? request.questions : {},
        error: error instanceof Error ? error.message : String(error),
        latencyMs,
        startedAt,
      });

      throw error;
    }
  }

  private async pace(abortSignal?: AbortSignal): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const wait = this.pacingChain.then(async () => {
      const remaining = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      this.lastRequestAt = Date.now();
    });
    this.pacingChain = wait.catch(() => undefined);
    await wait;
  }

  private record(log: JevCallLog): void {
    this.calls.push(log);
    if (this.calls.length > this.maxLogEntries) {
      this.calls.splice(0, this.calls.length - this.maxLogEntries);
    }
    this.onCall?.(log);
  }
}

/**
 * Failures are {error: {code, message}}, unlike Cloudflare's list of errors in
 * an envelope. 402 and 429 are called out because they are the two a long
 * benchmark run is most likely to hit, and the generic message hides which.
 */
export function describeOpenRouterError(
  status: number,
  payload: Record<string, unknown>,
): string {
  const error = payload.error as { code?: unknown; message?: unknown } | undefined;
  const message = error?.message ? String(error.message) : undefined;

  if (status === 402) {
    return `OpenRouter is out of credits (402): ${message ?? 'add credits at https://openrouter.ai/credits'}`;
  }
  if (status === 429) {
    return `OpenRouter rate limit hit (429): ${message ?? 'slow down and retry'}`;
  }
  return message
    ? `Decisions request failed (${status}): ${message}`
    : `Decisions request failed (${status})`;
}
