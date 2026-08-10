import { describe, expect, it } from "vitest";
import { createPrescription, InsufficientBaselineError } from "./create";
import { evaluate } from "./evaluate";
import { DEFAULT_TARGET_RATIO } from "@/lib/drills/generate";
import type { TargetStat } from "./baseline";
import type { TestAnalysis } from "@/lib/analysis/profile";
import { makeTestAnalysis } from "@/lib/analysis/test-utils";
import { MIN_FINDING_N } from "@/lib/analysis/stats";

function reportableBaseline(overrides: Partial<TargetStat> = {}): TargetStat {
  return { errorRate: 0.084, latencyP50: 210, n: 340, reportable: true, ...overrides };
}

function input(overrides: Partial<Parameters<typeof createPrescription>[0]> = {}) {
  return {
    reportId: "report-1",
    targetType: "sfb" as const,
    targets: ["ol", "ju"],
    baseline: reportableBaseline(),
    now: () => "2026-08-01T00:00:00.000Z",
    id: () => "rx-1",
    ...overrides,
  };
}

describe("createPrescription — the baseline invariant", () => {
  it("records the exact baseline it was given", () => {
    const rx = createPrescription(input());
    expect(rx.baseline).toEqual({ errorRate: 0.084, latencyP50: 210, n: 340 });
  });

  it("throws InsufficientBaselineError rather than prescribing against noise", () => {
    expect(() =>
      createPrescription(input({ baseline: reportableBaseline({ reportable: false, n: 12 }) })),
    ).toThrow(InsufficientBaselineError);
  });

  it("baseline is a frozen snapshot, immune to later mutation of the caller's object", () => {
    const baseline = reportableBaseline();
    const rx = createPrescription(input({ baseline }));
    baseline.errorRate = 0.999;
    baseline.n = 1;
    expect(rx.baseline.errorRate).toBe(0.084);
    expect(rx.baseline.n).toBe(340);
  });

  it("nothing about creating the prescription itself can mutate the baseline object", () => {
    const rx = createPrescription(input());
    expect(() => {
      (rx.baseline as { errorRate: number }).errorRate = 999;
    }).toThrow();
    expect(rx.baseline.errorRate).toBe(0.084);
  });

  it("always mints DEFAULT_TARGET_RATIO — targetRatio is never a caller-supplied setting", () => {
    const rx = createPrescription(input());
    expect(rx.drillConfig.targetRatio).toBe(DEFAULT_TARGET_RATIO);
  });

  it("starts active, with drillsDone 0 and no outcome/verdict yet", () => {
    const rx = createPrescription(input());
    expect(rx.status).toBe("active");
    expect(rx.drillsDone).toBe(0);
    expect(rx.outcome).toBeNull();
    expect(rx.verdict).toBeNull();
    expect(rx.completedAt).toBeNull();
  });

  it("captures createdAt at creation time, from the injected clock", () => {
    const rx = createPrescription(input());
    expect(rx.createdAt).toBe("2026-08-01T00:00:00.000Z");
  });

  // The requirement from the phase brief, made concrete: create it, run the
  // rest of the lifecycle, and prove the baseline never moved.
  it("survives evaluate() unchanged — nothing later in the lifecycle updates the baseline", () => {
    const rx = createPrescription(input());
    const baselineSnapshot = { ...rx.baseline };

    const postAnalyses: TestAnalysis[] = [
      makeTestAnalysis({
        testId: "after-1",
        endedAt: "2026-09-01T00:00:00.000Z", // after createdAt
        result: {
          wpm: 70,
          rawWpm: 72,
          accuracy: 0.98,
          consistency: 85,
          charsCorrect: 200,
          charsIncorrect: 4,
          charsExtra: 0,
          charsMissed: 0,
        },
        bigramStats: [
          {
            bigram: "ol",
            n: MIN_FINDING_N * 2,
            errors: 2,
            errorRate: 0.03,
            errorRateCI: { low: 0, high: 1 },
            latencyP50: 190,
            sameFinger: true,
          },
        ],
      }),
    ];

    const result = evaluate(rx, postAnalyses);
    expect(result.ok).toBe(true);

    // The object returned by createPrescription is untouched — evaluate()
    // returns a separate result, it does not write back into `rx`.
    expect(rx.baseline).toEqual(baselineSnapshot);
    expect(rx.outcome).toBeNull();
    expect(rx.verdict).toBeNull();
  });
});
