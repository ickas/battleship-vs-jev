import { coordKey, coordToLabel } from '../engine/coords.js';
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
   * Deliberately qualitative and few: only tendencies strong enough to be worth
   * stating, each phrased as "in N of the last M games". An empty list means
   * there is no signal worth passing on, which is the honest answer early.
   */
  summarize(options: { window?: number } = {}): string[] {
    const window = options.window ?? 20;
    const recent = this.records.slice(-window);
    if (recent.length < 3) return [];

    const total = recent.length;
    const summaries: string[] = [];

    // Placement habits.
    const edgeGames = recent.filter((r) =>
      r.opponentFleet.some((ship) => ship.cells.some((c) => this.isEdge(c))),
    ).length;
    if (edgeGames >= total * 0.6) {
      summaries.push(
        `the opponent placed at least one ship against the edge of the board in ${edgeGames} of the last ${total} games`,
      );
    } else if (edgeGames <= total * 0.25) {
      summaries.push(
        `the opponent kept every ship away from the edge in ${total - edgeGames} of the last ${total} games`,
      );
    }

    const centreGames = recent.filter((r) =>
      r.opponentFleet.some((ship) => ship.cells.some((c) => this.isCentre(c))),
    ).length;
    if (centreGames >= total * 0.6) {
      summaries.push(
        `the opponent placed a ship in the middle of the board in ${centreGames} of the last ${total} games`,
      );
    }

    const horizontalGames = recent.filter(
      (r) =>
        r.opponentFleet.filter((s) => s.orientation === 'horizontal').length >
        r.opponentFleet.length / 2,
    ).length;
    if (horizontalGames >= total * 0.65) {
      summaries.push(
        `the opponent placed most ships horizontally in ${horizontalGames} of the last ${total} games`,
      );
    } else if (horizontalGames <= total * 0.35) {
      summaries.push(
        `the opponent placed most ships vertically in ${total - horizontalGames} of the last ${total} games`,
      );
    }

    // Which quadrant the opponent favours for placement.
    const favouriteQuadrant = this.favouriteQuadrant(
      recent.flatMap((r) => r.opponentFleet.flatMap((s) => s.cells)),
    );
    if (favouriteQuadrant) {
      summaries.push(`the opponent most often places ships in the ${favouriteQuadrant} of the board`);
    }

    // Firing habits: where they open, and which region they favour.
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

    const repeatedOpenings = mostCommon(openingCells.map(coordToLabel));
    if (repeatedOpenings && repeatedOpenings.count >= Math.max(3, total * 0.4)) {
      summaries.push(
        `the opponent opened at ${repeatedOpenings.value} in ${repeatedOpenings.count} of the last ${total} games`,
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

  private isCentre(coord: Coord): boolean {
    const rowMargin = this.config.rows / 4;
    const colMargin = this.config.cols / 4;
    return (
      coord.row >= rowMargin &&
      coord.row < this.config.rows - rowMargin &&
      coord.col >= colMargin &&
      coord.col < this.config.cols - colMargin
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

function mostCommon(values: string[]): { value: string; count: number } | undefined {
  if (values.length === 0) return undefined;
  const tally = new Map<string, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { value: best[0], count: best[1] };
}

export { coordKey };
