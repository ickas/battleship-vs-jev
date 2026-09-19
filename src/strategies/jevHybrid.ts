import { coordToLabel } from '../engine/coords.js';
import { topCandidates } from '../engine/density.js';
import type { Rng } from '../engine/rng.js';
import type { BoardView } from '../engine/types.js';
import { describeCell, getRepresentation, type BoardRepresentation } from '../jev/representations.js';
import type { ChoiceAnswer, JevClient } from '../jev/types.js';
import {
  chooseCellFromAnswer,
  decisionMetadata,
  densityFallbackHeatmap,
  heatmapFromChoice,
} from './jevShared.js';
import type { ShotDecision, Strategy } from './types.js';
import { untriedCells } from './untried.js';

export interface JevHybridOptions {
  client: JevClient;
  /** How many code-ranked candidates to offer. Small keeps state focused. */
  topK?: number;
  representation?: BoardRepresentation | string;
  temperature?: number;
}

/**
 * Code narrows, Jev chooses.
 *
 * The density computation picks the top-K cells and describes each one semantically;
 * Jev only judges between them. This plays to the model's strengths — no
 * counting, short state, direct comparison — and is the setup most likely to
 * beat pure selection over 100 near-identical options.
 */
export class JevHybridStrategy implements Strategy {
  readonly id: string;
  readonly name: string;
  readonly usesModel = true;

  private readonly client: JevClient;
  private readonly topK: number;
  private readonly representation: BoardRepresentation;
  private readonly temperature: number;

  constructor(options: JevHybridOptions) {
    this.client = options.client;
    this.topK = options.topK ?? 8;
    this.representation =
      typeof options.representation === 'string'
        ? getRepresentation(options.representation)
        : (options.representation ?? getRepresentation('semantic'));
    this.temperature = options.temperature ?? 0;
    this.id = `jevHybrid:k${this.topK}`;
    this.name = `Jev hybrid (top ${this.topK})`;
  }

  async nextShot(view: BoardView, rng: Rng): Promise<ShotDecision> {
    const untried = untriedCells(view);
    if (untried.length === 0) throw new Error('No untried cells left to fire at');

    const ranked = topCandidates(view, this.topK);
    if (ranked.length <= 1) {
      return {
        coord: ranked[0]?.coord ?? untried[0]!,
        notes: 'only one candidate; no model call made',
      };
    }

    const offered = ranked.map((r) => r.coord);
    const criteria: Record<string, string> = {};
    for (const candidate of ranked) {
      criteria[coordToLabel(candidate.coord)] = describeCell(view, candidate.coord);
    }

    const response = await this.client.ask({
      label: 'jevHybrid.nextShot',
      // Board context only: the per-cell descriptions are already in `criteria`,
      // and repeating them would double the tokens for no added information.
      state: this.representation.describe(view, []),
      questions: {
        target: {
          type: 'choice',
          instructions:
            'Each option describes a cell that has not been fired at. Which one is most likely to contain part of a ship that is still afloat?',
          criteria,
        },
      },
    });

    const answer = response.answers.target as ChoiceAnswer;
    const { coord, fellBack } = chooseCellFromAnswer(answer, offered, view, rng, this.temperature);

    const modelHeatmap = heatmapFromChoice(answer, view);

    return {
      coord,
      heatmap: modelHeatmap ?? densityFallbackHeatmap(view),
      heatmapSource: modelHeatmap ? 'model' : 'code-density',
      ...decisionMetadata(response, 'target'),
      notes: fellBack
        ? `model returned "${answer.choice}", which was not a legal target; fell back`
        : `model chose ${coordToLabel(coord)} from ${ranked.length} code-ranked candidates`,
    };
  }
}
