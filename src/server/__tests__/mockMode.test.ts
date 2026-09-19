import { describe, expect, it } from 'vitest';
import { isMockEnabled } from '../mockMode.js';

/**
 * This flag decides whether a run's numbers came from the model or from
 * code-side density, so the direction it fails in matters more than the exact
 * vocabulary it accepts.
 */
describe('isMockEnabled', () => {
  it('is off when the variable is not set at all', () => {
    // The default: a server with no JEV_MOCK in the environment uses the model.
    expect(isMockEnabled(undefined)).toBe(false);
  });

  it('is off for an empty or whitespace-only value', () => {
    expect(isMockEnabled('')).toBe(false);
    expect(isMockEnabled('   ')).toBe(false);
  });

  it('is on for the documented affirmatives, in any case', () => {
    for (const value of ['1', 'true', 'yes', 'TRUE', 'Yes', 'True']) {
      expect(isMockEnabled(value), value).toBe(true);
    }
  });

  it('is off for the documented negatives', () => {
    for (const value of ['0', 'false', 'no', 'FALSE', 'No']) {
      expect(isMockEnabled(value), value).toBe(false);
    }
  });

  it('ignores surrounding whitespace', () => {
    expect(isMockEnabled(' 1 ')).toBe(true);
    expect(isMockEnabled('\ttrue\n')).toBe(true);
    expect(isMockEnabled(' 0 ')).toBe(false);
  });

  it('fails safe: anything unrecognised leaves the real model in place', () => {
    // A typo should cost an API call, never the validity of a result. Note
    // that 'on' and 'enabled' are NOT recognised, and are off by design.
    for (const value of ['on', 'enabled', 'mock', 'y', '2', '-1', 'null', 'undefined', '1.0']) {
      expect(isMockEnabled(value), value).toBe(false);
    }
  });

  it('does not treat a substring as a match', () => {
    expect(isMockEnabled('not-true')).toBe(false);
    expect(isMockEnabled('true-ish')).toBe(false);
    expect(isMockEnabled('11')).toBe(false);
  });
});
