import { describe, expect, it } from "vitest";
import { evaluate, computeVerdict } from "./evaluate";
import {
  RESOLVED_RELATIVE_IMPROVEMENT,
  IMPROVED_RELATIVE_IMPROVEMENT,
  REGRESSED_RELATIVE_WORSENING,
} from "./constants";
import type { Prescription } from "@/lib/types";
import type { TestAnalysis } from "@/lib/analysis/profile";

function prescription(overrides: Partial<Prescription> = {}): Prescription {
  return {
    id: "rx-1",
    reportId: "report-1",
    targetType: "bigram",
    targets: ["th"],
    drillConfig: { wordCount: 40, targetRatio: 0.7, corpus: "english_5k" },
    baseline: { errorRate: 0.084, latencyP50: 210, n: 340 },
    outcome: null,
    verdict: null,
    status: "active",
    drillsTarget: 5,
    drillsDone: 5,
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function bigramAnalysis(
  endedAt: string,
  bigram: string,
  n: number,
  errorRate: number,
  latencyP50: number,
): TestAnalysis {
  return {
    testId: `t-${endedAt}`,
    endedAt,
    durationMs: 30000,
    result: {
      wpm: 60,
      rawWpm: 62,
      accuracy: 1 - errorRate,
      consistency: 80,
      charsCorrect: 100,
      charsIncorrect: 3,
      charsExtra: 0,
      charsMissed: 0,
    },
    keyStats: [],
    bigramStats: [
      {
        bigram,
        n,
        errors: Math.round(errorRate * n),
        errorRate,
        errorRateCI: { low: 0, high: 1 },
        latencyP50,
        sameFinger: false,
      },
    ],
    fingerStats: [],
    errorTaxonomy: { substitution: 0, insertion: 0, omission: 0, transposition: 0 },
    confusionMatrix: {},
    fatigue: [],
    corrections: {
      backspaceCount: 0,
      charAttemptCount: 0,
      backspaceRate: 0,
      meanCharsToNotice: { value: 0, n: 0, reportable: false },
    },
  };
}

describe("evaluate — like-with-like gating", () => {
  it("returns insufficient-n when post-prescription observations don't reach MIN_FINDING_N", () => {
    const rx = prescription();
    const result = evaluate(rx, [bigramAnalysis("2026-08-02T00:00:00.000Z", "th", 10, 0.05, 190)]);
    expect(result).toEqual({ ok: false, reason: "insufficient-n", n: 10 });
  });

  it("ignores tests recorded before createdAt, even if they'd push n over the threshold", () => {
    const rx = prescription({ createdAt: "2026-08-10T00:00:00.000Z" });
    const analyses = [
      bigramAnalysis("2026-08-01T00:00:00.000Z", "th", 500, 0.01, 100), // before — must be excluded
      bigramAnalysis("2026-08-11T00:00:00.000Z", "th", 20, 0.05, 190), // after, below threshold alone
    ];
    const result = evaluate(rx, analyses);
    expect(result).toEqual({ ok: false, reason: "insufficient-n", n: 20 });
  });

  it("pools only post-createdAt tests once they clear MIN_FINDING_N", () => {
    const rx = prescription({ createdAt: "2026-08-10T00:00:00.000Z" });
    const analyses = [
      bigramAnalysis("2026-08-01T00:00:00.000Z", "th", 500, 0.9, 900), // before — excluded
      bigramAnalysis("2026-08-11T00:00:00.000Z", "th", 100, 0.03, 190),
    ];
    const result = evaluate(rx, analyses);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome.n).toBe(100);
      expect(result.outcome.errorRate).toBeCloseTo(0.03, 5);
    }
  });

  it("matches the docs/ARCHITECTURE.md §7 worked example: 0.084 -> 0.031 is 'resolved'", () => {
    const rx = prescription({
      baseline: { errorRate: 0.084, latencyP50: 210, n: 340 },
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const result = evaluate(
      rx,
      [bigramAnalysis("2026-08-05T00:00:00.000Z", "th", 340, 0.031, 178)],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdict).toBe("resolved");
  });
});

describe("computeVerdict — explicit named thresholds, driven by errorRate", () => {
  it("resolved: relative errorRate improvement >= RESOLVED_RELATIVE_IMPROVEMENT", () => {
    const baseline = { errorRate: 0.1, latencyP50: 200 };
    const outcome = {
      errorRate: baseline.errorRate * (1 - RESOLVED_RELATIVE_IMPROVEMENT - 0.05),
      latencyP50: 999999, // latency is not part of the verdict math — see evaluate.ts
    };
    expect(computeVerdict(baseline, outcome)).toBe("resolved");
  });

  it("improved: relative errorRate improvement between IMPROVED and RESOLVED thresholds", () => {
    const baseline = { errorRate: 0.1, latencyP50: 200 };
    const midImprovement = (IMPROVED_RELATIVE_IMPROVEMENT + RESOLVED_RELATIVE_IMPROVEMENT) / 2;
    const outcome = { errorRate: baseline.errorRate * (1 - midImprovement), latencyP50: 200 };
    expect(computeVerdict(baseline, outcome)).toBe("improved");
  });

  it("no-change: negligible movement either way", () => {
    const baseline = { errorRate: 0.1, latencyP50: 200 };
    const outcome = { errorRate: 0.099, latencyP50: 199 };
    expect(computeVerdict(baseline, outcome)).toBe("no-change");
  });

  it("regressed: got worse by more than REGRESSED_RELATIVE_WORSENING", () => {
    const baseline = { errorRate: 0.1, latencyP50: 200 };
    const worsening = REGRESSED_RELATIVE_WORSENING + 0.1;
    const outcome = { errorRate: baseline.errorRate * (1 + worsening), latencyP50: 200 };
    expect(computeVerdict(baseline, outcome)).toBe("regressed");
  });

  it("class targets (latencyP50 baseline 0, the not-applicable sentinel) still verdict correctly off errorRate", () => {
    const baseline = { errorRate: 0.5, latencyP50: 0 };
    const outcome = { errorRate: 0.1, latencyP50: 0 };
    expect(computeVerdict(baseline, outcome)).toBe("resolved");
  });

  it("treats a perfect (0) baseline errorRate as unable to regress unless outcome > 0", () => {
    const baseline = { errorRate: 0, latencyP50: 100 };
    expect(computeVerdict(baseline, { errorRate: 0, latencyP50: 100 })).toBe("no-change");
    expect(computeVerdict(baseline, { errorRate: 0.01, latencyP50: 100 })).toBe("regressed");
  });
});
