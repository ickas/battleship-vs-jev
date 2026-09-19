import { coordToLabel } from '../engine/coords.js';
import type { Rng } from '../engine/rng.js';
import type { BoardView } from '../engine/types.js';
import { JEV_LIMITS } from '../jev/gateway.js';
import { getRepresentation, type BoardRepresentation } from '../jev/representations.js';
import type { JevClient, ChoiceAnswer } from '../jev/types.js';
import {
  chooseCellFromAnswer,
  decisionMetadata,
  densityFallbackHeatmap,
  heatmapFromChoice,
} from './jevShared.js';
import type { ShotDecision, Strategy } from './types.js';
import { untriedCells } from './untried.js';

export interface JevPureOptions {
  client: JevClient;
  /**
   * Board representation to put in `state`. Defaults to `cellList`, which is
   * raw board state with no interpretation - see the note on the class.
   */
  representation?: BoardRepresentation | string;
  /** 0 = always take Jev's top choice; >0 = sample from its distribution. */
  temperature?: number;
}

/**
 * Jev picks the next shot directly: one Choice over every untried cell.
 *
 * This is the honest measurement of the model as a player, and that only holds
 * if code contributes the rules and the legal move list and nothing else. So
 * the default representation is `cellList`: raw board state, no interpretation.
 *
 * Passing `semantic` here instead is supported and useful for the Phase 0
 * comparison, but it changes what the number means - that representation feeds
 * the model code-computed judgements like "continues a line of two hits", which
 * is analysis, not rules. Read such a run as a representation experiment, not
 * as a measure of the model playing unaided.
 *
 * Capped at Jev's documented 255 options per Choice, which a 10x10 board never
 * reaches.
 */
export class JevPureStrategy implements Strategy {
  readonly id: string;
  readonly name: string;
  readonly usesModel = true;

  private readonly client: JevClient;
  private readonly representation: BoardRepresentation;
  private readonly temperature: number;

  constructor(options: JevPureOptions) {
    this.client = options.client;
    this.representation =
      typeof options.representation === 'string'
        ? getRepresentation(options.representation)
        : (options.representation ?? getRepresentation('cellList'));
    this.temperature = options.temperature ?? 0;
    this.id = `jevPure:${this.representation.id}`;
    this.name = `Jev pure (${this.representation.name})`;
  }

  async nextShot(view: BoardView, rng: Rng): Promise<ShotDecision> {
    const candidates = untriedCells(view);
    if (candidates.length === 0) throw new Error('No untried cells left to fire at');
    if (candidates.length === 1) {
      return { coord: candidates[0]!, notes: 'only one cell left; no model call made' };
    }

    // A full board fits well inside the limit, but a larger config might not.
    const offered = candidates.slice(0, JEV_LIMITS.maxChoiceOptions);
    const criteria: Record<string, string> = {};
    for (const coord of offered) {
      criteria[coordToLabel(coord)] = 'A cell that has not been fired at yet.';
    }

    const response = await this.client.ask({
      label: 'jevPure.nextShot',
      state: this.representation.describe(view, offered),
      questions: {
        target: {
          type: 'choice',
          instructions:
            'Which of these cells is most likely to contain part of a ship that is still afloat? Choose exactly one cell.',
          criteria,
        },
      },
    });

    const answer = response.answers.target as ChoiceAnswer;
    const { coord, fellBack } = chooseCellFromAnswer(
      answer,
      offered,
      view,
      rng,
      this.temperature,
    );

    const modelHeatmap = heatmapFromChoice(answer, view);

    return {
      coord,
      heatmap: modelHeatmap ?? densityFallbackHeatmap(view),
      heatmapSource: modelHeatmap ? 'model' : 'code-density',
      ...decisionMetadata(response, 'target'),
      notes: fellBack
        ? `model returned "${answer.choice}", which was not a legal target; fell back`
        : `model chose ${coordToLabel(coord)} from ${offered.length} options`,
    };
  }
}
