import type {
  JevAnswer,
  JevCallLog,
  JevClient,
  JevQuestion,
  JevRequest,
  JevResponse,
} from './types.js';
import { estimateCostUsd } from './pricing.js';
import { fromSystemOneAnswers, toSystemOneQuestions } from './systemOne.js';

/**
 * Cloudflare's Clef decision models, through the Workers AI REST API.
 *
 * Clef speaks the same System One shapes as Jev, so the question and answer
 * translation is shared verbatim (see systemOne.ts). What differs is the
 * transport, and those differences are the reason this file exists at all:
 *
 *   - The model appears twice, and in two spellings. The URL takes the full
 *     slug `@cf/cloudflare/clef`; the body takes the bare name `clef`, which
 *     the published schema pins to /^\s*(clef|clef-flash)\s*$/. Sending the
 *     slug in the body is rejected.
 *   - Workers AI wraps every response in Cloudflare's envelope
 *     {result, success, errors, messages}. The documented output schema
 *     describes what sits inside `result`, not the HTTP body.
 *   - Auth is an account id in the path plus a bearer token, rather than a
 *     single key the SDK resolves.
 *   - At most 64 questions per request, which Jev's docs never state.
 *
 * Verified against Cloudflare's published JSON schemas on 2026-10-06:
 *   https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json
 *   https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json
 */

export type ClefModel = 'clef' | 'clef-flash';

/** Documented limits, from the input schema rather than from memory. */
export const CLEF_LIMITS = {
  /** Questions per request. Jev documents no equivalent cap. */
  maxQuestions: 64,
  /** Options per Choice question. Same as Jev. */
  maxChoiceOptions: 255,
  /** Context window in tokens. */
  contextTokens: 65_536,
  /** Question id characters and length. */
  maxQuestionIdLength: 100,
} as const;

export interface ClefClientOptions {
  model?: ClefModel;
  accountId?: string;
  apiToken?: string;
  /** Overridable so tests never reach the network. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  keepFullLog?: boolean;
  maxLogEntries?: number;
  minIntervalMs?: number;
  timeoutMs?: number;
  onCall?: (log: JevCallLog) => void;
}

export class ClefClient implements JevClient {
  readonly model: ClefModel;
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
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
  };

  constructor(options: ClefClientOptions = {}) {
    this.model = options.model ?? 'clef';
    this.accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
    this.apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? '';

    if (!options.fetchImpl && (!this.accountId || !this.apiToken)) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set to call Clef. ' +
          'Create a token with the Workers AI read/run permission.',
      );
    }

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.cloudflare.com/client/v4';
    this.keepFullLog = options.keepFullLog ?? true;
    this.maxLogEntries = options.maxLogEntries ?? 500;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onCall = options.onCall;
  }

  get log(): readonly JevCallLog[] {
    return this.calls;
  }

  /** `@cf/cloudflare/clef`, the spelling the URL wants. */
  get modelSlug(): string {
    return `@cf/cloudflare/${this.model}`;
  }

  async ask(request: JevRequest): Promise<JevResponse> {
    assertClefRequestIsWithinLimits(request);
    await this.pace(request.abortSignal);

    const startedAt = new Date().toISOString();
    const start = performance.now();

    try {
      const body = {
        // Bare name in the body, full slug in the URL. Not interchangeable.
        model: this.model,
        state: request.state ?? null,
        questions: toSystemOneQuestions(request.questions),
      };

      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = request.abortSignal
        ? AbortSignal.any([request.abortSignal, timeout])
        : timeout;

      const res = await this.fetchImpl(
        `${this.baseUrl}/accounts/${this.accountId}/ai/run/${this.modelSlug}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        },
      );

      const latencyMs = performance.now() - start;
      const payload = (await res.json()) as Record<string, unknown>;

      if (!res.ok) throw new Error(describeCloudflareError(res.status, payload));

      const result = unwrapEnvelope(payload);
      const { answers, confidence } = fromSystemOneAnswers(
        (result.answers ?? {}) as Record<string, unknown>,
      );

      const rawUsage = result.usage as { input_tokens?: number; output_tokens?: number } | undefined;
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
        // Clef reports which model answered, same as the direct Jev transport.
        modelId: (result.model as string) ?? this.model,
        latencyMs,
        attempts: 1,
        retryWaitMs: 0,
        // Workers AI returns no cost, so this is the published rate applied to
        // reported usage. Labelled as an estimate wherever it is shown.
        estimatedCostUsd: estimateCostUsd(usage, this.model),
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
 * Workers AI wraps the model output in Cloudflare's standard envelope. The
 * published output schema describes what is inside `result`, so a client that
 * reads the HTTP body directly finds no `answers` at all.
 */
export function unwrapEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  if ('result' in payload && typeof payload.result === 'object' && payload.result !== null) {
    return payload.result as Record<string, unknown>;
  }
  // Tolerate an unwrapped body in case the envelope ever goes away.
  return payload;
}

/** Cloudflare reports failures as a list of {code, message} in the envelope. */
export function describeCloudflareError(status: number, payload: Record<string, unknown>): string {
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = errors
      .map((e) => {
        const err = e as { code?: unknown; message?: unknown };
        return err.code ? `${err.code}: ${err.message}` : String(err.message ?? JSON.stringify(e));
      })
      .join('; ');
    return `Clef request failed (${status}): ${detail}`;
  }
  return `Clef request failed (${status})`;
}

/**
 * The limits Clef documents and Jev does not. Checked before spending a call so
 * an over-long question map fails locally rather than as a 400.
 */
export function assertClefRequestIsWithinLimits(request: JevRequest): void {
  const ids = Object.keys(request.questions);
  if (ids.length === 0) throw new Error('A Clef request needs at least one question');
  if (ids.length > CLEF_LIMITS.maxQuestions) {
    throw new Error(
      `Clef accepts at most ${CLEF_LIMITS.maxQuestions} questions per request, got ${ids.length}`,
    );
  }

  for (const id of ids) {
    if (id.length > CLEF_LIMITS.maxQuestionIdLength) {
      throw new Error(`Question id "${id.slice(0, 20)}..." exceeds 100 characters`);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
      throw new Error(`Question id "${id}" may only use letters, digits, underscore, dot and hyphen`);
    }
  }

  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const count = Object.keys(question.criteria).length;
      if (count < 2) throw new Error(`Choice question "${id}" needs at least 2 options, got ${count}`);
      if (count > CLEF_LIMITS.maxChoiceOptions) {
        throw new Error(
          `Choice question "${id}" has ${count} options; Clef allows at most ${CLEF_LIMITS.maxChoiceOptions}`,
        );
      }
    }
    if (question.type === 'score' && question.criteria.length < 2) {
      throw new Error(`Score question "${id}" needs at least two ordered levels`);
    }
  }
}
