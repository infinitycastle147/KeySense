import { describe, expect, it } from "vitest";
import { toSnapshotMetrics, snapshotSeries } from "./snapshots";
import type { MetricProfile } from "@/lib/types";

function profile(over: Partial<MetricProfile> = {}): MetricProfile {
  return {
    windowStart: "2026-07-01T00:00:00Z",
    windowEnd: "2026-08-01T00:00:00Z",
    testCount: 40,
    overall: {
      wpm: { value: 84, n: 40, reportable: true },
      accuracy: { value: 0.96, n: 40, reportable: true },
      consistency: { value: 78, n: 40, reportable: true },
    },
    worstBigrams: [
      {
        bigram: "ol",
        n: 340,
        errors: 29,
        errorRate: 0.084,
        errorRateCI: { low: 0.06, high: 0.12 },
        latencyP50: 211,
        sameFinger: true,
      },
    ],
    worstKeys: [],
    fingers: [],
    errorTaxonomy: { substitution: 40, insertion: 5, omission: 3, transposition: 8 },
    topConfusions: [],
    sameFingerBigrams: [],
    fatigue: { bucketSeconds: 10, wpm: [] },
    corrections: { backspaceRate: 0.06, meanCharsToNotice: { value: 1.8, n: 55, reportable: true } },
    rhythm: { medianIki: 180, coefficientOfVariation: 0.32, burstRate: 0.02, stallRate: 0.03, n: 900 },
    dynamics: { available: true, dwellP50: 78, flightP50: 96, overlapRate: 0.41, n: 900 },
    quality: { discardRate: 0.04, distractedTests: 1, testCount: 40 },
    charClasses: [],
    shift: { shiftedErrorRate: 0, unshiftedErrorRate: 0, n: 0 },
    geometry: { shapes: [], alternationRate: 0.5, medianSameHandRun: 2, redirectRate: 0.1, n: 900 },
    classifiedConfusions: [],
    timeLoss: { floorMs: 140, baselineWpm: 84, top: [] },
    configMatched: true,
    trend: { wpmDelta: 4.2, accuracyDelta: -0.3, comparedToDays: 30 },
    ...over,
  };
}

describe("toSnapshotMetrics", () => {
  it("keeps the longitudinal metrics", () => {
    const metrics = toSnapshotMetrics(profile());
    expect(metrics.wpm).toBe(84);
    expect(metrics.rhythm.medianIki).toBe(180);
    expect(metrics.timeLoss.floorMs).toBe(140);
  });

  it("keeps per-bigram rates so a curve can be drawn without re-reading events", () => {
    expect(toSnapshotMetrics(profile()).bigramErrorRates.ol).toEqual({ errorRate: 0.084, n: 340 });
  });

  it("does not freeze the ranked top-N lists into storage", () => {
    // Those are a view, recomputed whenever the ranker improves. Pinning them
    // would create a second, stale answer to "what are my worst bigrams".
    const metrics = toSnapshotMetrics(profile()) as Record<string, unknown>;
    expect(metrics.worstBigrams).toBeUndefined();
    expect(metrics.classifiedConfusions).toBeUndefined();
  });
});

describe("snapshotSeries", () => {
  const rows = [
    { window_end: "2026-06-01T00:00:00Z", tests_in_window: 30, metrics: toSnapshotMetrics(profile()) },
    {
      window_end: "2026-07-01T00:00:00Z",
      tests_in_window: 30,
      metrics: toSnapshotMetrics(
        profile({ overall: { wpm: { value: 90, n: 30, reportable: true }, accuracy: { value: 0.97, n: 30, reportable: true }, consistency: { value: 80, n: 30, reportable: true } } }),
      ),
    },
  ];

  it("extracts a metric's history in window order", () => {
    const series = snapshotSeries(rows, (m) => ({ value: m.wpm, n: 1 }));
    expect(series.map((p) => p.value)).toEqual([84, 90]);
  });

  it("skips snapshots that predate a metric rather than plotting them as zero", () => {
    // A metric that did not exist yet is not a metric that was zero; charting
    // it as zero invents a dramatic improvement on the day it was first added.
    const series = snapshotSeries(rows, (m) => {
      const row = m.bigramErrorRates.missing;
      return row ? { value: row.errorRate, n: row.n } : undefined;
    });
    expect(series).toEqual([]);
  });

  it("skips non-finite values", () => {
    const series = snapshotSeries(rows, () => ({ value: NaN, n: 1 }));
    expect(series).toEqual([]);
  });
});
