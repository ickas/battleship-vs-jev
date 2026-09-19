import { coordToLabel } from '../engine/coords.js';
import { computeDensity } from '../engine/density.js';
import type { Rng } from '../engine/rng.js';
import type { BoardView, Coord } from '../engine/types.js';
import { describeCell } from '../jev/representations.js';
import type { ChoiceAnswer, JevClient } from '../jev/types.js';
import { chooseCellFromAnswer, decisionMetadata, heatmapFromChoice } from '../strategies/jevShared.js';
import { normalizeHeatmap, type ShotDecision, type Strategy } from '../strategies/types.js';
import { untriedCells } from '../strategies/untried.js';
import type { OpponentHistory } from './history.js';

/**
 * The Phase 2 firing strategy: density ranking multiplied by where this
 * opponent has historically placed ships, with Jev choosing among the top
 * candidates and the opponent's habits described to it in words.
 *
 * History enters twice, which is what makes its effect measurable:
 *   - in code, as a prior that reorders the candidate list
 *   - in state, as semantic summaries Jev can weigh against the board itself
 *
 * With `useHistory` false it degenerates to the plain hybrid strategy, which is
 * the control condition for the history on/off comparison.
 */
export interface HistoryAwareOptions {
  client: JevClient;
  history: OpponentHistory;
  useHistory: boolean;
  topK?: number;
  temperature?: number;
  /** Weight of the historical prior relative to pure density. 0 disables it. */
  historyWeight?: number;
}

export class HistoryAwareStrategy implements Strategy {
  readonly id: string;
  readonly name: string;
  readonly usesModel = true;

  private readonly client: JevClient;
  private readonly history: OpponentHistory;
  private readonly useHistory: boolean;
  private readonly topK: number;
  private readonly temperature: number;
  private readonly historyWeight: number;

  /**
   * Whether the most recent shot had any history signal to work with. Firing
   * and placement can differ: placement may have summaries while firing does
   * not, so the two are reported separately.
   */
  lastShotUsedHistory = false;

  constructor(options: HistoryAwareOptions) {
    this.client = options.client;
    this.history = options.history;
    this.useHistory = options.useHistory;
    this.topK = options.topK ?? 8;
    this.temperature = options.temperature ?? 0.7;
    this.historyWeight = options.historyWeight ?? 1;
    this.id = options.useHistory ? 'jevHistory' : 'jevNoHistory';
    this.name = options.useHistory ? 'Jev with history' : 'Jev without history';
  }

  /** Candidate ranking: density, optionally multiplied by the historical prior. */
  rankCandidates(view: BoardView): Array<{ coord: Coord; weight: number }> {
    const { weights } = computeDensity(view);
    const prior =
      this.useHistory && this.history.gameCount >= 3
        ? this.history.placementLikelihood()
        : undefined;

    const ranked: Array<{ coord: Coord; weight: number }> = [];
    for (const coord of untriedCells(view)) {
      const base = weights[coord.row]![coord.col]!;
      const multiplier = prior
        ? Math.pow(prior[coord.row]![coord.col]!, this.historyWeight)
        : 1;
      ranked.push({ coord, weight: base * multiplier });
    }

    ranked.sort(
      (a, b) => b.weight - a.weight || a.coord.row - b.coord.row || a.coord.col - b.coord.col,
    );
    return ranked;
  }

  async nextShot(view: BoardView, rng: Rng): Promise<ShotDecision> {
    const ranked = this.rankCandidates(view);
    if (ranked.length === 0) throw new Error('No untried cells left to fire at');
    if (ranked.length === 1) {
      return { coord: ranked[0]!.coord, notes: 'only one cell left; no model call made' };
    }

    const offered = ranked.slice(0, this.topK);
    const criteria: Record<string, string> = {};
    for (const candidate of offered) {
      criteria[coordToLabel(candidate.coord)] = describeCell(view, candidate.coord);
    }

    const summaries = this.useHistory ? this.history.summarize() : [];
    this.lastShotUsedHistory =
      summaries.length > 0 || (this.useHistory && this.history.gameCount >= 3);
    const response = await this.client.ask({
      label: this.useHistory ? 'selfplay.shot.withHistory' : 'selfplay.shot.noHistory',
      state: {
        shipsStillAfloat: view.remainingShipLengths.map((l) => `a ship ${l} cells long`),
        shotsTaken: view.history.length,
        opponentHabits:
          summaries.length > 0 ? summaries : 'nothing known about this opponent yet',
        historyStrength: this.useHistory ? this.history.signalStrength().label : 'history disabled',
      },
      questions: {
        target: {
          type: 'choice',
          instructions:
            'Each option describes a cell that has not been fired at. Which is most likely to contain part of a ship that is still afloat?',
          criteria,
        },
      },
    });

    const answer = response.answers.target as ChoiceAnswer;
    const coords = offered.map((c) => c.coord);
    const { coord, fellBack } = chooseCellFromAnswer(answer, coords, view, rng, this.temperature);

    // Show the history-weighted code ranking when the model returned no distribution.
    const modelHeatmap = heatmapFromChoice(answer, view);
    const fallbackHeatmap = normalizeHeatmap(
      view.cells.map((row, r) =>
        row.map((_, c) => ranked.find((x) => x.coord.row === r && x.coord.col === c)?.weight ?? 0),
      ),
    );

    return {
      coord,
      heatmap: modelHeatmap ?? fallbackHeatmap,
      heatmapSource: modelHeatmap ? 'model' : 'code-density',
      ...decisionMetadata(response, 'target'),
      notes: fellBack
        ? `model returned "${answer.choice}", not a legal target; fell back`
        : `chose ${coordToLabel(coord)} from ${offered.length} candidates${
            summaries.length > 0 ? `, using ${summaries.length} history signal(s)` : ''
          }`,
    };
  }
}
