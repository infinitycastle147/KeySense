/**
 * Robust-statistics primitives shared by every metric in src/lib/analysis/.
 *
 * See docs/ARCHITECTURE.md §5.3 and CLAUDE.md invariant 4:
 *   - Medians, MAD, trimmed means. Never a raw mean.
 *   - Discard inter-key intervals > 1000ms before computing anything.
 *   - Wilson score intervals on every error rate.
 *   - No finding below n >= MIN_FINDING_N.
 *
 * Every function here is pure and total: no throwing, no NaN, no Infinity on
 * empty or degenerate input. Empty input conventionally yields 0 (documented
 * per-function) — callers gate on `n`/`reportable`, not on the return value
 * being some sentinel like NaN.
 */

/** Inter-key intervals above this are "not typing" (thinking pause, distraction,
 *  tab-away) and must be discarded before any latency computation. */
export const OUTLIER_MS = 1000;

/** No metric may become a *finding* below this many observations. Below it,
 *  `Measured.reportable` is false. See docs/ARCHITECTURE.md §5.3. */
export const MIN_FINDING_N = 30;

/**
 * Percentile via linear interpolation between closest ranks (the "linear"
 * method, matching numpy's default). `p` in [0, 100].
 *
 * Empty input returns 0 by convention — callers must check sample size
 * separately before treating that 0 as a real measurement.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const clampedP = Math.min(100, Math.max(0, p));
  const rank = (clampedP / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);

  if (lower === upper) return sorted[lower];

  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/** Median = 50th percentile. Never use a raw arithmetic mean for latency data. */
export function median(values: number[]): number {
  return percentile(values, 50);
}

/**
 * Median Absolute Deviation: median(|x - median(x)|). A robust analogue of
 * standard deviation that isn't dragged around by outliers.
 *
 * Empty or single-element input returns 0.
 */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const m = median(values);
  const deviations = values.map((v) => Math.abs(v - m));
  return median(deviations);
}

/**
 * Trimmed mean: drop `trimFraction` of values from each tail (sorted), then
 * take the arithmetic mean of what remains. Reduces sensitivity to outliers
 * without discarding as much information as the median.
 *
 * `trimFraction` is the fraction removed from *each* end (default 10%), so
 * a 0.1 trim removes 20% of the data total. Guards against trimming away the
 * entire array on small n — at least one value always survives.
 */
export function trimmedMean(values: number[], trimFraction = 0.1): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * Math.min(0.49, Math.max(0, trimFraction)));
  const trimmed = trimCount > 0 ? sorted.slice(trimCount, sorted.length - trimCount) : sorted;
  const pool = trimmed.length > 0 ? trimmed : sorted;
  return pool.reduce((sum, v) => sum + v, 0) / pool.length;
}

/**
 * Robust coefficient of variation: MAD / median, rather than stdev / mean.
 * Used to characterise rhythm spread (steady vs. bursty typing) without a
 * single long pause dominating the number.
 *
 * Returns 0 when the median is 0 (degenerate — avoids Infinity/NaN; in
 * practice inter-key intervals are always > 0).
 */
export function coefficientOfVariation(values: number[]): number {
  const m = median(values);
  if (m === 0) return 0;
  return mad(values) / m;
}

export type Interval = { low: number; high: number };

/**
 * Wilson score interval for a binomial proportion (errors / n). Unlike a
 * naive `errors/n +/- margin`, it stays well-behaved at small n and near 0/1,
 * which is exactly what keeps a 2/3 error rate on n=3 from outranking a
 * 40/400 error rate on n=400 — the interval on the n=3 sample is enormous.
 *
 * `z` defaults to 1.96 (~95% confidence).
 *
 * n <= 0 returns the maximally uncertain interval {low: 0, high: 1} — there
 * is no information, so the interval should say so rather than divide by
 * zero into NaN.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { low: 0, high: 1 };

  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;

  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

/**
 * Filters out interval samples above `maxMs` (default OUTLIER_MS) and any
 * negative/non-finite values (clock or ordering glitches). This is the one
 * place the ">1000ms is not typing" rule should be enforced — call it before
 * computing any latency statistic.
 *
 * Generic over `T` so callers can filter richer records (e.g. `{ interval,
 * key }`) by supplying `getValue`; defaults to treating `T` as `number`.
 */
