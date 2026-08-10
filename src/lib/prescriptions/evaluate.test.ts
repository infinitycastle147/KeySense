import { describe, expect, it } from "vitest";
import { evaluate, computeVerdict, computeLift } from "./evaluate";
import {
  RESOLVED_RELATIVE_IMPROVEMENT,
  IMPROVED_RELATIVE_IMPROVEMENT,
  REGRESSED_RELATIVE_WORSENING,
} from "./constants";
import type { Prescription } from "@/lib/types";
import type { TestAnalysis } from "@/lib/analysis/profile";
import { makeTestAnalysis } from "@/lib/analysis/test-utils";

function prescription(overrides: Partial<Prescription> = {}): Prescription {
  return {
    id: "rx-1",
    reportId: "report-1",
    targetType: "bigram",
    targets: ["th"],
    drillConfig: { wordCount: 40, targetRatio: 0.7, corpus: "english_5k" },
    baseline: { errorRate: 0.084, latencyP50: 210, n: 340 },
    outcome: null,
    control: null,
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
  return makeTestAnalysis({
    testId: `t-${endedAt}`,
    endedAt,
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
  });
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

// ---------------------------------------------------------------------------
// Difference-in-differences — the regression-to-the-mean correction
// ---------------------------------------------------------------------------

/** A TestAnalysis carrying several bigrams at once, so a treated set and its
 *  hold-out can be measured from the same window — which is the whole point:
 *  any difference in *how* the two are measured would show up as a treatment
 *  effect that isn't there. */
function multiBigramAnalysis(
  endedAt: string,
  rows: { bigram: string; n: number; errorRate: number }[],
): TestAnalysis {
  const base = bigramAnalysis(endedAt, "unused", 0, 0, 0);
  return {
    ...base,
    bigramStats: rows.map((r) => ({
      bigram: r.bigram,
      n: r.n,
      errors: Math.round(r.errorRate * r.n),
      errorRate: r.errorRate,
      errorRateCI: { low: 0, high: 1 },
      latencyP50: 200,
      sameFinger: false,
    })),
  };
}

/** Treated and control both start at the same badness, as two draws from the
 *  same tail of the same ranking. */
const CONTROLLED = {
  targets: ["th"],
  control: {
    targets: ["ol"],
    baseline: { errorRate: 0.1, latencyP50: 200, n: 200 },
    outcome: null,
  },
  baseline: { errorRate: 0.1, latencyP50: 200, n: 200 },
  createdAt: "2026-08-01T00:00:00.000Z",
};

describe("evaluate — hold-out control and lift", () => {
  it("PLACEBO: an improvement the untreated control matches exactly is not a win", () => {
    // This is the failure the control exists to catch. Under a bare pre/post
    // rule this same data reads "resolved" — a 60% drop in error rate — but
    // the untreated hold-out fell just as far, so none of it is attributable.
    const rx = prescription(CONTROLLED);
    const result = evaluate(rx, [
      multiBigramAnalysis("2026-08-05T00:00:00.000Z", [
        { bigram: "th", n: 200, errorRate: 0.04 }, // treated: -60%
        { bigram: "ol", n: 200, errorRate: 0.04 }, // control: -60%, untouched
      ]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.controlled).toBe(true);
    expect(result.lift).toBeCloseTo(0, 5);
    expect(result.verdict).toBe("no-change");
    // …and confirm the uncorrected rule would indeed have overclaimed here.
    expect(computeVerdict(rx.baseline, result.outcome)).toBe("resolved");
  });

  it("credits only the improvement beyond what the control drifted", () => {
    const rx = prescription(CONTROLLED);
    const result = evaluate(rx, [
      multiBigramAnalysis("2026-08-05T00:00:00.000Z", [
        { bigram: "th", n: 200, errorRate: 0.03 }, // treated: -70%
        { bigram: "ol", n: 200, errorRate: 0.09 }, // control: -10%
      ]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lift).toBeCloseTo(0.6, 5); // 0.70 - 0.10
    expect(result.verdict).toBe("resolved");
  });

  it("a control that got worse while the target held steady is a real gain", () => {
    const rx = prescription(CONTROLLED);
    const result = evaluate(rx, [
      multiBigramAnalysis("2026-08-05T00:00:00.000Z", [
        { bigram: "th", n: 200, errorRate: 0.1 }, // treated: flat
        { bigram: "ol", n: 200, errorRate: 0.14 }, // control: -40% (worse)
      ]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lift).toBeCloseTo(0.4, 5);
    // 0.4 attributable — a real gain, but short of RESOLVED_RELATIVE_IMPROVEMENT.
    expect(result.verdict).toBe("improved");
    // Pre/post alone would have called a completely flat target "no-change".
    expect(computeVerdict(rx.baseline, result.outcome)).toBe("no-change");
  });

  it("regression is judged against the control too, not in absolute terms", () => {
    const rx = prescription(CONTROLLED);
    const result = evaluate(rx, [
      multiBigramAnalysis("2026-08-05T00:00:00.000Z", [
        { bigram: "th", n: 200, errorRate: 0.09 }, // treated: -10%
        { bigram: "ol", n: 200, errorRate: 0.05 }, // control: -50%
      ]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lift).toBeCloseTo(-0.4, 5);
    expect(result.verdict).toBe("regressed");
  });

  it("falls back to pre/post — and says so — when the control is below MIN_FINDING_N", () => {
    const rx = prescription(CONTROLLED);
    const result = evaluate(rx, [
      multiBigramAnalysis("2026-08-05T00:00:00.000Z", [
        { bigram: "th", n: 200, errorRate: 0.04 },
        { bigram: "ol", n: 4, errorRate: 0.0 }, // too few to compare against
      ]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.controlled).toBe(false);
    expect(result.lift).toBeNull();
    expect(result.controlOutcome).toBeNull();
    expect(result.verdict).toBe("resolved"); // uncontrolled rule, honestly labelled
  });

  it("a prescription with no control evaluates uncontrolled", () => {
    const rx = prescription({ createdAt: "2026-08-01T00:00:00.000Z" });
    const result = evaluate(rx, [bigramAnalysis("2026-08-05T00:00:00.000Z", "th", 340, 0.031, 178)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.controlled).toBe(false);
    expect(result.lift).toBeNull();
  });

  it("measures the control over the same post-createdAt window as the target", () => {
    const rx = prescription(CONTROLLED);
    const result = evaluate(rx, [
      // Pre-treatment noise on the control must be excluded exactly as it is
      // for the target — otherwise the two sides span different windows and
      // the subtraction stops meaning anything.
      multiBigramAnalysis("2026-07-01T00:00:00.000Z", [{ bigram: "ol", n: 900, errorRate: 0.9 }]),
      multiBigramAnalysis("2026-08-05T00:00:00.000Z", [
        { bigram: "th", n: 200, errorRate: 0.04 },
        { bigram: "ol", n: 200, errorRate: 0.04 },
      ]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.controlOutcome?.n).toBe(200);
    expect(result.lift).toBeCloseTo(0, 5);
  });
});

describe("computeLift", () => {
  it("is the difference of two relative improvements", () => {
    const lift = computeLift(
      { baseline: { errorRate: 0.1 }, outcome: { errorRate: 0.05 } }, // -50%
      { baseline: { errorRate: 0.2 }, outcome: { errorRate: 0.16 } }, // -20%
    );
    expect(lift).toBeCloseTo(0.3, 5);
  });

  it("is zero when both sides move by the same proportion from different starts", () => {
    const lift = computeLift(
      { baseline: { errorRate: 0.1 }, outcome: { errorRate: 0.05 } },
      { baseline: { errorRate: 0.4 }, outcome: { errorRate: 0.2 } },
    );
    expect(lift).toBeCloseTo(0, 5);
  });
});
