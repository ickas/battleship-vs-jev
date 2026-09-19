import { coordKey, inBounds } from './coords.js';
import { isValidFleet, validateFleet } from './placement.js';
import type {
  BoardView,
  CellView,
  Coord,
  GameConfig,
  PlacedShip,
  ShotOutcome,
} from './types.js';

/**
 * A defender's board: the fleet plus the record of shots taken at it.
 * All state transitions go through `fire`, which is the single source of truth
 * for hit/miss/sunk resolution.
 */
export class Board {
  readonly config: GameConfig;
  readonly fleet: PlacedShip[];

  private readonly cellToShip = new Map<string, string>();
  private readonly hitsByShip = new Map<string, Set<string>>();
  private readonly shotCells = new Set<string>();
  private readonly shots: ShotOutcome[] = [];

  constructor(config: GameConfig, fleet: PlacedShip[]) {
    const errors = validateFleet(fleet, config);
    if (errors.length > 0) {
      throw new Error(`Invalid fleet layout: ${errors.join('; ')}`);
    }
    this.config = config;
    this.fleet = fleet;
    for (const ship of fleet) {
      this.hitsByShip.set(ship.id, new Set());
      for (const cell of ship.cells) this.cellToShip.set(coordKey(cell), ship.id);
    }
  }

  static isValidLayout(fleet: PlacedShip[], config: GameConfig): boolean {
    return isValidFleet(fleet, config);
  }

  get history(): readonly ShotOutcome[] {
    return this.shots;
  }

  get shotCount(): number {
    return this.shots.length;
  }

  hasBeenShot(coord: Coord): boolean {
    return this.shotCells.has(coordKey(coord));
  }

  isSunk(shipId: string): boolean {
    const ship = this.fleet.find((s) => s.id === shipId);
    const hits = this.hitsByShip.get(shipId);
    return ship !== undefined && hits !== undefined && hits.size === ship.length;
  }

  get sunkShipIds(): string[] {
    return this.fleet.filter((s) => this.isSunk(s.id)).map((s) => s.id);
  }

  get isFleetSunk(): boolean {
    return this.fleet.every((s) => this.isSunk(s.id));
  }

  /** Fires at a cell. Throws on out-of-bounds or repeated shots — both are strategy bugs. */
  fire(coord: Coord): ShotOutcome {
    if (!inBounds(coord, this.config)) {
      throw new Error(`Shot out of bounds: (${coord.row},${coord.col})`);
    }
    const key = coordKey(coord);
    if (this.shotCells.has(key)) {
      throw new Error(`Cell (${coord.row},${coord.col}) has already been fired at`);
    }
    this.shotCells.add(key);

    const shipId = this.cellToShip.get(key);
    let outcome: ShotOutcome;

    if (shipId === undefined) {
      outcome = { coord, result: 'miss', gameOver: this.isFleetSunk };
    } else {
      this.hitsByShip.get(shipId)!.add(key);
      const sunk = this.isSunk(shipId);
      outcome = {
        coord,
        result: sunk ? 'sunk' : 'hit',
        shipId,
        gameOver: this.isFleetSunk,
      };
    }

    this.shots.push(outcome);
    return outcome;
  }

  /**
   * The shooter's view. Cells belonging to a sunk ship are upgraded from 'hit'
   * to 'sunk', which is information a real player would also have.
   */
  view(): BoardView {
    const cells: CellView[][] = Array.from({ length: this.config.rows }, () =>
      Array.from({ length: this.config.cols }, (): CellView => 'unknown'),
    );

    for (const shot of this.shots) {
      const { row, col } = shot.coord;
      if (shot.result === 'miss') {
        cells[row]![col] = 'miss';
      } else {
        cells[row]![col] = this.isSunk(shot.shipId!) ? 'sunk' : 'hit';
      }
    }

    const sunkIds = new Set(this.sunkShipIds);
    return {
      config: this.config,
      cells,
      history: this.shots.map((s) => ({ ...s })),
      sunkShipIds: [...sunkIds],
      remainingShipLengths: this.fleet
        .filter((s) => !sunkIds.has(s.id))
        .map((s) => s.length)
        .sort((a, b) => b - a),
    };
  }
}
