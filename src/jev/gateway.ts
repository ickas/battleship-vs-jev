import { experimental_evaluate as evaluate } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import type {
  JevAnswer,
  JevCallLog,
  JevClient,
  JevRequest,
  JevResponse,
} from './types.js';

/**
 * The primary JevClient: TypeSafe's Jev reached through Vercel AI Gateway with
 * the AI SDK's `experimental_evaluate`.
 *
 * Evaluation is AI SDK only — it is not available on the OpenAI-, Anthropic- or
 * Cohere-compatible Gateway endpoints, and needs AI SDK 7.0.105 or later.
 * Auth comes from `AI_GATEWAY_API_KEY`, or from OIDC when running on Vercel.
 */

/** Gateway model id for Jev. Resolves to a concrete version reported per response. */
export const JEV_MODEL_ID = 'typesafe-ai/jev';

/** Documented model limits. Used to fail loudly rather than send an over-budget request. */
export const JEV_LIMITS = {
  /** Total tokens per request. */
  requestTokenBudget: 64_000,
  /** State plus the longest single question. */
  stateTokenBudget: 32_000,
  /** Options per Choice question. */
  maxChoiceOptions: 255,
} as const;

export interface GatewayJevClientOptions {
  model?: string;
  /**
   * Gateway API key. Defaults to AI_GATEWAY_API_KEY, read when the client is
   * constructed rather than at import time, so loading a .env file first works.
   * Leave unset on Vercel, where OIDC supplies the credential.
   */
  apiKey?: string;
  /** Passed to the AI SDK, which retries on transient errors. Defaults to 2. */
  maxRetries?: number;
  /** Keeps every call's state and questions in the log. Off for long batches. */
  keepFullLog?: boolean;
  /** Most recent calls retained in `log`. Defaults to 500. */
  maxLogEntries?: number;
  /**
   * Minimum gap between the start of one request and the next, in
   * milliseconds. The Gateway's free tier rate-limits this model hard enough
   * to fail a benchmark outright, and pacing is cheaper than retrying into the
   * same limit. 0 disables it.
   */
  minIntervalMs?: number;
  /**
   * Extra attempts after the AI SDK's own retries are exhausted, for rate
   * limits specifically. Each waits longer than the last.
   */
  rateLimitRetries?: number;
  /** Base backoff for those retries, doubling each attempt. Defaults to 4000ms. */
  rateLimitBackoffMs?: number;
  /** Gateway-specific per-request options, e.g. `{ zeroDataRetention: true }`. */
  gatewayOptions?: Record<string, unknown>;
  /** Injected in tests. Defaults to the AI SDK's `experimental_evaluate`. */
  evaluateFn?: typeof evaluate;
  onCall?: (log: JevCallLog) => void;
}

export class GatewayJevClient implements JevClient {
  private readonly model: string;
  private readonly evaluationModel: unknown;
  private readonly maxRetries: number;
  private readonly keepFullLog: boolean;
  private readonly maxLogEntries: number;
  private readonly minIntervalMs: number;
  private readonly rateLimitRetries: number;
  private readonly rateLimitBackoffMs: number;
  /** Serializes pacing so concurrent callers queue rather than all firing at once. */
  private pacingChain: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly gatewayOptions?: Record<string, unknown>;
  private readonly evaluateFn: typeof evaluate;
  private readonly onCall?: (log: JevCallLog) => void;
  private readonly calls: JevCallLog[] = [];

  readonly stats = {
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    /** Gateway round-trip time only, excluding client-side backoff waiting. */
    totalLatencyMs: 0,
    /** Time spent sleeping between rate-limit retries. Never part of latency. */
    retryWaitMs: 0,
  };

  constructor(options: GatewayJevClientOptions = {}) {
    this.model = options.model ?? JEV_MODEL_ID;
    const apiKey = options.apiKey ?? process.env.AI_GATEWAY_API_KEY;
    // An explicit provider instance keeps key resolution independent of when
    // the module was imported relative to .env being loaded.
    this.evaluationModel = apiKey
      ? createGateway({ apiKey }).evaluationModel(this.model as never)
      : this.model;
    this.maxRetries = options.maxRetries ?? 2;
    this.keepFullLog = options.keepFullLog ?? true;
    this.maxLogEntries = options.maxLogEntries ?? 500;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.rateLimitRetries = options.rateLimitRetries ?? 0;
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? 4000;
    this.gatewayOptions = options.gatewayOptions;
    this.evaluateFn = options.evaluateFn ?? evaluate;
    this.onCall = options.onCall;
  }

