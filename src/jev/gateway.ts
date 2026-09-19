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
  private readonly gatewayOptions?: Record<string, unknown>;
  private readonly evaluateFn: typeof evaluate;
  private readonly onCall?: (log: JevCallLog) => void;
  private readonly calls: JevCallLog[] = [];

  readonly stats = {
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalLatencyMs: 0,
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
    this.gatewayOptions = options.gatewayOptions;
    this.evaluateFn = options.evaluateFn ?? evaluate;
    this.onCall = options.onCall;
  }

  get log(): readonly JevCallLog[] {
    return this.calls;
  }

  async ask(request: JevRequest): Promise<JevResponse> {
    assertRequestIsWithinLimits(request);

    const startedAt = new Date().toISOString();
    const start = performance.now();

    try {
      const result = await this.evaluateFn({
        model: this.evaluationModel as never,
        state: request.state as never,
        questions: request.questions as never,
        maxRetries: this.maxRetries,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        ...(this.gatewayOptions
          ? { providerOptions: { gateway: this.gatewayOptions as never } }
          : {}),
      });

      const latencyMs = performance.now() - start;
      const response: JevResponse = {
        answers: result.answers as Record<string, JevAnswer>,
        confidence: extractConfidence(result.providerMetadata, Object.keys(request.questions)),
        usage: {
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
        },
        modelId: result.response?.modelId ?? this.model,
        latencyMs,
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

  private record(log: JevCallLog): void {
    this.calls.push(log);
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

function normalizeWarnings(warnings: unknown): string[] | undefined {
  if (!Array.isArray(warnings) || warnings.length === 0) return undefined;
  return warnings.map((w) => (typeof w === 'string' ? w : JSON.stringify(w)));
}

/**
 * Checks what can be checked before spending a request: option counts, and a
 * rough token estimate against the documented budgets. The estimate uses the
 * usual ~4 characters per token approximation and is deliberately conservative;
 * it is a guard against obviously oversized state, not an exact accounting.
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

/** Rough ~4 characters per token approximation. Used only for pre-flight guards. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
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
