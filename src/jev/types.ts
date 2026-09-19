/**
 * The only interface through which the rest of the app talks to Jev.
 * Mirrors the AI SDK's evaluation shape (`boolean` | `choice` | `score`), which
 * is what the Gateway exposes. TypeSafe's own docs call `boolean` a "Noul".
 */

export interface BooleanQuestion {
  type: 'boolean';
  instructions: string;
  /** Optional definitions of what the true and false cases mean. */
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option name → description. Jev allows at most 255 options per Choice. */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** At least two ordered labels, lowest first. */
  criteria: string[];
}

export type JevQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;

export interface BooleanAnswer {
  type: 'boolean';
  probability: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  /**
   * Per-option distribution. Optional in the AI SDK's own types, so callers
   * must cope with it being absent rather than assume a heatmap is available.
   */
  probabilities?: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities?: Record<string, number>;
}

export type JevAnswer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevRequest {
  /** Shared state all questions are asked against. String, object or array. */
  state: unknown;
  /** Questions are evaluated in parallel and independently of each other. */
  questions: Record<string, JevQuestion>;
  /** Tag recorded in the call log, so logs can be traced back to a game phase. */
  label?: string;
  abortSignal?: AbortSignal;
}

export interface JevUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface JevResponse {
  answers: Record<string, JevAnswer>;
  /** Per-question confidence, where the provider reported one. */
  confidence: Record<string, number>;
  usage: JevUsage;
  /**
   * The model version that actually answered. Results are only comparable
   * within one version, so every benchmark record carries it.
   */
  modelId: string;
  /** End-to-end latency measured by the client, including Gateway overhead. */
  latencyMs: number;
  warnings?: string[];
  /** Decimal precision the provider rounded to, when reported. */
  rounding?: { probabilityDecimals?: number; scoreDecimals?: number };
}

/** A complete record of one call, for the metrics panel and the bench logs. */
export interface JevCallLog {
  label: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  response?: JevResponse;
  error?: string;
  latencyMs: number;
  startedAt: string;
}

export interface JevClient {
  /** Sends one request. Multiple questions in one call are answered in parallel. */
  ask(request: JevRequest): Promise<JevResponse>;
  /** Every call made so far, oldest first. */
  readonly log: readonly JevCallLog[];
  readonly stats: {
    calls: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    totalLatencyMs: number;
  };
}
