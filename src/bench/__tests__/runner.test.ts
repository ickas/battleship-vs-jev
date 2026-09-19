import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../engine/config.js';
import { randomFleet } from '../../engine/placement.js';
import { makeRng, type Rng } from '../../engine/rng.js';
import { DensityStrategy } from '../../strategies/density.js';
import { RandomStrategy } from '../../strategies/random.js';
import type { BoardView } from '../../engine/types.js';
import type { ShotDecision, Strategy } from '../../strategies/types.js';
import { runBench } from '../runner.js';
import { buildStrategy, ALL_STRATEGY_IDS } from '../strategies.js';
import { MockJevClient } from '../../jev/mock.js';

const config = makeConfig();

/** Fails every call, to exercise the failure limit. */
class BrokenStrategy implements Strategy {
  readonly id = 'broken';
  readonly name = 'Broken';
  readonly usesModel = false;
  calls = 0;

  async nextShot(): Promise<ShotDecision> {
    this.calls++;
    throw new Error('deliberate failure');
  }
}

/** Fires at a cell that was already shot, which the game loop must reject. */
class IllegalStrategy implements Strategy {
  readonly id = 'illegal';
  readonly name = 'Illegal';
  readonly usesModel = false;

  async nextShot(_view: BoardView, _rng: Rng): Promise<ShotDecision> {
    return { coord: { row: 0, col: 0 } };
  }
}

describe('runBench', () => {
  it('runs every strategy over the same layouts', async () => {
    const report = await runBench({
      config,
      strategies: [new RandomStrategy(), new DensityStrategy()],
      games: 4,
      seed: 99,
    });

    expect(report.summaries).toHaveLength(2);
    expect(report.results).toHaveLength(8);
    expect(report.errors).toEqual([]);

    // Paired comparison: both strategies saw identical fleets.
    const random = report.results.filter((r) => r.strategyId === 'random');
    const density = report.results.filter((r) => r.strategyId === 'density');
    for (let i = 0; i < 4; i++) {
      expect(random[i]!.fleet).toEqual(density[i]!.fleet);
    }
  });

  it('is reproducible for a given seed', async () => {
    const run = () =>
      runBench({ config, strategies: [new DensityStrategy()], games: 3, seed: 7 });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.results.map((r) => r.shotCount)).toEqual(b.results.map((r) => r.shotCount));
  });

  it('accepts caller-supplied layouts', async () => {
    const layouts = [randomFleet(config, makeRng(1)), randomFleet(config, makeRng(2))];
    const report = await runBench({
      config,
      strategies: [new DensityStrategy()],
      games: 2,
      layouts,
    });
    expect(report.results[0]!.fleet).toEqual(layouts[0]);
  });

  it('rejects a layout list shorter than the game count', async () => {
    await expect(
      runBench({
        config,
        strategies: [new DensityStrategy()],
        games: 5,
        layouts: [randomFleet(config, makeRng(1))],
      }),
    ).rejects.toThrow(/Need 5 layouts/);
  });

  it('stops a strategy after the failure limit and records the errors', async () => {
    const broken = new BrokenStrategy();
    const report = await runBench({
      config,
      strategies: [broken],
      games: 20,
      failureLimit: 3,
    });

    expect(broken.calls).toBe(3);
    expect(report.summaries).toHaveLength(0);
    expect(report.errors.some((e) => e.error.includes('deliberate failure'))).toBe(true);
    expect(report.errors.some((e) => e.error.includes('Stopped after 3'))).toBe(true);
  });

  it('records an illegal shot as an error rather than corrupting the board', async () => {
    const report = await runBench({
      config,
      strategies: [new IllegalStrategy()],
      games: 2,
      failureLimit: 2,
    });
    expect(report.errors[0]!.error).toMatch(/already fired at/);
  });

  it('keeps going when one strategy fails and another succeeds', async () => {
    const report = await runBench({
      config,
      strategies: [new BrokenStrategy(), new DensityStrategy()],
      games: 3,
      failureLimit: 2,
    });
    expect(report.summaries).toHaveLength(1);
    expect(report.summaries[0]!.strategyId).toBe('density');
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runBench({
        config,
        strategies: [new DensityStrategy()],
        games: 5,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it('reports progress for each game', async () => {
    const events: number[] = [];
    await runBench({
      config,
      strategies: [new DensityStrategy()],
      games: 3,
      onProgress: (event) => events.push(event.gameIndex),
    });
    expect(events).toEqual([0, 1, 2]);
  });
});

describe('buildStrategy', () => {
  it('builds every documented strategy id', () => {
    const client = new MockJevClient();
    for (const id of ALL_STRATEGY_IDS) {
      expect(buildStrategy(id, { client }).id).toContain(id === 'jevPure' || id === 'jevHybrid' ? 'jev' : id);
    }
  });

  it('rejects an unknown id', () => {
    expect(() => buildStrategy('nope', { client: new MockJevClient() })).toThrow(/Unknown strategy/);
  });
});
