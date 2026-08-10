import { describe, expect, it } from "vitest";
import { computeUsage, computeAdherence } from "./usage";
import type { TestContext } from "./sessions";
import type { Prescription } from "@/lib/types";

function test(startedAt: string): TestContext {
  return { testId: startedAt, startedAt, deviceId: "laptop", wpm: 80, accuracy: 0.97 };
}

function onDay(day: string, hour = 9): TestContext {
  return test(`2026-08-${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
}

function rx(over: Partial<Prescription>): Prescription {
  return {
    id: "rx",
    reportId: null,
    targetType: "bigram",
    targets: ["th"],
    drillConfig: { wordCount: 40, targetRatio: 0.7, corpus: "english_5k" },
    baseline: { errorRate: 0.1, latencyP50: 200, n: 100 },
    outcome: null,
    control: null,
    verdict: null,
    status: "active",
    drillsTarget: 5,
    drillsDone: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: null,
    ...over,
  };
}

describe("computeUsage", () => {
  it("counts days actually used against the period they span", () => {
    const usage = computeUsage([onDay("01"), onDay("02"), onDay("05")]);
    expect(usage.activeDays).toBe(3);
    expect(usage.spanDays).toBe(5);
    expect(usage.consistency).toBeCloseTo(0.6, 5);
  });

  it("measures the longest run of consecutive days", () => {
    const usage = computeUsage([onDay("01"), onDay("02"), onDay("03"), onDay("07")]);
    expect(usage.longestStreak).toBe(3);
  });

  it("measures the streak ending at the most recent day, not at today", () => {
    // Pure module, no clock. A caller that wants "still alive" compares the
    // last active day against today itself.
    const usage = computeUsage([onDay("01"), onDay("05"), onDay("06")]);
    expect(usage.currentStreak).toBe(2);
  });

  it("separates sessions from tests", () => {
    const usage = computeUsage([onDay("01", 9), onDay("01", 9), onDay("01", 20)]);
    expect(usage.testCount).toBe(3);
    expect(usage.sessionCount).toBe(2);
  });

  it("returns zeros for no tests rather than dividing by zero", () => {
    const usage = computeUsage([]);
    expect(usage.consistency).toBe(0);
    expect(usage.longestStreak).toBe(0);
  });

  it("treats a single day as a span of one, not zero", () => {
    const usage = computeUsage([onDay("01")]);
    expect(usage.spanDays).toBe(1);
    expect(usage.consistency).toBe(1);
  });
});

describe("computeAdherence", () => {
  it("separates a failed diagnosis from an untaken prescription", () => {
    // Five prescriptions, barely any drills done. A scorecard full of
    // "no-change" here is a compliance story, not an analysis failure.
    const stats = computeAdherence([
      rx({ drillsDone: 1 }),
      rx({ drillsDone: 0 }),
      rx({ drillsDone: 1 }),
      rx({ drillsDone: 0 }),
      rx({ drillsDone: 1 }),
    ]);
    expect(stats.completionRate).toBeCloseTo(3 / 25, 5);
  });

  it("reports full adherence when every drill was done", () => {
    const stats = computeAdherence([rx({ drillsDone: 5, status: "completed" })]);
    expect(stats.completionRate).toBe(1);
  });

  it("caps adherence at 1 — over-drilling is not 130% adherence", () => {
    expect(computeAdherence([rx({ drillsDone: 9 })]).completionRate).toBe(1);
  });

  it("measures follow-through over finished prescriptions only", () => {
    const stats = computeAdherence([
      rx({ status: "completed" }),
      rx({ status: "abandoned" }),
      rx({ status: "active" }),
    ]);
    expect(stats.followThroughRate).toBe(0.5);
    expect(stats.active).toBe(1);
  });

  it("returns zeros for no prescriptions", () => {
    expect(computeAdherence([])).toMatchObject({ completionRate: 0, followThroughRate: 0 });
  });
});
