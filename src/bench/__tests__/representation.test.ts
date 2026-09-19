import { describe, expect, it } from 'vitest';
import { coordKey } from '../../engine/coords.js';
import { MockJevClient } from '../../jev/mock.js';
import { REPRESENTATIONS, getRepresentation } from '../../jev/representations.js';
import { untriedCells } from '../../strategies/untried.js';
import { buildPositions, formatScoreTable, scoreRepresentation } from '../representation.js';

describe('buildPositions', () => {
  it('builds the requested number of usable positions', async () => {
    const positions = await buildPositions({ count: 6, seed: 3 });
    expect(positions).toHaveLength(6);

    for (const position of positions) {
      // Every position still has something to find and somewhere to fire.
      expect(position.liveShipCells.size).toBeGreaterThan(0);
      expect(untriedCells(position.view).length).toBeGreaterThan(1);
      // Ground-truth cells are all still untried.
      for (const key of position.liveShipCells) {
        const [row, col] = key.split(',').map(Number);
        expect(position.view.cells[row!]![col!]).toBe('unknown');
      }
      // The ranking covers exactly the untried cells.
      expect(position.ranking).toHaveLength(untriedCells(position.view).length);
    }
  });

  it('covers a spread of game depths, not just openings', async () => {
    const positions = await buildPositions({ count: 6, seed: 3 });
    const depths = new Set(positions.map((p) => p.shotsTaken));
    expect(depths.size).toBeGreaterThan(1);
  });

  it('is deterministic for a given seed', async () => {
    const a = await buildPositions({ count: 4, seed: 11 });
    const b = await buildPositions({ count: 4, seed: 11 });
    expect(a.map((p) => p.shotsTaken)).toEqual(b.map((p) => p.shotsTaken));
    expect([...a[0]!.liveShipCells]).toEqual([...b[0]!.liveShipCells]);
  });
});

describe('scoreRepresentation', () => {
  it('scores every representation against the same positions', async () => {
    const positions = await buildPositions({ count: 4, seed: 5 });
    const client = new MockJevClient();

    for (const representation of REPRESENTATIONS) {
      const score = await scoreRepresentation(representation, positions, client);

      expect(score.representationId).toBe(representation.id);
      expect(score.positions).toBe(4);
      expect(score.failures).toBe(0);
      expect(score.hitRate).toBeGreaterThanOrEqual(0);
      expect(score.hitRate).toBeLessThanOrEqual(1);
      expect(score.meanRank).toBeGreaterThanOrEqual(1);
      expect(score.modelIds).toEqual(['mock-not-a-model']);
    }
  });

  it('reports the random and density baselines for the same positions', async () => {
    const positions = await buildPositions({ count: 5, seed: 8 });
    const score = await scoreRepresentation(
      getRepresentation('semantic'),
      positions,
      new MockJevClient(),
    );

    // The random baseline is the share of untried cells holding a live ship.
    const expected =
      positions.reduce(
        (sum, p) => sum + p.liveShipCells.size / untriedCells(p.view).length,
        0,
      ) / positions.length;
    expect(score.randomBaseline).toBeCloseTo(expected, 10);
    expect(score.densityBaseline).toBeGreaterThanOrEqual(0);
  });

  it('counts a choice outside the candidate list as a failure', async () => {
    const positions = await buildPositions({ count: 2, seed: 4 });
    const client = {
      log: [],
      stats: { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0 },
      ask: async () => ({
        answers: { target: { type: 'choice' as const, choice: 'not-a-cell' } },
        confidence: {},
        usage: {},
        modelId: 'test',
        latencyMs: 0,
      }),
    };

    const score = await scoreRepresentation(getRepresentation('semantic'), positions, client);
    expect(score.failures).toBe(2);
    expect(score.positions).toBe(0);
  });

  it('records a rank of 1 when the pick matches the density top choice', async () => {
    const positions = await buildPositions({ count: 1, seed: 6 });
    const top = positions[0]!.ranking[0]!;
    const client = {
      log: [],
      stats: { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0 },
      ask: async () => ({
        answers: {
          target: {
            type: 'choice' as const,
            choice: `${'ABCDEFGHIJ'[top.col]}${top.row + 1}`,
          },
        },
        confidence: { target: 0.9 },
        usage: { inputTokens: 10 },
        modelId: 'test',
        latencyMs: 1,
      }),
    };

    const score = await scoreRepresentation(getRepresentation('semantic'), positions, client);
    expect(score.topRate).toBe(1);
    expect(score.meanRank).toBe(1);
    expect(score.hitRate).toBe(positions[0]!.liveShipCells.has(coordKey(top)) ? 1 : 0);
  });
});

describe('formatScoreTable', () => {
  it('sorts by hit rate, best first', async () => {
    const table = formatScoreTable([
      {
        representationId: 'a',
        representationName: 'Worse',
        positions: 10,
        failures: 0,
        hitRate: 0.2,
        randomBaseline: 0.1,
        densityBaseline: 0.5,
        topRate: 0.1,
        meanRank: 20,
        meanInputTokens: 100,
        meanLatencyMs: 50,
        p95LatencyMs: 60,
        modelIds: [],
        generationIds: [],
        totalCostUsd: 0,
      },
      {
        representationId: 'b',
        representationName: 'Better',
        positions: 10,
        failures: 0,
        hitRate: 0.6,
        randomBaseline: 0.1,
        densityBaseline: 0.5,
        topRate: 0.4,
        meanRank: 4,
        meanInputTokens: 100,
        meanLatencyMs: 50,
        p95LatencyMs: 60,
        modelIds: [],
        generationIds: [],
        totalCostUsd: 0,
      },
    ]);
    const lines = table.split('\n');
    expect(lines[2]).toContain('Better');
    expect(lines[3]).toContain('Worse');
  });
});
