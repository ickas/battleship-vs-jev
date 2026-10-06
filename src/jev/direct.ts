import { TypeSafeClient } from '@typesafe-ai/sdk';
import type {
  ChoiceAnswer,
  JevAnswer,
  JevCallLog,
  JevClient,
  JevQuestion,
  JevRequest,
  JevResponse,
  ScoreAnswer,
} from './types.js';
import { assertRequestIsWithinLimits, isRateLimitError } from './gateway.js';
import { estimateCostUsd } from './pricing.js';
import { fromSystemOneAnswers, toSystemOneQuestions } from './systemOne.js';

// The wire format is shared with Clef; these names are kept for callers and
// tests that predate the second backend.
export {
  toSystemOneQuestions as toTypeSafeQuestions,
  fromSystemOneAnswers as fromTypeSafeAnswers,
};

/**
 * Talks to the TypeSafe API directly, instead of going through Vercel AI Gateway.
 *
 * The plan asks for this to measure Gateway overhead, and it turns out to be
 * better than the Gateway on three counts that matter to a benchmark:
 *
 *   - `result.model` names the model that actually answered, so results can
 *     finally record a version. The Gateway reports only the alias it was asked
 *     for (see docs/representation.md).
 *   - `probabilities` and `confidence` are non-optional on Choice and Score
 *     answers, so the heatmap always has a real source.
 *   - `model` can be set per request, which makes pinning a version possible.
 *
 * Naming differs between the two: TypeSafe calls a yes/no question a "Noul",
 * while the AI SDK calls it `boolean`. This project uses the AI SDK's names
 * throughout and translates here, at the boundary.
 */

/** Default model. `jev-latest` is the SDK's own fallback when none is given. */
export const DEFAULT_DIRECT_MODEL = 'jev-latest';

export interface DirectJevClientOptions {
  /** API key. Falls back to TYPESAFE_API_KEY. */
  apiKey?: string;
  /** Model to request. A concrete version pins it; an alias follows the latest. */
  model?: string;
  /** Per-attempt timeout in milliseconds. The SDK's own default is 10000. */
  timeoutMs?: number;
  /** Retries after the first attempt. The SDK honours Retry-After on a 429. */
  maxRetries?: number;
  keepFullLog?: boolean;
  maxLogEntries?: number;
  /** Minimum gap between requests, matching the Gateway client's pacing. */
  minIntervalMs?: number;
  /** Injected in tests, so no network call is made. */
  clientImpl?: Pick<TypeSafeClient, 'systemOne'>;
  onCall?: (log: JevCallLog) => void;
}

export class DirectJevClient implements JevClient {
  private readonly client: Pick<TypeSafeClient, 'systemOne'>;
  private readonly model: string;
  private readonly keepFullLog: boolean;
  private readonly maxLogEntries: number;
  private readonly minIntervalMs: number;
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
  };

  constructor(options: DirectJevClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!options.clientImpl && !apiKey) {
      throw new Error(
        'TYPESAFE_API_KEY is not set. Get a key from https://typesafe.ai and put it in ' +
          '.env.local, or use the Gateway client instead.',
      );
    }

    this.model = options.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_DIRECT_MODEL;
    this.keepFullLog = options.keepFullLog ?? true;
    this.maxLogEntries = options.maxLogEntries ?? 500;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.onCall = options.onCall;

    this.client =
      options.clientImpl ??
      new TypeSafeClient({
        apiKey,
        defaultModel: this.model,
        timeout: options.timeoutMs ?? 30_000,
        // The SDK retries 408, 429 and 5xx by default and honours Retry-After,
        // so rate limits are handled here rather than by hand.
        retry: { maxRetries: options.maxRetries ?? 4 },
      });
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
      const result = await this.client.systemOne({
        state: (request.state ?? null) as never,
        questions: toSystemOneQuestions(request.questions) as never,
        model: this.model,
        ...(request.abortSignal ? { signal: request.abortSignal } : {}),
      });

      const latencyMs = performance.now() - start;
      const { answers, confidence } = fromSystemOneAnswers(
        result.answers as Record<string, unknown>,
      );

      const usage = {
        inputTokens: result.usage?.input_tokens,
        outputTokens: result.usage?.output_tokens,
        totalTokens:
          result.usage === undefined
            ? undefined
            : result.usage.input_tokens + result.usage.output_tokens,
      };

      const response: JevResponse = {
        answers,
        confidence,
        usage,
        // TypeSafe reports no cost, so this is the published rate applied to
        // the usage it does report. Labelled as an estimate everywhere it shows.
        estimatedCostUsd: estimateCostUsd(usage),
        // Unlike the Gateway, this is the model that actually answered.
        modelId: result.model ?? this.model,
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
      this.stats.inputTokens += response.usage.inputTokens ?? 0;
      this.stats.outputTokens += response.usage.outputTokens ?? 0;
      this.stats.totalLatencyMs += latencyMs;

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

  private async pace(abortSignal?: AbortSignal): Promise<void> {
    if (this.minIntervalMs <= 0) return;

    const wait = this.pacingChain.then(async () => {
      const remaining = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
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

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: number; statusCode?: number }).status
      ?? (error as { statusCode?: number }).statusCode;
    const rateLimited = isRateLimitError(error) ? ' [rate limit]' : '';
    return status
      ? `${error.name} (${status})${rateLimited}: ${error.message}`
      : `${error.name}${rateLimited}: ${error.message}`;
  }
  return String(error);
}
