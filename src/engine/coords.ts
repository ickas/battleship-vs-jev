import type { Coord, GameConfig, Orientation } from './types.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** "A1" style label. Column letter, then 1-based row number. */
export function coordToLabel(coord: Coord): string {
  const letter = LETTERS[coord.col];
  if (letter === undefined) throw new Error(`Column ${coord.col} has no letter label`);
  return `${letter}${coord.row + 1}`;
}

export function labelToCoord(label: string): Coord {
  const match = /^([A-Z])(\d+)$/.exec(label.trim().toUpperCase());
  if (!match) throw new Error(`Malformed cell label: ${label}`);
  const col = LETTERS.indexOf(match[1]!);
  const row = Number(match[2]) - 1;
  if (col < 0 || row < 0) throw new Error(`Cell label out of range: ${label}`);
  return { row, col };
}

export function inBounds(coord: Coord, config: GameConfig): boolean {
  return coord.row >= 0 && coord.row < config.rows && coord.col >= 0 && coord.col < config.cols;
}

export function coordsEqual(a: Coord, b: Coord): boolean {
  return a.row === b.row && a.col === b.col;
}

/** Stable key for use in Set/Map. */
export function coordKey(coord: Coord): string {
  return `${coord.row},${coord.col}`;
}

/** The cells a ship would occupy. Does not check bounds or collisions. */
export function shipCells(bow: Coord, length: number, orientation: Orientation): Coord[] {
  return Array.from({ length }, (_, i) =>
    orientation === 'horizontal'
      ? { row: bow.row, col: bow.col + i }
      : { row: bow.row + i, col: bow.col },
  );
}

/** The four orthogonal neighbours of a cell that lie on the board. */
export function orthogonalNeighbours(coord: Coord, config: GameConfig): Coord[] {
  const deltas = [
    { row: -1, col: 0 },
    { row: 1, col: 0 },
    { row: 0, col: -1 },
    { row: 0, col: 1 },
  ];
  return deltas
    .map((d) => ({ row: coord.row + d.row, col: coord.col + d.col }))
    .filter((c) => inBounds(c, config));
}

/** All eight surrounding cells that lie on the board. */
export function surroundingCells(coord: Coord, config: GameConfig): Coord[] {
  const result: Coord[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const c = { row: coord.row + dr, col: coord.col + dc };
      if (inBounds(c, config)) result.push(c);
    }
  }
  return result;
}

export function allCoords(config: GameConfig): Coord[] {
  const result: Coord[] = [];
  for (let row = 0; row < config.rows; row++) {
    for (let col = 0; col < config.cols; col++) result.push({ row, col });
  }
  return result;
}
