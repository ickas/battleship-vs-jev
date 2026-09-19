import { describe, expect, it } from 'vitest';
import { MockJevClient } from '../../jev/mock.js';
import { makeConfig } from '../../engine/config.js';
import { randomFleet } from '../../engine/placement.js';
import { makeRng } from '../../engine/rng.js';
import { GameSession } from '../gameSession.js';

const config = makeConfig();

function session(strategyId = 'density') {
  return new GameSession({ strategyId, client: new MockJevClient(), seed: 7 });
}

describe('GameSession', () => {
  it('hides the fleet until the game is over', async () => {
    const game = session();
    const fleet = randomFleet(config, makeRng(7));

    expect(game.snapshot().fleet).toBeUndefined();

    // Play to the end; the layout must stay hidden the whole way.
    while (!game.isOver) {
      await game.step();
      if (!game.isOver) expect(game.snapshot().fleet).toBeUndefined();
    }

    // Only now is it revealed, and it is the layout that was actually hunted.
    const revealed = game.snapshot().fleet;
    expect(revealed).toBeDefined();
    expect(revealed).toEqual(fleet);
  }, 30_000);

  it('never leaks ship positions through the snapshot mid-game', async () => {
    const game = session();
    for (let i = 0; i < 10; i++) await game.step();

    const serialized = JSON.stringify(game.snapshot());
    expect(serialized).not.toContain('bow');
    expect(serialized).not.toContain('orientation');
  });

  it('refuses to step once the game is over', async () => {
    const game = session();
    while (!game.isOver) await game.step();
    await expect(game.step()).rejects.toThrow(/already over/);
  }, 30_000);

  it('counts hits, misses and accuracy consistently', async () => {
    const game = session();
    for (let i = 0; i < 12; i++) await game.step();

    const snapshot = game.snapshot();
    expect(snapshot.shots).toBe(12);
    expect(snapshot.hits + snapshot.misses).toBe(12);
    expect(snapshot.accuracy).toBeCloseTo(snapshot.hits / 12, 10);
    expect(snapshot.history).toHaveLength(12);
  });

  it('never fires at the same cell twice', async () => {
    const game = session();
    while (!game.isOver) await game.step();

    const labels = game.snapshot().history.map((h) => h.label);
    expect(new Set(labels).size).toBe(labels.length);
  }, 30_000);

  it('is reproducible for a given seed', async () => {
    const a = new GameSession({ strategyId: 'density', client: new MockJevClient(), seed: 21 });
    const b = new GameSession({ strategyId: 'density', client: new MockJevClient(), seed: 21 });
    for (let i = 0; i < 8; i++) {
      await a.step();
      await b.step();
    }
    expect(a.snapshot().history.map((h) => h.label)).toEqual(
      b.snapshot().history.map((h) => h.label),
    );
  });

  it('carries model metadata through for a Jev strategy', async () => {
    const game = new GameSession({
      strategyId: 'jevHybrid',
      client: new MockJevClient(),
      seed: 4,
    });
    await game.step();

    const snapshot = game.snapshot();
    expect(snapshot.modelIds).toContain('mock-not-a-model');
    expect(snapshot.heatmap).toBeDefined();
    expect(snapshot.heatmapSource).toBe('model');
  });

  it('rejects an unknown strategy id at construction', () => {
    expect(() => session('nope')).toThrow(/Unknown strategy/);
  });
});
