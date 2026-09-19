import type { Rng } from '../engine/rng.js';
import type { BoardView } from '../engine/types.js';
import type { ShotDecision, Strategy } from './types.js';
import { untriedCells } from './untried.js';

/** Fires uniformly at random among untried cells. The floor any real strategy must beat. */
export class RandomStrategy implements Strategy {
  readonly id = 'random';
  readonly name = 'Random';
  readonly usesModel = false;

  async nextShot(view: BoardView, rng: Rng): Promise<ShotDecision> {
    const options = untriedCells(view);
    if (options.length === 0) throw new Error('No untried cells left to fire at');
    return { coord: rng.pick(options), notes: 'uniform random' };
  }
}
