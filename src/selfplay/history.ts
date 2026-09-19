import { coordToLabel } from '../engine/coords.js';
import type { Coord, GameConfig, PlacedShip } from '../engine/types.js';

/**
 * What one player remembers about its opponent across games.
 *
 * All counting happens here, in code. Jev never sees a count matrix: the
 * jaggedness notes are explicit that it cannot count reliably and reads numbers
 * as text. It receives only the semantic summaries produced by `summarize`,
 * e.g. "the opponent placed a ship touching an edge in 7 of the last 10 games".
 */
export interface GameRecord {
  /** Where the opponent placed their ships. */
  opponentFleet: PlacedShip[];
  /** Where the opponent fired, in order. */
  opponentShots: Coord[];
  /** True when this player won. */
  won: boolean;
  shotsTaken: number;
}

/**
 * How often each tendency appears in a purely random fleet, measured over 3,000
 * layouts. A habit is only worth telling the model about when it departs from
 * these.
 */
const BASELINE = {
  /** Mean share of a fleet with at least one cell on the board edge. */
  edgeFraction: 0.435,
  /**
   * Share of games where more than half the ships are horizontal. This is 0.5
   * by the board's own symmetry - a square board has no orientation preference
   * - so the exact value is used rather than a sampled estimate. A 3,000-sample
   * run gave 0.527, which is a ~3 sigma draw; 30,000 samples give 0.497.
   */
  horizontalMajority: 0.5,
} as const;

/** How far from the baseline a tendency must sit before it is reported. */
const MARGIN = { fraction: 0.15, rate: 0.2 } as const;

/** Below this, any apparent pattern is noise. */
const MIN_GAMES_FOR_SUMMARY = 3;

export class OpponentHistory {
  private readonly records: GameRecord[] = [];

  constructor(private readonly config: GameConfig) {}

  get gameCount(): number {
    return this.records.length;
  }

  record(entry: GameRecord): void {
    this.records.push(entry);
  }

  /** Cells the opponent has placed ships on, as raw counts. For code use only. */
  placementCounts(): number[][] {
    const counts = blankGrid(this.config);
    for (const record of this.records) {
      for (const ship of record.opponentFleet) {
        for (const cell of ship.cells) counts[cell.row]![cell.col]!++;
      }
    }
    return counts;
  }

  /** Cells the opponent has fired at, as raw counts. For code use only. */
  shotCounts(): number[][] {
    const counts = blankGrid(this.config);
    for (const record of this.records) {
      for (const shot of record.opponentShots) counts[shot.row]![shot.col]!++;
    }
    return counts;
  }

  /**
   * Plain-language summaries of the opponent's habits, for Jev's `state`.
   *
   * Only tendencies that differ from what a random layout would produce are
   * reported. The baselines below were measured over 3,000 random fleets with
   * `scripts/measure-placement-baseline.mts`; without them a statement like
   * "at least one ship touches an edge" fires for 96.5% of random opponents and
   * would be passed to the model as a finding about every single one.
   *
   * An empty list means there is no signal worth stating, which is the honest
   * answer for most opponents.
   */
  summarize(options: { window?: number } = {}): string[] {
    const window = options.window ?? 20;
    const recent = this.records.slice(-window);
    if (recent.length < MIN_GAMES_FOR_SUMMARY) return [];

    const total = recent.length;
    const summaries: string[] = [];

    // Placement: how much of the fleet hugs the edge, against a 0.438 baseline.
    const edgeFractions = recent.map((r) => {
      const onEdge = r.opponentFleet.filter((ship) => ship.cells.some((c) => this.isEdge(c)));
      return r.opponentFleet.length > 0 ? onEdge.length / r.opponentFleet.length : 0;
    });
    const meanEdgeFraction = average(edgeFractions);
    if (meanEdgeFraction >= BASELINE.edgeFraction + MARGIN.fraction) {
      summaries.push(
        `over the last ${total} games the opponent placed more of its fleet against the edges than usual`,
      );
    } else if (meanEdgeFraction <= BASELINE.edgeFraction - MARGIN.fraction) {
      summaries.push(
        `over the last ${total} games the opponent kept its fleet away from the edges more than usual`,
      );
    }

    // Orientation, against a 0.527 baseline for a horizontal majority.
    const horizontalGames = recent.filter(
      (r) =>
        r.opponentFleet.filter((s) => s.orientation === 'horizontal').length >
        r.opponentFleet.length / 2,
    ).length;
    const horizontalRate = horizontalGames / total;
    if (horizontalRate >= BASELINE.horizontalMajority + MARGIN.rate) {
      summaries.push(
        `the opponent placed most ships horizontally in ${horizontalGames} of the last ${total} games`,
      );
    } else if (horizontalRate <= BASELINE.horizontalMajority - MARGIN.rate) {
      summaries.push(
        `the opponent placed most ships vertically in ${total - horizontalGames} of the last ${total} games`,
      );
    }

    // Quadrant preferences. `favouriteQuadrant` already requires a clear lead
    // over an even split, so these are not tautologies.
    const favouriteQuadrant = this.favouriteQuadrant(
      recent.flatMap((r) => r.opponentFleet.flatMap((s) => s.cells)),
    );
    if (favouriteQuadrant) {
      summaries.push(`the opponent most often places ships in the ${favouriteQuadrant} of the board`);
    }

    const openingCells = recent
      .map((r) => r.opponentShots[0])
      .filter((c): c is Coord => c !== undefined);
    const openingQuadrant = this.favouriteQuadrant(openingCells);
    if (openingQuadrant) {
      summaries.push(`the opponent usually opens fire in the ${openingQuadrant} of the board`);
    }

    const shotQuadrant = this.favouriteQuadrant(recent.flatMap((r) => r.opponentShots.slice(0, 15)));
    if (shotQuadrant && shotQuadrant !== openingQuadrant) {
      summaries.push(`the opponent concentrates its early shots in the ${shotQuadrant} of the board`);
    }

    const repeatedOpening = mostCommon(openingCells.map(coordToLabel));
    if (repeatedOpening && repeatedOpening.count >= Math.max(3, total * 0.4)) {
      summaries.push(
        `the opponent opened at ${repeatedOpening.value} in ${repeatedOpening.count} of the last ${total} games`,
      );
    }

    return summaries;
  }

