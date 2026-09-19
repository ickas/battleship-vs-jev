import { Board } from '../engine/board.js';
import { coordKey } from '../engine/coords.js';
import { randomFleet } from '../engine/placement.js';
import type { Rng } from '../engine/rng.js';
import type { Coord, GameConfig, PlacedShip } from '../engine/types.js';
import type { JevClient } from '../jev/types.js';
import type { Strategy } from '../strategies/types.js';
import { untriedCells } from '../strategies/untried.js';
import { OpponentHistory } from './history.js';
import { placeFleetWithJev } from './placement.js';

/**
 * Phase 2: two Jev instances playing each other, each keeping its own history
 * of the opponent.
 *
 * History is used in both directions, as the plan requires: when firing, the
 * opponent's past placements bias the code-side ranking towards cells they tend
 * to occupy; when placing, Jev is told in words where the opponent tends to
 * fire and picks a layout accordingly.
 */
export interface PlayerConfig {
  id: string;
  strategy: Strategy;
  client: JevClient;
  /** When false, this player ignores history entirely - the control condition. */
  useHistory: boolean;
  /** Let Jev choose the layout rather than generating a random one. */
  jevPlacement: boolean;
  temperature?: number;
}

export interface MatchResult {
  winnerId: string | undefined;
  /** Shots each player needed. Lower is better. */
  shotsByPlayer: Record<string, number>;
  hitsByPlayer: Record<string, number>;
  turns: number;
  fleets: Record<string, PlacedShip[]>;
  usedHistory: Record<string, boolean>;
  errors: string[];
}

export interface MatchOptions {
  config: GameConfig;
  players: [PlayerConfig, PlayerConfig];
  histories: Record<string, OpponentHistory>;
  rng: Rng;
  maxTurns?: number;
  abortSignal?: AbortSignal;
}

/**
 * Plays one game. Players alternate; the first to sink the opposing fleet wins.
 * The player who moves first has an advantage, so callers should alternate who
 * opens across a batch - `runSelfPlay` does.
 */
export async function playMatch(options: MatchOptions): Promise<MatchResult> {
  const { config, players, histories, rng, abortSignal } = options;
  const maxTurns = options.maxTurns ?? config.rows * config.cols * 2;

  const fleets: Record<string, PlacedShip[]> = {};
  const usedHistory: Record<string, boolean> = {};
  const errors: string[] = [];

  for (const player of players) {
    if (player.jevPlacement) {
      try {
        const placement = await placeFleetWithJev({
          config,
          client: player.client,
          rng,
          history: player.useHistory ? histories[player.id] : undefined,
          temperature: player.temperature ?? 0,
        });
        fleets[player.id] = placement.fleet;
        usedHistory[player.id] = placement.usedHistory;
        continue;
      } catch (error) {
        errors.push(
          `${player.id} placement failed, fell back to random: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    fleets[player.id] = randomFleet(config, rng);
    usedHistory[player.id] = false;
  }

  // Each player fires at the opponent's board.
  const boards: Record<string, Board> = {
    [players[0].id]: new Board(config, fleets[players[1].id]!),
    [players[1].id]: new Board(config, fleets[players[0].id]!),
  };
  const shotsFired: Record<string, Coord[]> = { [players[0].id]: [], [players[1].id]: [] };

  let winnerId: string | undefined;
  let turns = 0;

  outer: for (let turn = 0; turn < maxTurns; turn++) {
    for (const player of players) {
      abortSignal?.throwIfAborted();
      turns++;

      const board = boards[player.id]!;
      if (board.isFleetSunk) {
        winnerId = player.id;
        break outer;
      }

      const view = board.view();
      if (untriedCells(view).length === 0) break outer;

      try {
        // History is applied inside HistoryAwareStrategy, which owns both the
        // code-side prior and the semantic summaries sent to Jev.
        const decision = await player.strategy.nextShot(view, rng);
        board.fire(decision.coord);
        shotsFired[player.id]!.push(decision.coord);
      } catch (error) {
        // A failed shot costs the turn rather than the match.
        errors.push(
          `${player.id} shot failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        const fallback = untriedCells(board.view());
        if (fallback.length === 0) break outer;
        const coord = rng.pick(fallback);
        board.fire(coord);
        shotsFired[player.id]!.push(coord);
      }

      if (board.isFleetSunk) {
        winnerId = player.id;
        break outer;
      }
    }
  }

  // Record what each player learned about the other.
  for (const [index, player] of players.entries()) {
    const opponent = players[1 - index]!;
    histories[player.id]?.record({
      opponentFleet: fleets[opponent.id]!,
      opponentShots: shotsFired[opponent.id]!,
      won: winnerId === player.id,
      shotsTaken: shotsFired[player.id]!.length,
    });
  }

  return {
    winnerId,
    shotsByPlayer: {
      [players[0].id]: shotsFired[players[0].id]!.length,
      [players[1].id]: shotsFired[players[1].id]!.length,
    },
    hitsByPlayer: {
      [players[0].id]: countHits(boards[players[0].id]!),
      [players[1].id]: countHits(boards[players[1].id]!),
    },
    turns,
    fleets,
    usedHistory,
    errors,
  };
}

function countHits(board: Board): number {
  return board.history.filter((s) => s.result !== 'miss').length;
}

export { coordKey };
