import { describe, expect, it } from "vitest";
import { buildScorecard } from "./scorecard";
import type { Prescription, PrescriptionControl, TargetMeasurement } from "@/lib/types";

function rx(overrides: Partial<Prescription> = {}): Prescription {
  return {
    id: "rx",
    reportId: null,
    targetType: "bigram",
    targets: ["th"],
    drillConfig: { wordCount: 40, targetRatio: 0.7, corpus: "english_5k" },
    baseline: { errorRate: 0.1, latencyP50: 200, n: 200 },
    outcome: null,
    control: null,
    verdict: null,
    status: "active",
    drillsTarget: 5,
    drillsDone: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function measured(errorRate: number): TargetMeasurement {
  return { errorRate, latencyP50: 200, n: 200 };
}

function control(baseline: number, outcome: number | null): PrescriptionControl {
  return {
    targets: ["ol"],
    baseline: measured(baseline),
    outcome: outcome === null ? null : measured(outcome),
  };
}

describe("buildScorecard", () => {
  it("reports no lift at all rather than 0 when nothing controlled has completed", () => {
    // 0 would read as "the diagnosis does nothing"; the truth is "no evidence
    // either way yet", and the two must not look the same.
    const card = buildScorecard([rx(), rx({ outcome: measured(0.05), verdict: "resolved" })]);
    expect(card.medianLift).toBeNull();
    expect(card.medianRawImprovement).toBeNull();
    expect(card.controlled).toBe(0);
  });

  it("counts only prescriptions that actually have a verdict", () => {
    const card = buildScorecard([
      rx(),
      rx({ outcome: measured(0.05), verdict: "resolved" }),
      rx({ outcome: measured(0.09), verdict: "no-change" }),
    ]);
    expect(card.total).toBe(3);
    expect(card.evaluated).toBe(2);
    expect(card.byVerdict).toEqual({ resolved: 1, improved: 0, "no-change": 1, regressed: 0 });
  });

  it("keeps controlled and uncontrolled verdicts separate", () => {
    const card = buildScorecard([
      rx({ outcome: measured(0.05), verdict: "resolved", control: control(0.1, 0.05) }),
      rx({ outcome: measured(0.05), verdict: "resolved" }),
    ]);
    expect(card.controlled).toBe(1);
    expect(card.uncontrolled).toBe(1);
  });

  it("exposes the gap between raw improvement and attributable lift", () => {
    // Both targets halved their error rate — and so did both untreated
    // controls. A pre/post scoreboard would show two resounding wins; the
    // scorecard shows a median lift of zero, which is the honest reading.
    const card = buildScorecard([
      rx({ outcome: measured(0.05), verdict: "no-change", control: control(0.1, 0.05) }),
      rx({
        baseline: measured(0.2),
        outcome: measured(0.1),
        verdict: "no-change",
        control: control(0.2, 0.1),
      }),
    ]);
    expect(card.medianLift).toBeCloseTo(0, 5);
    expect(card.medianRawImprovement).toBeCloseTo(0.5, 5);
  });

  it("uses a median so one collapsed control cannot carry the scorecard", () => {
    const card = buildScorecard([
      rx({ outcome: measured(0.09), verdict: "no-change", control: control(0.1, 0.09) }),
      rx({ outcome: measured(0.09), verdict: "no-change", control: control(0.1, 0.09) }),
      // Control's error rate exploded, manufacturing a huge apparent lift.
      rx({ outcome: measured(0.09), verdict: "resolved", control: control(0.1, 0.9) }),
    ]);
    expect(card.medianLift).toBeCloseTo(0, 5);
  });

  it("ignores a control that was never measured at outcome time", () => {
    const card = buildScorecard([
      rx({ outcome: measured(0.05), verdict: "resolved", control: control(0.1, null) }),
    ]);
    expect(card.controlled).toBe(0);
    expect(card.uncontrolled).toBe(1);
    expect(card.medianLift).toBeNull();
  });

  it("handles an empty list without inventing numbers", () => {
    const card = buildScorecard([]);
    expect(card).toEqual({
      total: 0,
      evaluated: 0,
      byVerdict: { resolved: 0, improved: 0, "no-change": 0, regressed: 0 },
      controlled: 0,
      uncontrolled: 0,
      medianLift: null,
      medianRawImprovement: null,
    });
  });
});
