import { coordToLabel, orthogonalNeighbours } from '../engine/coords.js';
import type { BoardView, Coord } from '../engine/types.js';
import { unresolvedHits, untriedCells } from '../strategies/untried.js';

/**
 * Phase 0: how to describe the board to Jev.
 *
 * The jaggedness notes drive the design of these: Jev reads numbers as text,
 * cannot count reliably, loses accuracy when state carries irrelevant detail,
 * and does better with semantic descriptions than numeric ones. Each
 * representation trades verbosity against how much is pre-digested in code.
 * Which one actually wins is an empirical question — see `bench/representation.ts`
 * and `docs/representation.md`.
 */
export interface BoardRepresentation {
  id: string;
  name: string;
  /** One-line summary for the docs table. */
  description: string;
  /** Builds the `state` payload sent to Jev for a shot decision. */
  describe(view: BoardView, candidates: Coord[]): unknown;
}

/** Shared framing: the rules and what is left afloat. Kept short and literal. */
function fleetSummary(view: BoardView) {
  const afloat = view.remainingShipLengths;
  return {
    boardSize: `${view.config.rows} rows by ${view.config.cols} columns, labelled A1 (top-left) to ${coordToLabel(
      { row: view.config.rows - 1, col: view.config.cols - 1 },
    )}`,
    shipsStillAfloat: afloat.map((length) => `a ship ${length} cells long`),
    shipsAlreadySunk: view.sunkShipIds.length,
    shipsMayTouch: view.config.allowTouching,
  };
}

/**
 * A. Per-cell labelled list. The most literal representation: every cell and
 * its state, with no interpretation. Verbose, and the model has to do the work
 * of relating cells to each other.
 */
export const cellListRepresentation: BoardRepresentation = {
  id: 'cellList',
  name: 'Per-cell list',
  description: 'Every cell listed with its state. Literal, verbose, no interpretation.',
  describe(view) {
    const cells: Record<string, string> = {};
    for (let row = 0; row < view.config.rows; row++) {
      for (let col = 0; col < view.config.cols; col++) {
        const state = view.cells[row]![col]!;
        cells[coordToLabel({ row, col })] =
          state === 'unknown'
            ? 'not yet fired at'
            : state === 'miss'
              ? 'fired at, empty water'
              : state === 'hit'
                ? 'fired at, hit a ship that is still afloat'
                : 'fired at, hit a ship that has since been sunk';
      }
    }
    return { ...fleetSummary(view), cells };
  },
};

/**
 * B. Row strings. Compact grid rendering, one string per row, with a legend.
 * Far fewer tokens than the per-cell list, but asks the model to locate a cell
 * by counting along a string — which the jaggedness notes warn against.
 */
export const rowStringsRepresentation: BoardRepresentation = {
  id: 'rowStrings',
  name: 'Row strings',
  description: 'Compact grid, one string per row, with a legend. Fewest tokens.',
  describe(view) {
    const symbols: Record<string, string> = {
      unknown: '.',
      miss: 'o',
      hit: 'X',
      sunk: '#',
    };
    const header = Array.from({ length: view.config.cols }, (_, col) =>
      coordToLabel({ row: 0, col }).replace(/\d+$/, ''),
    ).join(' ');

    const rows = view.cells.map(
      (row, index) => `row ${index + 1}: ${row.map((c) => symbols[c]!).join(' ')}`,
    );

    return {
      ...fleetSummary(view),
      legend: {
        '.': 'not yet fired at',
        o: 'fired at, empty water',
        X: 'hit a ship that is still afloat',
        '#': 'part of a ship that has been sunk',
      },
      columns: header,
      grid: rows,
    };
  },
};

/**
 * C. Semantic candidate descriptions. Code does the geometry and hands Jev a
 * short, plain-language description of each cell it may choose: whether it
 * continues a line of hits, touches a live hit, how much open water surrounds
 * it, and whether a ship of each remaining length could still fit there.
 *
 * This is the representation the jaggedness notes point towards — no counting,
 * no grid arithmetic, only judgment over described options.
 */
