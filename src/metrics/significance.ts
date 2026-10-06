/**
 * Paired significance tests for benchmark results.
 *
 * Every comparison in this benchmark is paired: each strategy plays the same
 * layouts in the same order, so the right test is on the per-layout differences
 * rather than on the two means. Pairing removes layout difficulty from the
 * variance, which is most of it, and is what makes 60 games informative at all.
 *
 * The tests live here, with tests of their own, because the first write-up
 * computed its p-values ad hoc and nothing checked them.
 */

/** Log-gamma, Lanczos approximation. Used by the incomplete beta function. */
function logGamma(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j]! / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued-fraction expansion for the incomplete beta function. */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta function I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Two-sided p-value for Student's t with `df` degrees of freedom. */
export function studentTTwoSided(t: number, df: number): number {
  if (df <= 0) return NaN;
  const x = df / (df + t * t);
  return incompleteBeta(df / 2, 0.5, x);
}

/** Two-sided critical t value, by bisection on the p-value. */
export function tCritical(df: number, alpha = 0.05): number {
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTTwoSided(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface PairedResult {
  n: number;
  meanA: number;
  meanB: number;
  /** meanA - meanB. Negative means A used fewer shots, so A is better. */
  meanDiff: number;
  sdDiff: number;
  t: number;
  df: number;
  p: number;
  ci95: [number, number];
  /** Layouts where A used strictly fewer shots than B. */
  winsA: number;
  /** Layouts where the two tied exactly. */
  ties: number;
  /** Smallest difference this sample size could detect at 80% power. */
  detectableDiff: number;
}

/**
 * Paired two-sided t-test on per-layout differences.
 *
 * Throws on unequal lengths rather than truncating: silently comparing the
 * first N of two different layout sets is exactly the error the runner's
 * pairing check exists to prevent.
 */
export function pairedTTest(a: number[], b: number[]): PairedResult {
  if (a.length !== b.length) {
    throw new Error(`Paired test needs equal lengths, got ${a.length} and ${b.length}`);
  }
  const n = a.length;
  if (n < 2) throw new Error('Paired test needs at least two pairs');

  const diffs = a.map((x, i) => x - b[i]!);
  const meanDiff = diffs.reduce((s, x) => s + x, 0) / n;
  const variance = diffs.reduce((s, x) => s + (x - meanDiff) ** 2, 0) / (n - 1);
  const sdDiff = Math.sqrt(variance);
  const se = sdDiff / Math.sqrt(n);

  const df = n - 1;
  // A zero standard deviation means every pair differed identically. If that
  // difference is also zero the samples are identical and p is 1.
  const t = se === 0 ? (meanDiff === 0 ? 0 : Infinity) : meanDiff / se;
  const p = se === 0 ? (meanDiff === 0 ? 1 : 0) : studentTTwoSided(t, df);
  const crit = tCritical(df, 0.05);

  return {
    n,
    meanA: a.reduce((s, x) => s + x, 0) / n,
    meanB: b.reduce((s, x) => s + x, 0) / n,
    meanDiff,
    sdDiff,
    t,
    df,
    p,
    ci95: [meanDiff - crit * se, meanDiff + crit * se],
    winsA: diffs.filter((d) => d < 0).length,
    ties: diffs.filter((d) => d === 0).length,
    // 2.80 is the usual (z_{0.975} + z_{0.80}) constant for 80% power.
    detectableDiff: (2.8 * sdDiff) / Math.sqrt(n),
  };
}

/**
 * Pairs needed to detect `delta` at 80% power, given the paired SD.
 *
 * Reported whenever a comparison comes back inconclusive, so "not significant"
 * is always accompanied by what it would take to settle it.
 */
export function requiredPairs(sdDiff: number, delta: number): number {
  if (delta <= 0) return Infinity;
  return Math.ceil((2.8 * sdDiff / delta) ** 2);
}

/** Wilson score interval for a proportion. Behaves near 0 and 1, unlike normal. */
export function wilsonInterval(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/** Exact two-sided binomial test against p = 0.5. Ties are excluded by caller. */
export function signTest(successes: number, n: number): number {
  if (n === 0) return 1;
  const logC = (k: number) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  const pmf = (k: number) => Math.exp(logC(k) + n * Math.log(0.5));

  const observed = pmf(successes);
  // Sum every outcome no more likely than the observed one, with a small
  // tolerance so the mirrored tail is not dropped to floating-point noise.
  let total = 0;
  for (let k = 0; k <= n; k++) {
    const q = pmf(k);
    if (q <= observed * (1 + 1e-9)) total += q;
  }
  return Math.min(1, total);
}
