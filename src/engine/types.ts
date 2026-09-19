/** Core domain types for the Battleship engine. Pure data, no model involvement. */

export type Orientation = 'horizontal' | 'vertical';

/** Zero-based grid coordinate. `row` 0 is the top row, `col` 0 the leftmost column. */
export interface Coord {
  row: number;
  col: number;
}

export interface ShipSpec {
  /** Stable identifier, unique within a fleet spec (e.g. "carrier"). */
  id: string;
  name: string;
  length: number;
}

/** A ship placed on a board. `cells` is derived from bow/orientation/length. */
export interface PlacedShip {
  id: string;
  name: string;
  length: number;
  /** Topmost / leftmost cell of the ship. */
  bow: Coord;
  orientation: Orientation;
  cells: Coord[];
}

export interface GameConfig {
  rows: number;
  cols: number;
  fleet: ShipSpec[];
  /** When false, ships may not occupy orthogonally or diagonally adjacent cells. */
  allowTouching: boolean;
}

export type ShotResult = 'miss' | 'hit' | 'sunk';

export interface ShotOutcome {
  coord: Coord;
  result: ShotResult;
  /** Set when `result` is 'hit' or 'sunk'. */
  shipId?: string;
  /** True when this shot sank the final remaining ship. */
  gameOver: boolean;
}

/** Cell state from the shooter's point of view. */
export type CellView = 'unknown' | 'miss' | 'hit' | 'sunk';

/**
 * Everything a strategy is allowed to see. Deliberately excludes the defender's
 * ship positions, so a strategy cannot cheat by reading the solution.
 */
export interface BoardView {
  config: GameConfig;
  /** `cells[row][col]` — indexed by row first. */
  cells: CellView[][];
  /** Shots taken so far, oldest first. */
  history: ShotOutcome[];
  /** Ids of ships already sunk. */
  sunkShipIds: string[];
  /** Lengths of ships still afloat, descending. */
  remainingShipLengths: number[];
}
