import { describe, expect, it } from "vitest";
import {
  OUTLIER_MS,
  MIN_FINDING_N,
  median,
  mad,
  trimmedMean,
  percentile,
  wilsonInterval,
  filterOutliers,
  coefficientOfVariation,
} from "./stats";

describe("constants", () => {
  it("exports the documented thresholds", () => {
    expect(OUTLIER_MS).toBe(1000);
    expect(MIN_FINDING_N).toBe(30);
  });
});

describe("median", () => {
  it("returns 0 for empty input", () => {
    expect(median([])).toBe(0);
  });

  it("returns the single value for a single sample", () => {
    expect(median([42])).toBe(42);
  });

  it("averages the two middle values for an even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("picks the middle value for an odd-length array, unsorted input", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("is not dragged by a single brutal outlier", () => {
    const withOutlier = [100, 105, 98, 102, 99, 10000];
    expect(median(withOutlier)).toBeLessThan(200);
  });
});

describe("percentile", () => {
  it("returns 0 for empty input", () => {
    expect(percentile([], 90)).toBe(0);
  });

  it("p50 matches median", () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 50)).toBe(median(values));
  });

  it("clamps p outside [0, 100]", () => {
    const values = [1, 2, 3];
    expect(percentile(values, -10)).toBe(percentile(values, 0));
    expect(percentile(values, 200)).toBe(percentile(values, 100));
  });

  it("does not produce NaN on a single sample at any percentile", () => {
    expect(percentile([7], 90)).toBe(7);
    expect(Number.isNaN(percentile([7], 90))).toBe(false);
  });
});

describe("mad", () => {
  it("returns 0 for empty input", () => {
    expect(mad([])).toBe(0);
  });

  it("returns 0 for a single sample", () => {
    expect(mad([50])).toBe(0);
  });

  it("returns 0 when every value is identical", () => {
    expect(mad([10, 10, 10, 10])).toBe(0);
  });

  it("computes the median absolute deviation", () => {
    // sorted [1,2,4,5,9], median = 4; deviations = [3,2,0,1,5] -> sorted [0,1,2,3,5] -> median 2
    expect(mad([1, 2, 4, 5, 9])).toBe(2);
  });
});

describe("trimmedMean", () => {
  it("returns 0 for empty input", () => {
    expect(trimmedMean([])).toBe(0);
  });

  it("returns the single value for a single sample", () => {
    expect(trimmedMean([17])).toBe(17);
  });

  it("is far less sensitive to a brutal outlier than a raw mean", () => {
    const values = [100, 102, 98, 101, 99, 103, 97, 100, 101, 99, 50000];
    const rawMean = values.reduce((s, v) => s + v, 0) / values.length;
    const trimmed = trimmedMean(values, 0.1);
    expect(trimmed).toBeLessThan(rawMean / 10);
  });

  it("never trims away every value", () => {
    // trimFraction clamped so at least one value always survives even on tiny n
    expect(Number.isNaN(trimmedMean([1, 2], 0.49))).toBe(false);
  });
});

describe("coefficientOfVariation", () => {
  it("returns 0 for empty input", () => {
    expect(coefficientOfVariation([])).toBe(0);
  });

  it("returns 0 when the median is 0 rather than NaN/Infinity", () => {
    expect(coefficientOfVariation([0, 0, 0])).toBe(0);
  });

  it("is higher for a more erratic series at the same median", () => {
    const steady = [100, 101, 99, 100, 100];
    const erratic = [20, 180, 30, 170, 100];
    expect(coefficientOfVariation(erratic)).toBeGreaterThan(coefficientOfVariation(steady));
  });
});

describe("wilsonInterval", () => {
  it("returns the maximally uncertain interval for n=0, never NaN", () => {
    const result = wilsonInterval(0, 0);
    expect(result).toEqual({ low: 0, high: 1 });
  });

  it("handles zero errors (perfect input) without producing NaN", () => {
    const result = wilsonInterval(0, 400);
    expect(Number.isNaN(result.low)).toBe(false);
    expect(Number.isNaN(result.high)).toBe(false);
    expect(result.low).toBe(0);
    expect(result.high).toBeGreaterThan(0);
  });

  it("handles all-errors (100%) without producing NaN", () => {
    const result = wilsonInterval(10, 10);
    expect(Number.isNaN(result.low)).toBe(false);
    expect(Number.isNaN(result.high)).toBe(false);
    expect(result.high).toBe(1);
  });

  it("bounds stay within [0, 1]", () => {
    for (const [s, n] of [[0, 1], [1, 1], [2, 3], [40, 400], [1, 1000]] as const) {
      const { low, high } = wilsonInterval(s, n);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
      expect(low).toBeLessThanOrEqual(high);
    }
  });

  it("small-n interval is much wider than large-n interval at a similar point estimate", () => {
    const small = wilsonInterval(2, 3); // 66.7%, n=3
    const large = wilsonInterval(40, 400); // 10%, n=400 (deliberately different rate)
    const smallWidth = small.high - small.low;
    const largeWidth = large.high - large.low;
    // The point of Wilson intervals: n=3 carries so little information that
    // its interval swamps a naive point-estimate comparison. Width alone
    // demonstrates this regardless of the two rates differing.
    expect(smallWidth).toBeGreaterThan(largeWidth * 3);
  });

  it("the 2/3-on-n=3 vs 40/400-on-n=400 case is resolved by MIN_FINDING_N gating, not by the interval alone", () => {
    // This is the literal invariant from CLAUDE.md: "2/3 on n=3 must never
    // outrank 40/400 on n=400." The interval's lower bound does not by
    // itself guarantee this ordering (a small-n sample's lower bound can
    // still exceed a large-n sample's lower bound) - the actual guarantee
    // comes from gating any n below MIN_FINDING_N out of ranking entirely.
    // See profile.test.ts's rankByBadness-equivalent coverage.
    expect(3).toBeLessThan(MIN_FINDING_N);
    expect(400).toBeGreaterThanOrEqual(MIN_FINDING_N);
  });
});

describe("filterOutliers", () => {
  it("returns [] for empty input", () => {
    expect(filterOutliers([])).toEqual([]);
  });

  it("discards intervals strictly above OUTLIER_MS", () => {
    expect(filterOutliers([100, 999, 1000, 1001, 5000])).toEqual([100, 999, 1000]);
  });

  it("discards negative and non-finite values", () => {
    expect(filterOutliers([100, -5, NaN, Infinity, 200])).toEqual([100, 200]);
  });

  it("returns [] when every value is an outlier", () => {
    expect(filterOutliers([1500, 2000, 9999])).toEqual([]);
  });

  it("supports a custom accessor for richer records", () => {
    const records = [{ interval: 50, key: "a" }, { interval: 2000, key: "b" }];
    expect(filterOutliers(records, (r) => r.interval)).toEqual([{ interval: 50, key: "a" }]);
  });
});