  get log(): readonly JevCallLog[] {
    return this.calls;
  }

  async ask(request: JevRequest): Promise<JevResponse> {
    assertRequestIsWithinLimits(request);
    await this.pace(request.abortSignal);

    const startedAt = new Date().toISOString();
    const start = performance.now();

    try {
      const { result, latencyMs, attempts, retryWaitMs } = await this.withRateLimitRetry(
        request.abortSignal,
        () =>
          this.evaluateFn({
            model: this.evaluationModel as never,
            state: request.state as never,
            questions: request.questions as never,
            maxRetries: this.maxRetries,
            ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
            ...(this.gatewayOptions
              ? { providerOptions: { gateway: this.gatewayOptions as never } }
              : {}),
          }),
      );
      const response: JevResponse = {
        answers: result.answers as Record<string, JevAnswer>,
        confidence: extractConfidence(result.providerMetadata, Object.keys(request.questions)),
        usage: {
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
        },
        modelId: result.response?.modelId ?? this.model,
        ...extractGatewayMetadata(result.providerMetadata),
        latencyMs,
        attempts,
        retryWaitMs,
        warnings: normalizeWarnings(result.warnings),
        rounding: result.rounding,
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
      this.stats.inputTokens += response.usage.inputTokens ?? 0;
      this.stats.outputTokens += response.usage.outputTokens ?? 0;
      this.stats.totalLatencyMs += latencyMs;
      this.stats.retryWaitMs += retryWaitMs;

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
        error: describeError(error),
        latencyMs,
        startedAt,
      });

      throw error;
    }
  }

  /**
   * Holds each request to at least `minIntervalMs` after the previous one.
   * Chained rather than checked, so parallel callers queue instead of all
   * observing the same stale timestamp and firing together.
   */
  private async pace(abortSignal?: AbortSignal): Promise<void> {
    if (this.minIntervalMs <= 0) return;

    const wait = this.pacingChain.then(async () => {
      const elapsed = Date.now() - this.lastRequestAt;
      const remaining = this.minIntervalMs - elapsed;
      if (remaining > 0) await sleep(remaining, abortSignal);
      this.lastRequestAt = Date.now();
    });

    // Keep the chain alive even if this link is aborted.
    this.pacingChain = wait.catch(() => undefined);
    await wait;
  }

  /**
   * Retries a rate-limited call beyond the AI SDK's own attempts, backing off
   * further each time. Any other failure is rethrown immediately - only rate
   * limits are worth waiting out.
   *
   * Each attempt is timed on its own and only the successful attempt's duration
   * is reported as latency. Backoff is client-side waiting, not Gateway
   * round-trip time, so folding it into `latencyMs` would inflate every
   * benchmark figure that is labelled end-to-end through the Gateway. It is
   * returned separately instead.
   */
  private async withRateLimitRetry<T>(
    abortSignal: AbortSignal | undefined,
    call: () => Promise<T>,
  ): Promise<{ result: T; latencyMs: number; attempts: number; retryWaitMs: number }> {
    let lastError: unknown;
    let retryWaitMs = 0;

    for (let attempt = 0; attempt <= this.rateLimitRetries; attempt++) {
      const attemptStart = performance.now();
      try {
        const result = await call();
        return {
          result,
          latencyMs: performance.now() - attemptStart,
          attempts: attempt + 1,
          retryWaitMs,
        };
      } catch (error) {
        lastError = error;
        if (!isRateLimitError(error) || attempt === this.rateLimitRetries) throw error;
        const wait = this.rateLimitBackoffMs * 2 ** attempt;
        retryWaitMs += wait;
        await sleep(wait, abortSignal);
      }
    }
    throw lastError;
  }

  private record(log: JevCallLog): void {
    this.calls.push(log);
    // Keep the log bounded: a few hundred games would otherwise retain every
    // state object for the life of the process. Running totals live in `stats`.
    if (this.calls.length > this.maxLogEntries) {
      this.calls.splice(0, this.calls.length - this.maxLogEntries);
    }
    this.onCall?.(log);
  }
}

/**
 * Confidence is reported at `providerMetadata.typesafe.confidence`, separately
 * for Choice and Score questions. The provider may return a single number or a
 * per-question record, so both are handled.
 */
