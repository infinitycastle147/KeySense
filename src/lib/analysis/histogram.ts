/**
 * Compact latency histograms, so pooled percentiles are real percentiles.
 *
 * ## The problem
 *
 * The rollup tier (`key_stats`, `bigram_stats`) stores one median per key per
 * test. Pooling a window therefore means averaging medians — see the header of
 * profile.ts, which documents this honestly as a known approximation. It is
 * worse than it sounds: a bigram appearing twice in a test contributes a
 * "median" that is a coin flip between two samples, and that coin flip is then
 * given equal standing per-observation with a median drawn from two hundred.
 *
 * The median of a pooled sample is not the average of its parts' medians, and
 * no weighting fixes that. What is needed is the *distribution*, kept small
 * enough to store per test.
 *
 * ## The representation
 *
 * A fixed-bin histogram over 0..OUTLIER_MS. Bins are fixed rather than adaptive
 * so that two histograms can be added by summing counts — which is the whole
 * point, and is what a t-digest or a sketch would complicate for accuracy this
 * data does not need.
 *
 * Resolution is bounded by bin width: a 20ms bin means percentiles are accurate
 * to about 20ms. That is far better than the current error, and irrelevant next
 * to the 1000ms outlier cut. Storage is one small integer array per row.
 *
 * Pure. See histogram.test.ts.
 */

import { OUTLIER_MS } from "./stats";

/** 20ms bins across 0..1000ms — 50 bins. Small enough to store per rollup row,
 *  fine enough that the quantisation error is well under the noise floor of a
 *  typing latency measurement. */
export const BIN_MS = 20;
export const BIN_COUNT = Math.ceil(OUTLIER_MS / BIN_MS);

/** Counts per bin. Index i covers [i*BIN_MS, (i+1)*BIN_MS). */
export type LatencyHistogram = number[];

export function emptyHistogram(): LatencyHistogram {
  return new Array<number>(BIN_COUNT).fill(0);
}

/** Builds a histogram from raw interval samples. Values outside 0..OUTLIER_MS
 *  are dropped, matching the outlier rule every other metric applies. */
export function buildHistogram(values: number[]): LatencyHistogram {
  const bins = emptyHistogram();
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || value > OUTLIER_MS) continue;
    bins[Math.min(BIN_COUNT - 1, Math.floor(value / BIN_MS))] += 1;
  }
  return bins;
}

/**
 * Adds histograms bin-wise.
 *
 * This is the operation the whole representation exists for: pooling a window
 * becomes exact addition rather than an average of summaries.
 */
export function mergeHistograms(histograms: LatencyHistogram[]): LatencyHistogram {
  const merged = emptyHistogram();
  for (const h of histograms) {
    for (let i = 0; i < BIN_COUNT && i < h.length; i++) merged[i] += h[i];
  }
  return merged;
}

export function histogramCount(histogram: LatencyHistogram): number {
  return histogram.reduce((sum, n) => sum + n, 0);
}

/**
 * Percentile from a histogram, in ms.
 *
 * Returns the **midpoint** of the containing bin rather than its lower edge —
 * an unbiased estimate of a value known only to lie somewhere within, where the
 * lower edge would systematically under-report every latency in the product by
 * half a bin.
 *
 * Empty input returns 0, matching the convention in stats.ts: callers gate on
 * count, never on the value being a sentinel.
 */
export function histogramPercentile(histogram: LatencyHistogram, p: number): number {
  const total = histogramCount(histogram);
  if (total === 0) return 0;

  const target = (Math.min(100, Math.max(0, p)) / 100) * total;
  let cumulative = 0;

  for (let i = 0; i < histogram.length; i++) {
    cumulative += histogram[i];
    if (cumulative >= target) return i * BIN_MS + BIN_MS / 2;
  }

  return (histogram.length - 1) * BIN_MS + BIN_MS / 2;
}

export function histogramMedian(histogram: LatencyHistogram): number {
  return histogramPercentile(histogram, 50);
}
