import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/config.js';
import { makeRng } from '../../engine/rng.js';
import { MockJevClient } from '../../jev/mock.js';
import { OpponentHistory } from '../history.js';
import { HistoryAwareStrategy } from '../historyStrategy.js';
import { playMatch, type PlayerConfig } from '../match.js';
import { describeLayout, placeFleetWithJev } from '../placement.js';
import { randomFleet, validateFleet, toPlacedShip } from '../../engine/placement.js';
import { CONTROL_PLAYER, HISTORY_PLAYER, historyEffect, runSelfPlay } from '../runner.js';
import { Board } from '../../engine/board.js';
import { untriedCells } from '../../strategies/untried.js';
import type { PlacedShip } from '../../engine/types.js';

const config = makeConfig();

function makePlayer(id: string, useHistory: boolean, history: OpponentHistory): PlayerConfig {
  const client = new MockJevClient();
  return {
    id,
    useHistory,
    jevPlacement: true,
    client,
    strategy: new HistoryAwareStrategy({ client, history, useHistory, topK: 6, temperature: 0.7 }),
  };
}

describe('placeFleetWithJev', () => {
  it('always returns a layout that passes validation', async () => {
    for (let seed = 0; seed < 8; seed++) {
      const result = await placeFleetWithJev({
        config,
        client: new MockJevClient(),
        rng: makeRng(seed),
      });
      expect(validateFleet(result.fleet, config)).toEqual([]);
    }
  });

  it('reports when history was actually used', async () => {
    const history = new OpponentHistory(config);
    const cold = await placeFleetWithJev({
      config,
      client: new MockJevClient(),
      rng: makeRng(1),
      history,
    });
    expect(cold.usedHistory).toBe(false);

    for (let i = 0; i < 10; i++) {
      history.record({
        opponentFleet: [
          toPlacedShip(config.fleet[0]!, { row: 0, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[1]!, { row: 1, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[2]!, { row: 2, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[3]!, { row: 3, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[4]!, { row: 4, col: 0 }, 'horizontal'),
        ],
        opponentShots: [],
        won: false,
        shotsTaken: 0,
      });
    }

    const warm = await placeFleetWithJev({
      config,
      client: new MockJevClient(),
      rng: makeRng(1),
      history,
    });
    expect(warm.usedHistory).toBe(true);
  });
});

describe('describeLayout', () => {
  it('describes layouts in words, with no coordinates beyond the bow', () => {
    const fleet: PlacedShip[] = randomFleet(config, makeRng(3));
    const description = describeLayout(fleet, config);
    expect(description).toMatch(/ships|ship/);
    expect(description).toMatch(/horizontal|vertical/);
    expect(description).toMatch(/spread|bunched/);
  });

  it('distinguishes an all-horizontal edge layout from a spread one', () => {
    const edge: PlacedShip[] = [
      toPlacedShip(config.fleet[0]!, { row: 0, col: 0 }, 'horizontal'),
      toPlacedShip(config.fleet[1]!, { row: 1, col: 0 }, 'horizontal'),
      toPlacedShip(config.fleet[2]!, { row: 2, col: 0 }, 'horizontal'),
      toPlacedShip(config.fleet[3]!, { row: 3, col: 0 }, 'horizontal'),
      toPlacedShip(config.fleet[4]!, { row: 4, col: 0 }, 'horizontal'),
    ];
    const description = describeLayout(edge, config);
    expect(description).toMatch(/every ship is horizontal/);
    expect(description).toMatch(/ships touch the edge/);
  });
});

describe('HistoryAwareStrategy', () => {
  it('reorders candidates once history has accumulated', async () => {
    const history = new OpponentHistory(config);
    const client = new MockJevClient();
    const view = new Board(config, randomFleet(config, makeRng(4))).view();

    const cold = new HistoryAwareStrategy({ client, history, useHistory: true });
    const before = cold.rankCandidates(view)[0]!.coord;

    // Teach it that this opponent always hides in the top-left corner.
    for (let i = 0; i < 12; i++) {
      history.record({
        opponentFleet: [
          toPlacedShip(config.fleet[0]!, { row: 0, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[1]!, { row: 1, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[2]!, { row: 2, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[3]!, { row: 3, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[4]!, { row: 4, col: 0 }, 'horizontal'),
        ],
        opponentShots: [],
        won: false,
        shotsTaken: 0,
      });
    }

    const warm = new HistoryAwareStrategy({ client, history, useHistory: true });
    const after = warm.rankCandidates(view)[0]!.coord;

    // The history prior must actually move the top candidate towards the corner.
    expect(after).not.toEqual(before);
    expect(after.row + after.col).toBeLessThan(before.row + before.col);
  });

  it('ignores history entirely when useHistory is false', async () => {
    const history = new OpponentHistory(config);
    const client = new MockJevClient();
    const view = new Board(config, randomFleet(config, makeRng(4))).view();

    const before = new HistoryAwareStrategy({ client, history, useHistory: false }).rankCandidates(view);
    for (let i = 0; i < 12; i++) {
      history.record({
        opponentFleet: [
          toPlacedShip(config.fleet[0]!, { row: 0, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[1]!, { row: 1, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[2]!, { row: 2, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[3]!, { row: 3, col: 0 }, 'horizontal'),
          toPlacedShip(config.fleet[4]!, { row: 4, col: 0 }, 'horizontal'),
        ],
        opponentShots: [],
        won: false,
        shotsTaken: 0,
      });
    }
    const after = new HistoryAwareStrategy({ client, history, useHistory: false }).rankCandidates(view);
    expect(after[0]!.coord).toEqual(before[0]!.coord);
  });

  it('only ever fires at untried cells', async () => {
    const history = new OpponentHistory(config);
    const client = new MockJevClient();
    const strategy = new HistoryAwareStrategy({ client, history, useHistory: true });
    const board = new Board(config, randomFleet(config, makeRng(6)));

    for (let i = 0; i < 12; i++) {
      const decision = await strategy.nextShot(board.view(), makeRng(i));
      expect(untriedCells(board.view())).toContainEqual(decision.coord);
      board.fire(decision.coord);
    }
  });
});

describe('playMatch', () => {
  it('produces a winner and records history for both players', async () => {
    const histories = {
      [HISTORY_PLAYER]: new OpponentHistory(config),
      [CONTROL_PLAYER]: new OpponentHistory(config),
    };
    const players: [PlayerConfig, PlayerConfig] = [
      makePlayer(HISTORY_PLAYER, true, histories[HISTORY_PLAYER]!),
      makePlayer(CONTROL_PLAYER, false, histories[CONTROL_PLAYER]!),
    ];

    const result = await playMatch({ config, players, histories, rng: makeRng(1) });

    expect([HISTORY_PLAYER, CONTROL_PLAYER, undefined]).toContain(result.winnerId);
    expect(result.turns).toBeGreaterThan(0);
    expect(histories[HISTORY_PLAYER]!.gameCount).toBe(1);
    expect(histories[CONTROL_PLAYER]!.gameCount).toBe(1);
    // Each player's history holds the other player's fleet.
    expect(validateFleet(result.fleets[HISTORY_PLAYER]!, config)).toEqual([]);
    expect(validateFleet(result.fleets[CONTROL_PLAYER]!, config)).toEqual([]);
  }, 30_000);
});

describe('runSelfPlay', () => {
  it('runs a batch unattended and reports both sides', async () => {
    const report = await runSelfPlay({
      config,
      client: new MockJevClient(),
      games: 4,
      seed: 2,
      topK: 6,
    });

    expect(report.completed).toBe(4);
    expect(report.winsWithHistory + report.winsWithoutHistory + report.draws).toBe(4);
    expect(report.perGame).toHaveLength(4);
    expect(report.meanShotsWithHistory).toBeGreaterThan(0);
  }, 120_000);
});

describe('contaminated games', () => {
  it('excludes a game where a shot failed from the verdict', async () => {
    // A client that always fails forces a random-shot substitution, which is
    // not a clean measurement of either strategy.
    const failing = {
      log: [],
      stats: { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0 },
      ask: async () => {
        throw new Error('rate limited');
      },
    };

    const report = await runSelfPlay({
      config,
      client: failing,
      games: 2,
      seed: 1,
      jevPlacement: false,
    });

    expect(report.completed).toBe(2);
    expect(report.contaminatedGames).toBe(2);
    // Nothing contaminated reaches the win tally.
    expect(report.winsWithHistory + report.winsWithoutHistory + report.draws).toBe(0);
  }, 60_000);

  it('mentions excluded games in the verdict', () => {
    const effect = historyEffect({
      winsWithHistory: 3,
      winsWithoutHistory: 2,
      historyWinRate: 0.6,
      contaminatedGames: 7,
    } as never);
    expect(effect.verdict).toMatch(/7 contaminated game\(s\) excluded/);
  });
});

describe('historyEffect', () => {
  it('refuses to claim an effect from too few games', () => {
    const effect = historyEffect({
      winsWithHistory: 4,
      winsWithoutHistory: 1,
      historyWinRate: 0.8,
    } as never);
    expect(effect.significant).toBe(false);
    expect(effect.verdict).toMatch(/far too few/);
  });

  it('calls a coin-flip result no measurable effect', () => {
    const effect = historyEffect({
      winsWithHistory: 51,
      winsWithoutHistory: 49,
      historyWinRate: 0.51,
    } as never);
    expect(effect.significant).toBe(false);
    expect(effect.verdict).toMatch(/no measurable effect/);
  });

  it('reports a clear win rate as an effect', () => {
    const effect = historyEffect({
      winsWithHistory: 70,
      winsWithoutHistory: 30,
      historyWinRate: 0.7,
    } as never);
    expect(effect.significant).toBe(true);
    expect(effect.verdict).toMatch(/history changed the outcome/);
  });
});
