import { describe, expect, it } from "vitest";
import {
  buildHistogram,
  mergeHistograms,
  histogramPercentile,
  histogramMedian,
  histogramCount,
  emptyHistogram,
  BIN_MS,
} from "./histogram";
import { median, percentile } from "./stats";

describe("buildHistogram", () => {
  it("counts every in-range sample", () => {
    expect(histogramCount(buildHistogram([100, 150, 200, 250]))).toBe(4);
  });

  it("applies the same outlier rule as every other metric", () => {
    expect(histogramCount(buildHistogram([100, 5000, -20, NaN]))).toBe(1);
  });

  it("handles an empty sample", () => {
    expect(histogramCount(buildHistogram([]))).toBe(0);
  });
});

describe("histogramPercentile", () => {
  it("lands within one bin of the true percentile", () => {
    const values = Array.from({ length: 500 }, (_, i) => 80 + (i % 300));
    const h = buildHistogram(values);
    expect(Math.abs(histogramMedian(h) - median(values))).toBeLessThanOrEqual(BIN_MS);
    expect(Math.abs(histogramPercentile(h, 90) - percentile(values, 90))).toBeLessThanOrEqual(BIN_MS);
  });

  it("returns a bin midpoint, not its lower edge", () => {
    // The lower edge would under-report every latency in the product by half a
    // bin, systematically and invisibly.
    expect(histogramMedian(buildHistogram([0, 0, 0]))).toBe(BIN_MS / 2);
  });

  it("returns 0 for an empty histogram", () => {
    expect(histogramMedian(emptyHistogram())).toBe(0);
  });

  it("clamps p to the valid range", () => {
    const h = buildHistogram([100, 200, 300]);
    expect(histogramPercentile(h, -50)).toBeGreaterThan(0);
    expect(histogramPercentile(h, 500)).toBeGreaterThan(0);
  });
});

describe("mergeHistograms — the reason this representation exists", () => {
  it("pools exactly, where averaging medians does not", () => {
    // Two skewed tests. Test A is mostly fast with a slow tail, so its median
    // is 100. Test B is small and mostly slow, so its median is 900 — and an
    // n-weighted average of the two medians lands at 180, while the true
    // median of every observation pooled together is 100.
    //
    // A median is not a mean, so no weighting of per-test medians recovers the
    // pooled one. Only the distribution does.
    const testA = [...Array<number>(170).fill(100), ...Array<number>(10).fill(900)];
    const testB = [...Array<number>(1).fill(100), ...Array<number>(19).fill(900)];

    const pooledTruth = median([...testA, ...testB]);
    const viaHistogram = histogramMedian(
      mergeHistograms([buildHistogram(testA), buildHistogram(testB)]),
    );

    // The n-weighted average of medians, as profile.ts does today.
    const averagedMedians =
      (median(testA) * testA.length + median(testB) * testB.length) /
      (testA.length + testB.length);

    expect(Math.abs(viaHistogram - pooledTruth)).toBeLessThanOrEqual(BIN_MS);
    expect(Math.abs(averagedMedians - pooledTruth)).toBeGreaterThan(BIN_MS);
  });

  it("is exact addition, so pooling order cannot matter", () => {
    const a = buildHistogram([100, 200]);
    const b = buildHistogram([300, 400]);
    expect(mergeHistograms([a, b])).toEqual(mergeHistograms([b, a]));
  });

  it("merges an empty list into an empty histogram", () => {
    expect(histogramCount(mergeHistograms([]))).toBe(0);
  });

  it("tolerates a short histogram from an older analysis version", () => {
    const merged = mergeHistograms([buildHistogram([100]), [1, 2]]);
    expect(histogramCount(merged)).toBe(4);
  });
});
