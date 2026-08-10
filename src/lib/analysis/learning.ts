/**
 * Per-target learning curves.
 *
 * The `snapshots` table has existed since the first migration, complete with
 * RLS and an index, and nothing has ever written to it — so despite an
 * architecture built entirely around recomputable history, no longitudinal
 * view existed. docs/ARCHITECTURE.md §10 names the core emotional payload as
 * *"I am measurably better than I was a month ago"*, and that was the one thing
 * the product could not show.
 *
 * A learning curve answers a sharper question than a trend line does: not "is
 * this going down" but "is it still going down, or has it plateaued". Those
 * imply opposite actions — keep drilling, or stop wasting sessions on a target
 * that has given everything it is going to give.
 *
 * Pure. See learning.test.ts.
 */

import { MIN_FINDING_N, median } from "./stats";

export type SeriesPoint = {
  /** ISO timestamp. Only the ordering is used, never the spacing — sessions
   *  are irregular, and pretending they are evenly spaced would let a busy
   *  week look like faster learning than it was. */
  at: string;
  value: number;
  n: number;
};

export type LearningCurve = {
  /** Change per observation, in the units of `value`. Negative is improvement
   *  for error rates and latencies. */
  slope: number;
  /** Slope over the first half against the second half. Near zero in the
   *  second half means the curve has flattened. */
  recentSlope: number;
  /** True when the target has stopped responding: it improved earlier, and the
   *  recent half is flat or reversing. The signal to stop drilling it. */
  plateaued: boolean;
  first: number;
  last: number;
  /** Total relative change from first to last. */
  totalImprovement: number;
  n: number;
  reportable: boolean;
};

/**
 * Ordinary least squares slope against observation index.
 *
 * Index rather than elapsed time: practice effects follow repetitions, not
 * calendar days, and a fortnight's break should not register as a fortnight of
 * flat learning.
 */
function slopeOf(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Below this many points a "curve" is two dots and a straight line. */
export const MIN_CURVE_POINTS = 6;

/** How flat the recent half must be, relative to the early half, to count as
 *  a plateau. */
export const PLATEAU_RATIO = 0.25;

export function computeLearningCurve(series: SeriesPoint[]): LearningCurve {
  const ordered = [...series].sort((a, b) => a.at.localeCompare(b.at));
  const values = ordered.map((p) => p.value);
  const totalN = ordered.reduce((sum, p) => sum + p.n, 0);

  if (values.length === 0) {
    return {
      slope: 0,
      recentSlope: 0,
      plateaued: false,
      first: 0,
      last: 0,
      totalImprovement: 0,
      n: 0,
      reportable: false,
    };
  }

  const half = Math.floor(values.length / 2);
  const early = values.slice(0, half);
  const recent = values.slice(half);

  const slope = slopeOf(values);
  const recentSlope = slopeOf(recent);
  const earlySlope = slopeOf(early);

  // Smoothed endpoints: a curve judged on two single observations is judged on
  // two coin flips. Medians of the outer thirds are the honest read.
  const third = Math.max(1, Math.floor(values.length / 3));
  const first = median(values.slice(0, third));
  const last = median(values.slice(-third));

  const improvedEarly = earlySlope < 0;
  const flatNow = Math.abs(recentSlope) < Math.abs(earlySlope) * PLATEAU_RATIO;

  return {
    slope,
    recentSlope,
    plateaued: values.length >= MIN_CURVE_POINTS && improvedEarly && flatNow,
    first,
    last,
    totalImprovement: first > 0 ? (first - last) / first : 0,
    n: totalN,
    reportable: values.length >= MIN_CURVE_POINTS && totalN >= MIN_FINDING_N,
  };
}