  /**
   * Per-cell placement likelihood from history, for code-side ranking of where
   * to fire. Smoothed so an unseen cell is never impossible.
   */
  placementLikelihood(): number[][] {
    const counts = this.placementCounts();
    const grid = blankGrid(this.config);
    const games = Math.max(this.records.length, 1);
    for (let row = 0; row < this.config.rows; row++) {
      for (let col = 0; col < this.config.cols; col++) {
        grid[row]![col] = (counts[row]![col]! + 1) / (games + 2);
      }
    }
    return grid;
  }

  /** Per-cell likelihood the opponent fires at a cell. Smoothed the same way. */
  shotLikelihood(): number[][] {
    const counts = this.shotCounts();
    const grid = blankGrid(this.config);
    const games = Math.max(this.records.length, 1);
    for (let row = 0; row < this.config.rows; row++) {
      for (let col = 0; col < this.config.cols; col++) {
        grid[row]![col] = (counts[row]![col]! + 1) / (games + 2);
      }
    }
    return grid;
  }

  /** How strong the signal is: few games means a weak one, and the UI should say so. */
  signalStrength(): { games: number; label: string } {
    const games = this.records.length;
    const label =
      games === 0
        ? 'no history yet'
        : games < 5
          ? 'very weak: too few games to mean anything'
          : games < 20
            ? 'weak: tendencies may be noise'
            : games < 60
              ? 'moderate'
              : 'strong';
    return { games, label };
  }

  private isEdge(coord: Coord): boolean {
    return (
      coord.row === 0 ||
      coord.col === 0 ||
      coord.row === this.config.rows - 1 ||
      coord.col === this.config.cols - 1
    );
  }

  /** Names the quadrant holding a clear majority of the given cells, if any. */
  private favouriteQuadrant(cells: Coord[]): string | undefined {
    if (cells.length < 6) return undefined;

    const midRow = this.config.rows / 2;
    const midCol = this.config.cols / 2;
    const tally = new Map<string, number>();
    for (const cell of cells) {
      const vertical = cell.row < midRow ? 'top' : 'bottom';
      const horizontal = cell.col < midCol ? 'left' : 'right';
      const name = `${vertical} ${horizontal}`;
      tally.set(name, (tally.get(name) ?? 0) + 1);
    }

    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) return undefined;
    // Only report a quadrant that is genuinely favoured, not a 25% split.
    return best[1] / cells.length >= 0.4 ? best[0] : undefined;
  }
}

function blankGrid(config: GameConfig): number[][] {
  return Array.from({ length: config.rows }, () => Array.from({ length: config.cols }, () => 0));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function mostCommon(values: string[]): { value: string; count: number } | undefined {
  if (values.length === 0) return undefined;
  const tally = new Map<string, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { value: best[0], count: best[1] };
}