export const semanticRepresentation: BoardRepresentation = {
  id: 'semantic',
  name: 'Semantic candidates',
  description:
    'Code describes each candidate cell in words (extends a hit line, touches a hit, open space).',
  describe(view, candidates) {
    const live = unresolvedHits(view);
    const liveLabels = live.map(coordToLabel);

    const descriptions: Record<string, string> = {};
    for (const coord of candidates) {
      descriptions[coordToLabel(coord)] = describeCell(view, coord);
    }

    return {
      ...fleetSummary(view),
      shotsTaken: view.history.length,
      cellsHitButNotYetSunk: liveLabels.length > 0 ? liveLabels : 'none',
      candidates: descriptions,
    };
  },
};

/** Plain-language description of one candidate cell. All geometry done here, in code. */
export function describeCell(view: BoardView, coord: Coord): string {
  const parts: string[] = [];
  const { config } = view;

  const at = (row: number, col: number) =>
    row >= 0 && row < config.rows && col >= 0 && col < config.cols
      ? view.cells[row]![col]!
      : 'off-board';

  // Does firing here extend a run of live hits?
  const runs: string[] = [];
  const directions: Array<[string, number, number]> = [
    ['left', 0, -1],
    ['right', 0, 1],
    ['above', -1, 0],
    ['below', 1, 0],
  ];
  for (const [name, dr, dc] of directions) {
    let length = 0;
    let r = coord.row + dr;
    let c = coord.col + dc;
    while (at(r, c) === 'hit') {
      length++;
      r += dr;
      c += dc;
    }
    if (length > 0) runs.push(`${length} hit${length === 1 ? '' : 's'} in a row ${name}`);
  }
  if (runs.length > 0) {
    parts.push(`directly continues ${runs.join(' and ')}`);
  } else {
    const touching = orthogonalNeighbours(coord, config).filter(
      (n) => view.cells[n.row]![n.col] === 'hit',
    );
    if (touching.length > 0) parts.push('touches a hit that is not yet sunk');
  }

  // How much room is there? Reported in words, not as a bare number.
  const openRun = longestOpenRun(view, coord);
  const longestAfloat = Math.max(...view.remainingShipLengths, 0);
  if (openRun >= longestAfloat && longestAfloat > 0) {
    parts.push('has room for the longest ship still afloat');
  } else {
    parts.push(`sits in a gap too small for ships longer than ${openRun} cells`);
  }

  const neighbours = orthogonalNeighbours(coord, config);
  const misses = neighbours.filter((n) => view.cells[n.row]![n.col] === 'miss').length;
  if (misses === neighbours.length) parts.push('is surrounded entirely by empty water');
  else if (misses > 0) parts.push('borders empty water');
  else if (neighbours.every((n) => view.cells[n.row]![n.col] === 'unknown')) {
    parts.push('is in completely unexplored space');
  }

  const edge =
    coord.row === 0 || coord.col === 0 || coord.row === config.rows - 1 || coord.col === config.cols - 1;
  parts.push(edge ? 'is on the edge of the board' : 'is in the open middle of the board');

  return parts.join('; ');
}

/**
 * Longest straight line of cells through `coord` that could still hold a ship,
 * counting cells that are unknown or live hits in both directions.
 */
export function longestOpenRun(view: BoardView, coord: Coord): number {
  const { config } = view;
  const passable = (row: number, col: number) => {
    if (row < 0 || row >= config.rows || col < 0 || col >= config.cols) return false;
    const state = view.cells[row]![col]!;
    return state === 'unknown' || state === 'hit';
  };

  let best = 0;
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
  ] as const) {
    let length = 1;
    let r = coord.row + dr;
    let c = coord.col + dc;
    while (passable(r, c)) {
      length++;
      r += dr;
      c += dc;
    }
    r = coord.row - dr;
    c = coord.col - dc;
    while (passable(r, c)) {
      length++;
      r -= dr;
      c -= dc;
    }
    if (length > best) best = length;
  }
  return best;
}

export const REPRESENTATIONS: BoardRepresentation[] = [
  cellListRepresentation,
  rowStringsRepresentation,
  semanticRepresentation,
];

export function getRepresentation(id: string): BoardRepresentation {
  const found = REPRESENTATIONS.find((r) => r.id === id);
  if (!found) {
    throw new Error(`Unknown representation "${id}". Known: ${REPRESENTATIONS.map((r) => r.id).join(', ')}`);
  }
  return found;
}

/** Re-exported for the strategies, which need the legal target list. */
export { untriedCells };
