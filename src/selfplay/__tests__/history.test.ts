import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/config.js';
import { toPlacedShip } from '../../engine/placement.js';
import type { Coord, PlacedShip } from '../../engine/types.js';
import { OpponentHistory } from '../history.js';

const config = makeConfig();

/** All ships hugging the top-left corner, all horizontal. */
function cornerFleet(): PlacedShip[] {
  return [
    toPlacedShip(config.fleet[0]!, { row: 0, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[1]!, { row: 1, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[2]!, { row: 2, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[3]!, { row: 3, col: 0 }, 'horizontal'),
    toPlacedShip(config.fleet[4]!, { row: 4, col: 0 }, 'horizontal'),
  ];
}

/** All ships vertical, away from every edge. */
function centreFleet(): PlacedShip[] {
  return [
    toPlacedShip(config.fleet[0]!, { row: 2, col: 2 }, 'vertical'),
    toPlacedShip(config.fleet[1]!, { row: 2, col: 4 }, 'vertical'),
    toPlacedShip(config.fleet[2]!, { row: 2, col: 6 }, 'vertical'),
    toPlacedShip(config.fleet[3]!, { row: 6, col: 4 }, 'vertical'),
    toPlacedShip(config.fleet[4]!, { row: 6, col: 6 }, 'vertical'),
  ];
}

function shotsAt(coords: Coord[]): Coord[] {
  return coords;
}

describe('OpponentHistory', () => {
  it('starts with no games and no summaries', () => {
    const history = new OpponentHistory(config);
    expect(history.gameCount).toBe(0);
    expect(history.summarize()).toEqual([]);
    expect(history.signalStrength().label).toBe('no history yet');
  });

  it('stays silent until there are enough games to mean anything', () => {
    const history = new OpponentHistory(config);
    history.record({ opponentFleet: cornerFleet(), opponentShots: [], won: false, shotsTaken: 0 });
    history.record({ opponentFleet: cornerFleet(), opponentShots: [], won: false, shotsTaken: 0 });
    expect(history.summarize()).toEqual([]);
    expect(history.signalStrength().label).toMatch(/very weak/);
  });

  it('notices a consistent edge-hugging, horizontal opponent', () => {
    const history = new OpponentHistory(config);
    for (let i = 0; i < 10; i++) {
      history.record({
        opponentFleet: cornerFleet(),
        opponentShots: [],
        won: false,
        shotsTaken: 0,
      });
    }

    const summaries = history.summarize().join(' | ');
    expect(summaries).toMatch(/against the edge/);
    expect(summaries).toMatch(/horizontally/);
    expect(summaries).toMatch(/top left/);
  });

  it('notices an opponent that avoids the edge and plays vertically', () => {
    const history = new OpponentHistory(config);
    for (let i = 0; i < 10; i++) {
      history.record({
        opponentFleet: centreFleet(),
        opponentShots: [],
        won: false,
        shotsTaken: 0,
      });
    }

    const summaries = history.summarize().join(' | ');
    expect(summaries).toMatch(/away from the edge/);
    expect(summaries).toMatch(/vertically/);
  });

  it('notices a repeated opening shot', () => {
    const history = new OpponentHistory(config);
    for (let i = 0; i < 8; i++) {
      history.record({
        opponentFleet: centreFleet(),
        opponentShots: shotsAt([{ row: 4, col: 4 }, { row: 5, col: 5 }]),
        won: false,
        shotsTaken: 2,
      });
    }
    expect(history.summarize().join(' | ')).toMatch(/opened at E5 in 8 of the last 8 games/);
  });

  it('never states a number Jev has to count', () => {
    const history = new OpponentHistory(config);
    for (let i = 0; i < 10; i++) {
      history.record({ opponentFleet: cornerFleet(), opponentShots: [], won: false, shotsTaken: 0 });
    }
    // Summaries are sentences, not matrices.
    for (const summary of history.summarize()) {
      expect(summary).toMatch(/^[a-z]/);
      expect(summary).not.toMatch(/[[\]{}]/);
    }
  });

  it('builds a smoothed placement prior that favours seen cells', () => {
    const history = new OpponentHistory(config);
    for (let i = 0; i < 5; i++) {
      history.record({ opponentFleet: cornerFleet(), opponentShots: [], won: false, shotsTaken: 0 });
    }

    const prior = history.placementLikelihood();
    expect(prior[0]![0]!).toBeGreaterThan(prior[9]![9]!);
    // Smoothing keeps unseen cells possible.
    expect(prior[9]![9]!).toBeGreaterThan(0);
  });

  it('builds a shot prior from where the opponent fired', () => {
    const history = new OpponentHistory(config);
    for (let i = 0; i < 5; i++) {
      history.record({
        opponentFleet: centreFleet(),
        opponentShots: shotsAt([{ row: 0, col: 0 }]),
        won: false,
        shotsTaken: 1,
      });
    }
    const prior = history.shotLikelihood();
    expect(prior[0]![0]!).toBeGreaterThan(prior[5]![5]!);
  });

  it('reports increasing signal strength as games accumulate', () => {
    const history = new OpponentHistory(config);
    const labels: string[] = [];
    for (let i = 0; i < 70; i++) {
      history.record({ opponentFleet: cornerFleet(), opponentShots: [], won: false, shotsTaken: 0 });
      if ([4, 19, 59, 69].includes(i)) labels.push(history.signalStrength().label);
    }
    expect(labels[0]).toMatch(/weak/);
    expect(labels.at(-1)).toMatch(/strong/);
  });

  it('only considers the most recent window of games', () => {
    const history = new OpponentHistory(config);
    for (let i = 0; i < 30; i++) {
      history.record({ opponentFleet: cornerFleet(), opponentShots: [], won: false, shotsTaken: 0 });
    }
    for (let i = 0; i < 20; i++) {
      history.record({ opponentFleet: centreFleet(), opponentShots: [], won: false, shotsTaken: 0 });
    }
    // The recent window is all centre fleets, so the edge habit should be gone.
    expect(history.summarize({ window: 20 }).join(' | ')).toMatch(/away from the edge/);
  });
});
