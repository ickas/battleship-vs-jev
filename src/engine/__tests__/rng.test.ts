import { describe, expect, it } from 'vitest';
import { makeRng, sampleFromWeights } from '../rng.js';

describe('makeRng', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = Array.from({ length: 20 }, () => makeRng(7).next());
    expect(makeRng(7).next()).toBe(a[0]);
    expect(makeRng(8).next()).not.toBe(a[0]);
  });

  it('produces values in [0, 1)', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 2000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('int stays within range and covers it', () => {
    const rng = makeRng(2);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const value = rng.int(6);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
      seen.add(value);
    }
    expect(seen.size).toBe(6);
  });

  it('pick rejects an empty list', () => {
    expect(() => makeRng(1).pick([])).toThrow(/empty list/);
  });

  it('shuffle keeps every element and does not mutate the input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = makeRng(3).shuffle(input);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('sampleFromWeights', () => {
  it('returns the argmax at temperature 0', () => {
    expect(sampleFromWeights([0.1, 0.7, 0.2], makeRng(1), 0)).toBe(1);
    expect(sampleFromWeights([0.9, 0.05, 0.05], makeRng(99), 0)).toBe(0);
    // Deterministic regardless of the RNG stream.
    for (let seed = 0; seed < 20; seed++) {
      expect(sampleFromWeights([0.2, 0.3, 0.5], makeRng(seed), 0)).toBe(2);
    }
  });

  it('samples roughly in proportion to the weights at temperature 1', () => {
    const rng = makeRng(42);
    const counts = [0, 0, 0];
    const draws = 6000;
    for (let i = 0; i < draws; i++) counts[sampleFromWeights([0.2, 0.3, 0.5], rng, 1)]!++;

    expect(counts[0]! / draws).toBeCloseTo(0.2, 1);
    expect(counts[1]! / draws).toBeCloseTo(0.3, 1);
    expect(counts[2]! / draws).toBeCloseTo(0.5, 1);
  });

  it('flattens the distribution as temperature rises', () => {
    const share = (temperature: number) => {
      const rng = makeRng(5);
      let top = 0;
      for (let i = 0; i < 4000; i++) {
        if (sampleFromWeights([0.05, 0.05, 0.9], rng, temperature) === 2) top++;
      }
      return top / 4000;
    };

    // Sharper than proportional, proportional, then flatter.
    expect(share(0.3)).toBeGreaterThan(share(1));
    expect(share(1)).toBeGreaterThan(share(5));
    expect(share(5)).toBeLessThan(0.9);
  });

  it('falls back to a uniform draw when every weight is zero', () => {
    const rng = makeRng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(sampleFromWeights([0, 0, 0], rng, 1));
    expect(seen.size).toBe(3);
  });

  it('never returns an index for a negative weight', () => {
    const rng = makeRng(13);
    for (let i = 0; i < 500; i++) {
      expect(sampleFromWeights([-5, 1], rng, 1)).toBe(1);
    }
  });

  it('always returns a valid index', () => {
    const rng = makeRng(17);
    for (let i = 0; i < 500; i++) {
      const index = sampleFromWeights([0.3, 0.3, 0.4], rng, 1);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(3);
    }
  });

  it('rejects an empty distribution', () => {
    expect(() => sampleFromWeights([], makeRng(1), 1)).toThrow(/empty distribution/);
  });
});
