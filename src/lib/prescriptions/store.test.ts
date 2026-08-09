import { describe, expect, it } from "vitest";
import { rowToPrescription, prescriptionToInsertRow } from "./store";
import type { Prescription } from "@/lib/types";

describe("rowToPrescription", () => {
  it("maps snake_case columns to the camelCase Prescription shape", () => {
    const row = {
      id: "rx-1",
      user_id: "user-1",
      report_id: "report-1",
      target_type: "sfb",
      targets: ["ol", "ju"],
      drill_config: { wordCount: 40, targetRatio: 0.7, corpus: "english_5k" },
      baseline: { errorRate: 0.084, latencyP50: 210, n: 340 },
      outcome: null,
      verdict: null,
      status: "active",
      drills_target: 5,
      drills_done: 2,
      created_at: "2026-08-01T00:00:00.000Z",
      completed_at: null,
    };

    const rx = rowToPrescription(row);
    expect(rx).toEqual({
      id: "rx-1",
      reportId: "report-1",
      targetType: "sfb",
      targets: ["ol", "ju"],
      drillConfig: { wordCount: 40, targetRatio: 0.7, corpus: "english_5k" },
      baseline: { errorRate: 0.084, latencyP50: 210, n: 340 },
      outcome: null,
      verdict: null,
      status: "active",
      drillsTarget: 5,
      drillsDone: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
      completedAt: null,
    });
  });
});

describe("prescriptionToInsertRow", () => {
  it("never includes an outcome/verdict column — those are only ever written by completePrescription", () => {
    const rx: Prescription = {
      id: "rx-1",
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
      createdAt: "2026-08-01T00:00:00.000Z",
      completedAt: null,
    };

    const row = prescriptionToInsertRow("user-1", rx);
    expect(row).not.toHaveProperty("outcome");
    expect(row).not.toHaveProperty("verdict");
    expect(row.baseline).toEqual({ errorRate: 0.084, latencyP50: 210, n: 340 });
    expect(row.user_id).toBe("user-1");
  });
});
