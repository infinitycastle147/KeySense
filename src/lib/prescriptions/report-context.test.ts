import { describe, expect, it } from "vitest";
import { buildPrescriptionReportContext } from "./report-context";
import type { Prescription } from "@/lib/types";

function rx(overrides: Partial<Prescription>): Prescription {
  return {
    id: "rx",
    reportId: null,
    targetType: "bigram",
    targets: ["th"],
    drillConfig: { wordCount: 40, targetRatio: 0.7, corpus: "english_5k" },
    baseline: { errorRate: 0.084, latencyP50: 210, n: 340 },
    outcome: null,
    verdict: null,
    status: "active",
    drillsTarget: 5,
    drillsDone: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("buildPrescriptionReportContext", () => {
  it("returns null lastCompleted and empty active for no prescriptions", () => {
    expect(buildPrescriptionReportContext([])).toEqual({ lastCompleted: null, active: [] });
  });

  it("picks the MOST RECENTLY completed prescription, not just any completed one", () => {
    const older = rx({
      id: "old",
      status: "completed",
      verdict: "improved",
      outcome: { errorRate: 0.05, latencyP50: 190, n: 100 },
      completedAt: "2026-02-01T00:00:00.000Z",
    });
    const newer = rx({
      id: "new",
      status: "completed",
      verdict: "resolved",
      outcome: { errorRate: 0.031, latencyP50: 178, n: 340 },
      baseline: { errorRate: 0.084, latencyP50: 210, n: 340 },
      completedAt: "2026-03-01T00:00:00.000Z",
    });

    const ctx = buildPrescriptionReportContext([older, newer]);
    expect(ctx.lastCompleted?.completedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(ctx.lastCompleted?.verdict).toBe("resolved");
    expect(ctx.lastCompleted?.baselineErrorRate).toBe(0.084);
    expect(ctx.lastCompleted?.outcomeErrorRate).toBe(0.031);
  });

  it("ignores completed-in-name-only rows missing outcome/verdict/completedAt", () => {
    const broken = rx({ status: "completed" }); // outcome/verdict/completedAt all still null
    expect(buildPrescriptionReportContext([broken]).lastCompleted).toBeNull();
  });

  it("lists every active prescription, not just the most recent", () => {
    const a = rx({ id: "a", status: "active", targets: ["th"] });
    const b = rx({ id: "b", status: "active", targets: ["er"] });
    const ctx = buildPrescriptionReportContext([a, b]);
    expect(ctx.active).toHaveLength(2);
    expect(ctx.active.map((p) => p.targets[0])).toEqual(["th", "er"]);
  });

  it("excludes abandoned prescriptions from both lastCompleted and active", () => {
    const abandoned = rx({ status: "abandoned" });
    const ctx = buildPrescriptionReportContext([abandoned]);
    expect(ctx.lastCompleted).toBeNull();
    expect(ctx.active).toHaveLength(0);
  });
});
