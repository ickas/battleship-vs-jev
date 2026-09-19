import { computeDensity } from '../engine/density.js';
import type { BoardView } from '../engine/types.js';
import { labelToCoord } from '../engine/coords.js';
import type { JevCallLog, JevClient, JevRequest, JevResponse } from './types.js';

/**
 * A stand-in JevClient for tests, demos and UI work without an API key.
 *
 * It is NOT a model and must never be used to produce benchmark numbers: it
 * answers Choice questions from the same code-side density the baselines use,
 * so a "Jev" strategy backed by this client is really the density baseline with
 * extra steps. Every response it returns is tagged `mock` in `modelId` so
 * results made with it are obvious in the output.
 */
export interface MockJevClientOptions {
  /** Supplies the board being hunted, so choices can be made sensibly. */
  viewProvider?: () => BoardView | undefined;
  /** Simulated per-call latency in milliseconds. */
  latencyMs?: number;
  /** Fixed confidence reported for every question. */
  confidence?: number;
}

export const MOCK_MODEL_ID = 'mock-not-a-model';

export class MockJevClient implements JevClient {
  private readonly calls: JevCallLog[] = [];
  private readonly options: MockJevClientOptions;

  readonly stats = {
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalLatencyMs: 0,
  };

  constructor(options: MockJevClientOptions = {}) {
    this.options = options;
  }

  get log(): readonly JevCallLog[] {
    return this.calls;
  }

  async ask(request: JevRequest): Promise<JevResponse> {
    const startedAt = new Date().toISOString();
    const latencyMs = this.options.latencyMs ?? 0;
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

    const view = this.options.viewProvider?.();
    const answers: JevResponse['answers'] = {};
    const confidence: Record<string, number> = {};

    for (const [id, question] of Object.entries(request.questions)) {
      confidence[id] = this.options.confidence ?? 0.5;

      if (question.type === 'choice') {
        const options = Object.keys(question.criteria);
        const weights = options.map((label) => weightForLabel(label, view));
        const total = weights.reduce((sum, w) => sum + w, 0);
        const probabilities = Object.fromEntries(
          options.map((label, i) => [label, total > 0 ? weights[i]! / total : 1 / options.length]),
        );
        let best = options[0]!;
        for (const label of options) {
          if ((probabilities[label] ?? 0) > (probabilities[best] ?? 0)) best = label;
        }
        answers[id] = { type: 'choice', choice: best, probabilities };
      } else if (question.type === 'score') {
        const middle = (question.criteria.length - 1) / 2;
        answers[id] = {
          type: 'score',
          score: middle,
          probabilities: Object.fromEntries(
            question.criteria.map((_, i) => [String(i), 1 / question.criteria.length]),
          ),
        };
      } else {
        answers[id] = { type: 'boolean', probability: 0.5 };
      }
    }

    const usage = { inputTokens: estimateChars(request.state) >> 2, outputTokens: 0 };
    const response: JevResponse = {
      answers,
      confidence,
      usage,
      modelId: MOCK_MODEL_ID,
      latencyMs,
    };

    this.calls.push({
      label: request.label ?? 'unlabelled',
      state: request.state,
      questions: request.questions,
      response,
      latencyMs,
      startedAt,
    });
    this.stats.calls++;
    this.stats.inputTokens += usage.inputTokens;
    this.stats.totalLatencyMs += latencyMs;

    return response;
  }
}

/** Density weight for a cell label, or a flat weight when the label is not a cell. */
function weightForLabel(label: string, view: BoardView | undefined): number {
  if (!view) return 1;
  try {
    const coord = labelToCoord(label);
    const { weights } = computeDensity(view);
    return (weights[coord.row]?.[coord.col] ?? 0) + 1e-9;
  } catch {
    return 1;
  }
}

function estimateChars(state: unknown): number {
  return JSON.stringify(state ?? '').length;
}
