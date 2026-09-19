import { describe, expect, it } from 'vitest';
import { makeConfig, totalShipCells } from '../../engine/config.js';
import { playGame } from '../../engine/game.js';
import { randomFleet } from '../../engine/placement.js';
import { makeRng } from '../../engine/rng.js';
import { DensityStrategy } from '../density.js';
import { HuntTargetStrategy } from '../huntTarget.js';
import { RandomStrategy } from '../random.js';
import type { Strategy } from '../types.js';

const config = makeConfig();
const GAMES = 40;

async function averageShots(strategy: Strategy): Promise<number> {
  let total = 0;
  for (let seed = 0; seed < GAMES; seed++) {
    const fleet = randomFleet(config, makeRng(seed));
    const result = await playGame({
      config,
      fleet,
      strategy,
      rng: makeRng(seed + 10_000),
      seed,
    });
    expect(result.won).toBe(true);
    expect(result.hits).toBe(totalShipCells(config));
    total += result.shotCount;
  }
  return total / GAMES;
}

describe('baseline strategies', () => {
  it('all finish every game without an illegal shot', async () => {
    for (const strategy of [new RandomStrategy(), new HuntTargetStrategy(), new DensityStrategy()]) {
      const fleet = randomFleet(config, makeRng(7));
      const result = await playGame({
        config,
        fleet,
        strategy,
        rng: makeRng(7),
        seed: 7,
      });
      expect(result.won).toBe(true);
      // No cell is ever fired at twice.
      const labels = result.shots.map((s) => s.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('rank as expected: density beats hunt/target beats random', async () => {
    const [random, hunt, density] = await Promise.all([
      averageShots(new RandomStrategy()),
      averageShots(new HuntTargetStrategy()),
      averageShots(new DensityStrategy()),
    ]);

    expect(density).toBeLessThan(hunt);
    expect(hunt).toBeLessThan(random);
    // Sanity anchors: random averages ~95, a good density player lands in the 40s.
    expect(random).toBeGreaterThan(85);
    expect(density).toBeLessThan(55);
  }, 60_000);

  it('never exceeds the board size', async () => {
    const fleet = randomFleet(config, makeRng(3));
    const result = await playGame({
      config,
      fleet,
      strategy: new RandomStrategy(),
      rng: makeRng(3),
      seed: 3,
    });
    expect(result.shotCount).toBeLessThanOrEqual(100);
  });
});
