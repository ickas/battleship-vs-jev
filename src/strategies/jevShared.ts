import { coordToLabel, labelToCoord } from '../engine/coords.js';
import { sampleFromWeights, type Rng } from '../engine/rng.js';
import type { BoardView, Coord } from '../engine/types.js';
import type { ChoiceAnswer, JevResponse } from '../jev/types.js';
import { computeDensity } from '../engine/density.js';
import { emptyHeatmap, normalizeHeatmap, type Heatmap } from './types.js';

/**
 * Turns Jev's per-option probabilities into a board heatmap. Options are cell
 * labels, so this is a direct mapping; cells that were not offered stay at 0.
 * Returns undefined when the provider reported no distribution at all, since
 * `probabilities` is optional in the AI SDK's types.
 */
export function heatmapFromChoice(
  answer: ChoiceAnswer,
  view: BoardView,
): Heatmap | undefined {
  if (!answer.probabilities) return undefined;

  const heatmap = emptyHeatmap(view.config);
  let sawAny = false;
  for (const [label, probability] of Object.entries(answer.probabilities)) {
    try {
      const { row, col } = labelToCoord(label);
      if (row < view.config.rows && col < view.config.cols) {
        heatmap[row]![col] = probability;
        sawAny = true;
      }
    } catch {
      // Not a cell label — ignore it rather than failing the shot.
    }
  }
  return sawAny ? heatmap : undefined;
}

/**
 * Picks a cell from a Choice answer.
 *
 * Jev's outputs are very consistent, so at temperature 0 two instances given
 * the same state play identical games. Sampling from the returned distribution
 * (temperature > 0) is what makes self-play produce varied games.
 *
 * Whatever comes back is validated against the legal candidate list: an
 * unexpected or already-fired label falls back to the best legal option rather
 * than crashing the game.
 */
export function chooseCellFromAnswer(
  answer: ChoiceAnswer,
  candidates: Coord[],
  view: BoardView,
  rng: Rng,
  temperature: number,
): { coord: Coord; fellBack: boolean } {
  const legal = new Map(candidates.map((c) => [coordToLabel(c), c]));

  if (temperature > 0 && answer.probabilities) {
    const labels = [...legal.keys()];
    const weights = labels.map((label) => answer.probabilities![label] ?? 0);
    if (weights.some((w) => w > 0)) {
      const index = sampleFromWeights(weights, rng, temperature);
      return { coord: legal.get(labels[index]!)!, fellBack: false };
    }
  }

  const picked = legal.get(answer.choice);
  if (picked && view.cells[picked.row]![picked.col] === 'unknown') {
    return { coord: picked, fellBack: false };
  }

  // The model returned something unusable. Take the highest-probability legal
  // cell if there is a distribution, otherwise the first legal candidate.
  if (answer.probabilities) {
    let best: Coord | undefined;
    let bestProbability = -1;
    for (const [label, coord] of legal) {
      const probability = answer.probabilities[label] ?? 0;
      if (probability > bestProbability) {
        bestProbability = probability;
        best = coord;
      }
    }
    if (best) return { coord: best, fellBack: true };
  }
  return { coord: candidates[0]!, fellBack: true };
}

/**
 * Heatmap to show when the model returned no distribution at all.
 *
 * `probabilities` is optional in the AI SDK's types and is genuinely absent in
 * some responses, so the UI would otherwise render nothing. This falls back to
 * the code-side density, which is clearly labelled as such by the caller.
 */
export function densityFallbackHeatmap(view: BoardView): Heatmap {
  return normalizeHeatmap(computeDensity(view).weights);
}

/**
 * Pulls everything a ShotDecision records about the call: usage, confidence,
 * the model id, and the Gateway's own bookkeeping. `generationId` is the only
 * reliable way to tie a benchmark row back to a call in the Gateway logs, so it
 * has to survive all the way into the result files.
 */
export function decisionMetadata(response: JevResponse, questionId: string) {
  return {
    usage: { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
    confidence: response.confidence[questionId],
    modelId: response.modelId,
    generationId: response.generationId,
    // Prefer a cost the transport reported; fall back to the published rate.
    marketCostUsd: response.marketCostUsd ?? response.estimatedCostUsd,
    costIsEstimated: response.marketCostUsd === undefined,
    attempts: response.attempts,
    retryWaitMs: response.retryWaitMs,
  };
}