export function extractConfidence(
  providerMetadata: unknown,
  questionIds: string[],
): Record<string, number> {
  const typesafe = (providerMetadata as { typesafe?: { confidence?: unknown } } | undefined)
    ?.typesafe;
  const raw = typesafe?.confidence;
  if (raw === undefined || raw === null) return {};

  if (typeof raw === 'number') {
    return Object.fromEntries(questionIds.map((id) => [id, raw]));
  }
  if (typeof raw === 'object') {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'number') out[key] = value;
    }
    return out;
  }
  return {};
}

/**
 * Pulls the Gateway's own bookkeeping out of providerMetadata: the generation
 * id, and the list and billed costs. Costs are read from the response rather
 * than computed from a hardcoded rate.
 */
export function extractGatewayMetadata(providerMetadata: unknown): {
  generationId?: string;
  marketCostUsd?: number;
  billedCostUsd?: number;
} {
  const gateway = (providerMetadata as { gateway?: Record<string, unknown> } | undefined)?.gateway;
  if (!gateway) return {};

  const toNumber = (value: unknown): number | undefined => {
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    generationId: typeof gateway.generationId === 'string' ? gateway.generationId : undefined,
    marketCostUsd: toNumber(gateway.marketCost),
    billedCostUsd: toNumber(gateway.cost),
  };
}

function normalizeWarnings(warnings: unknown): string[] | undefined {
  if (!Array.isArray(warnings) || warnings.length === 0) return undefined;
  return warnings.map((w) => (typeof w === 'string' ? w : JSON.stringify(w)));
}

/**
 * Checks what can be checked before spending a request: option counts, and a
 * rough token estimate against the documented budgets.
 *
 * The estimate uses the usual ~4 characters per token approximation. For the
 * JSON state sent here that is optimistic, not conservative - punctuation and
 * short keys tokenize worse than prose - so this catches only obviously
 * oversized state. It is a guard, not an accounting; the authoritative figure
 * is `usage.inputTokens` on the response.
 */
export function assertRequestIsWithinLimits(request: JevRequest): void {
  const questionIds = Object.keys(request.questions);
  if (questionIds.length === 0) {
    throw new Error('A Jev request needs at least one question');
  }

  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const optionCount = Object.keys(question.criteria).length;
      if (optionCount === 0) {
        throw new Error(`Choice question "${id}" has no options`);
      }
      if (optionCount > JEV_LIMITS.maxChoiceOptions) {
        throw new Error(
          `Choice question "${id}" has ${optionCount} options; Jev allows at most ${JEV_LIMITS.maxChoiceOptions}`,
        );
      }
    }
    if (question.type === 'score' && question.criteria.length < 2) {
      throw new Error(`Score question "${id}" needs at least two ordered levels`);
    }
  }

  const stateChars = JSON.stringify(request.state ?? '').length;
  const longestQuestionChars = Math.max(
    ...Object.values(request.questions).map((q) => JSON.stringify(q).length),
  );
  const stateTokens = estimateTokens(stateChars + longestQuestionChars);
  if (stateTokens > JEV_LIMITS.stateTokenBudget) {
    throw new Error(
      `State plus longest question is roughly ${stateTokens} tokens, over Jev's ${JEV_LIMITS.stateTokenBudget} limit`,
    );
  }

  const allQuestionChars = JSON.stringify(request.questions).length;
  const requestTokens = estimateTokens(stateChars + allQuestionChars);
  if (requestTokens > JEV_LIMITS.requestTokenBudget) {
    throw new Error(
      `Request is roughly ${requestTokens} tokens, over Jev's ${JEV_LIMITS.requestTokenBudget} budget`,
    );
  }
}

/**
 * Rough ~4 characters per token approximation, used only for pre-flight guards.
 * Real usage is read from the response, never computed from this.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** True for a Gateway 429 or an error that names a rate limit. */
export function isRateLimitError(error: unknown): boolean {
  if (!error) return false;
  const candidate = error as { statusCode?: number; status?: number; name?: string; message?: string };
  if (candidate.statusCode === 429 || candidate.status === 429) return true;
  const text = `${candidate.name ?? ''} ${candidate.message ?? ''}`.toLowerCase();
  return text.includes('rate limit') || text.includes('rate-limited');
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(abortSignal.reason);
      return;
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortSignal?.reason);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Gateway returns 429 on rate limits; surface the status when present.
    const status = (error as { statusCode?: number; status?: number }).statusCode
      ?? (error as { status?: number }).status;
    return status ? `${error.name} (${status}): ${error.message}` : `${error.name}: ${error.message}`;
  }
  return String(error);
}
