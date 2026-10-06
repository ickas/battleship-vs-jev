import { describe, expect, it } from 'vitest';
import {
  pairedTTest,
  requiredPairs,
  signTest,
  studentTTwoSided,
  tCritical,
  wilsonInterval,
} from '../significance.js';

describe('tCritical', () => {
  // Standard two-sided 5% critical values, from a t table.
  it.each([
    [1, 12.706],
    [10, 2.228],
    [29, 2.045],
    [59, 2.001],
    [1000, 1.962],
  ])('df=%i gives %f', (df, expected) => {
    expect(tCritical(df, 0.05)).toBeCloseTo(expected, 2);
  });
});

describe('studentTTwoSided', () => {
  it('is 1 at t=0 and falls towards 0 as t grows', () => {
    expect(studentTTwoSided(0, 10)).toBeCloseTo(1, 6);
    expect(studentTTwoSided(2.228, 10)).toBeCloseTo(0.05, 3);
    expect(studentTTwoSided(10, 10)).toBeLessThan(1e-5);
  });

  it('is symmetric in the sign of t', () => {
    expect(studentTTwoSided(1.7, 25)).toBeCloseTo(studentTTwoSided(-1.7, 25), 12);
  });
});

describe('pairedTTest', () => {
  it('finds no difference between identical samples', () => {
    const a = [10, 20, 30, 40];
    const r = pairedTTest(a, a);
    expect(r.meanDiff).toBe(0);
    expect(r.p).toBe(1);
    expect(r.winsA).toBe(0);
    expect(r.ties).toBe(4);
  });

  it('computes a known case by hand', () => {
    // Differences are all exactly -2, so sd = 0 and the result is decisive.
    const r = pairedTTest([8, 9, 10, 11], [10, 11, 12, 13]);
    expect(r.meanDiff).toBe(-2);
    expect(r.sdDiff).toBe(0);
    expect(r.p).toBe(0);
    expect(r.winsA).toBe(4);
  });

  it('reports a negative mean difference when A uses fewer shots', () => {
    const r = pairedTTest([40, 42, 38, 41], [48, 50, 44, 46]);
    expect(r.meanDiff).toBeLessThan(0);
    expect(r.winsA).toBe(4);
    expect(r.p).toBeLessThan(0.05);
  });

  it('puts zero inside the interval when the difference is noise', () => {
    const a = [40, 55, 38, 61, 44, 50];
    const b = [41, 52, 42, 58, 47, 49];
    const r = pairedTTest(a, b);
    expect(r.ci95[0]).toBeLessThan(0);
    expect(r.ci95[1]).toBeGreaterThan(0);
    expect(r.p).toBeGreaterThan(0.05);
  });

  it('refuses unequal lengths rather than truncating', () => {
    expect(() => pairedTTest([1, 2, 3], [1, 2])).toThrow(/equal lengths/);
  });

  it('refuses a single pair', () => {
    expect(() => pairedTTest([1], [2])).toThrow(/at least two/);
  });

  it('reports what the sample could have detected', () => {
    const r = pairedTTest([40, 55, 38, 61, 44, 50], [41, 52, 42, 58, 47, 49]);
    expect(r.detectableDiff).toBeCloseTo((2.8 * r.sdDiff) / Math.sqrt(6), 10);
  });
});

describe('requiredPairs', () => {
  it('grows with the square of the ratio', () => {
    // Halving the difference to detect quadruples the games needed.
    expect(requiredPairs(10, 4)).toBe(49);
    expect(requiredPairs(10, 2)).toBe(196);
  });

  it('is infinite for a zero difference', () => {
    expect(requiredPairs(10, 0)).toBe(Infinity);
  });
});

describe('wilsonInterval', () => {
  it('matches a reference computation', () => {
    const [lo, hi] = wilsonInterval(31, 60);
    expect(lo).toBeCloseTo(0.3931, 4);
    expect(hi).toBeCloseTo(0.6383, 4);
  });

  it('stays inside [0, 1] at the extremes, unlike a normal interval', () => {
    const [lo, hi] = wilsonInterval(60, 60);
    expect(lo).toBeCloseTo(0.9398, 4);
    expect(hi).toBeCloseTo(1, 12);
    expect(hi).toBeLessThanOrEqual(1);
    expect(wilsonInterval(0, 60)[0]).toBe(0);
  });
});

describe('signTest', () => {
  // Reference values computed exactly from the binomial pmf.
  it.each([
    [30, 60, 1.0],
    [31, 60, 0.897422],
    [40, 60, 0.013489],
    [45, 60, 0.000135],
    [8, 10, 0.109375],
  ])('%i of %i gives p=%f', (k, n, expected) => {
    expect(signTest(k, n)).toBeCloseTo(expected, 5);
  });

  it('is symmetric about half', () => {
    expect(signTest(40, 60)).toBeCloseTo(signTest(20, 60), 12);
  });
});
