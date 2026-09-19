import { coordToLabel } from '../engine/coords.js';
import { randomFleet } from '../engine/placement.js';
import { sampleFromWeights, type Rng } from '../engine/rng.js';
import type { GameConfig, PlacedShip } from '../engine/types.js';
import type { ChoiceAnswer, JevClient } from '../jev/types.js';
import type { OpponentHistory } from './history.js';

/**
 * Fleet placement by Choice: code generates valid candidate layouts, Jev picks
 * one. The model never produces coordinates - it only compares descriptions of
 * layouts that are already known to be legal.
 */
export interface PlaceFleetOptions {
  config: GameConfig;
  client: JevClient;
  rng: Rng;
  /** How many candidate layouts to offer. Kept small to keep state focused. */
  candidateCount?: number;
  history?: OpponentHistory;
  temperature?: number;
}

export interface PlacementResult {
  fleet: PlacedShip[];
  /** Index chosen among the candidates. */
  chosenIndex: number;
  confidence?: number;
  modelId?: string;
  usedHistory: boolean;
  notes: string;
}

export async function placeFleetWithJev(options: PlaceFleetOptions): Promise<PlacementResult> {
  const { config, client, rng, history } = options;
  const candidateCount = options.candidateCount ?? 6;
  const temperature = options.temperature ?? 0;

  const candidates = Array.from({ length: candidateCount }, () => randomFleet(config, rng));
  const summaries = history?.summarize() ?? [];
  const usedHistory = summaries.length > 0;

  const criteria: Record<string, string> = {};
  candidates.forEach((fleet, index) => {
    criteria[`layout${index + 1}`] = describeLayout(fleet, config);
  });

  const response = await client.ask({
    label: 'selfplay.placeFleet',
    state: {
      task: 'Choosing where to place a fleet so the opponent is least likely to find it.',
      boardSize: `${config.rows} rows by ${config.cols} columns`,
      shipsMayTouch: config.allowTouching,
      whatIsKnownAboutTheOpponent:
        summaries.length > 0 ? summaries : 'nothing yet; this is the first game against them',
      historyStrength: history?.signalStrength().label ?? 'no history yet',
    },
    questions: {
      layout: {
        type: 'choice',
        instructions:
          'Each option describes a legal way to place the fleet. Which layout is the opponent least likely to find quickly, given what is known about where they fire?',
        criteria,
      },
    },
  });

  const answer = response.answers.layout as ChoiceAnswer;
  const labels = Object.keys(criteria);

  let chosenIndex: number;
  if (temperature > 0 && answer.probabilities) {
    const weights = labels.map((label) => answer.probabilities![label] ?? 0);
    chosenIndex = weights.some((w) => w > 0)
      ? sampleFromWeights(weights, rng, temperature)
      : rng.int(labels.length);
  } else {
    const found = labels.indexOf(answer.choice);
    chosenIndex = found >= 0 ? found : 0;
  }

  return {
    fleet: candidates[chosenIndex]!,
    chosenIndex,
    confidence: response.confidence.layout,
    modelId: response.modelId,
    usedHistory,
    notes: `chose ${labels[chosenIndex]} of ${labels.length}${usedHistory ? ', with opponent history' : ''}`,
  };
}

/** Plain-language description of a layout. All geometry resolved here, in code. */
export function describeLayout(fleet: PlacedShip[], config: GameConfig): string {
  const parts: string[] = [];

  const edgeShips = fleet.filter((ship) =>
    ship.cells.some(
      (c) => c.row === 0 || c.col === 0 || c.row === config.rows - 1 || c.col === config.cols - 1,
    ),
  );
  parts.push(
    edgeShips.length === 0
      ? 'no ship touches the edge'
      : `${edgeShips.length} of ${fleet.length} ships touch the edge`,
  );

  const horizontal = fleet.filter((s) => s.orientation === 'horizontal').length;
  parts.push(
    horizontal === fleet.length
      ? 'every ship is horizontal'
      : horizontal === 0
        ? 'every ship is vertical'
        : `${horizontal} horizontal and ${fleet.length - horizontal} vertical`,
  );

  // Which quadrant the fleet leans towards.
  const cells = fleet.flatMap((s) => s.cells);
  const top = cells.filter((c) => c.row < config.rows / 2).length;
  const left = cells.filter((c) => c.col < config.cols / 2).length;
  const vertical = top > cells.length * 0.65 ? 'towards the top' : top < cells.length * 0.35 ? 'towards the bottom' : 'evenly spread top to bottom';
  const horizontalLean =
    left > cells.length * 0.65 ? 'towards the left' : left < cells.length * 0.35 ? 'towards the right' : 'evenly spread left to right';
  parts.push(`${vertical} and ${horizontalLean}`);

  const longest = [...fleet].sort((a, b) => b.length - a.length)[0];
  if (longest) {
    parts.push(
      `the longest ship runs ${longest.orientation}ly from ${coordToLabel(longest.bow)}`,
    );
  }

  const clustered = areShipsClustered(fleet);
  parts.push(clustered ? 'the ships are bunched close together' : 'the ships are spread apart');

  return parts.join('; ');
}

/** True when ships sit close enough together to read as a cluster. */
function areShipsClustered(fleet: PlacedShip[]): boolean {
  const centres = fleet.map((ship) => {
    const rows = ship.cells.map((c) => c.row);
    const cols = ship.cells.map((c) => c.col);
    return {
      row: rows.reduce((a, b) => a + b, 0) / rows.length,
      col: cols.reduce((a, b) => a + b, 0) / cols.length,
    };
  });

  let totalDistance = 0;
  let pairs = 0;
  for (let i = 0; i < centres.length; i++) {
    for (let j = i + 1; j < centres.length; j++) {
      const a = centres[i]!;
      const b = centres[j]!;
      totalDistance += Math.hypot(a.row - b.row, a.col - b.col);
      pairs++;
    }
  }
  return pairs > 0 && totalDistance / pairs < 4;
}