export function filterOutliers<T = number>(
  items: T[],
  getValue: (item: T) => number = (item) => item as unknown as number,
  maxMs: number = OUTLIER_MS
): T[] {
  return items.filter((item) => {
    const value = getValue(item);
    return Number.isFinite(value) && value >= 0 && value <= maxMs;
  });
}

// ---------------------------------------------------------------------------
// Uncertainty on latency
// ---------------------------------------------------------------------------

/**
 * Deterministic PRNG (mulberry32).
 *
 * The bootstrap needs randomness; the analysis layer needs reproducibility.
 * docs/ARCHITECTURE.md §2 rests on being able to re-run analysis over archived
 * events and get the same answer — a `Math.random()` bootstrap would make
 * every recomputation disagree slightly with the stored one, and there would
 * be no way to tell that drift apart from a real algorithm change.
 *
 * Seeded from the data itself (below), so identical input always yields an
 * identical interval without any seed having to be threaded through callers.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Order-sensitive hash of the sample, used as the bootstrap seed. */
function seedFrom(values: number[]): number {
  let h = 2166136261;
  for (const v of values) {
    h ^= Math.round(v * 1000);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Resamples below this are not worth reporting — the interval would be wider
 *  than the measurement is useful. Callers gate on `n` anyway; this is the
 *  floor at which the bootstrap itself stops being meaningful. */
export const MIN_BOOTSTRAP_N = 8;

export const BOOTSTRAP_RESAMPLES = 500;

/**
 * Percentile bootstrap confidence interval for a median.
 *
 * Every error rate in this codebase carries a Wilson interval, and until now
 * every median latency carried nothing — so `relativeLatency: 2.1` and
 * `relativeLatency: 1.15` looked equally solid to the ranker and to the model,
 * despite one possibly resting on 9 samples and the other on 900. That
 * asymmetry meant the careful path guarded error rates while the loose path
 * drove the latency findings.
 *
 * A bootstrap rather than a closed form because the sampling distribution of a
 * median has no usable analytic expression for the small, skewed, discrete
 * samples typing produces.
 *
 * Returns a zero-width interval at the point estimate when there is too little
 * data to resample — honest in the sense that no width is claimed, and callers
 * must still gate on `n`.
 */
export function bootstrapMedianCI(
  values: number[],
  confidence = 0.95,
  resamples = BOOTSTRAP_RESAMPLES,
): Interval {
  if (values.length === 0) return { low: 0, high: 0 };
  const point = median(values);
  if (values.length < MIN_BOOTSTRAP_N) return { low: point, high: point };

  const rand = mulberry32(seedFrom(values));
  const medians: number[] = [];
  const sample = new Array<number>(values.length);

  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < values.length; i++) {
      sample[i] = values[Math.floor(rand() * values.length)];
    }
    medians.push(median(sample));
  }

  const tail = (1 - confidence) / 2;
  return {
    low: percentile(medians, tail * 100),
    high: percentile(medians, (1 - tail) * 100),
  };
}

/**
 * True when two medians are far enough apart that their bootstrap intervals
 * don't overlap — a conservative, non-parametric "this difference is real".
 *
 * Deliberately conservative: non-overlapping intervals imply significance at
 * roughly the stated level, but overlapping ones do not imply the opposite.
 * For gating a *finding*, erring toward silence is the correct direction.
 */
export function intervalsSeparated(a: Interval, b: Interval): boolean {
  return a.high < b.low || b.high < a.low;
}
