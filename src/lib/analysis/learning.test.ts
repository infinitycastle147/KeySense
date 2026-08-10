import { describe, expect, it } from "vitest";
import { computeLearningCurve, MIN_CURVE_POINTS } from "./learning";
import type { SeriesPoint } from "./learning";

function series(values: number[], n = 50): SeriesPoint[] {
  return values.map((value, i) => ({
    at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    value,
    n,
  }));
}

describe("computeLearningCurve", () => {
  it("reports a negative slope for a target that is improving", () => {
    const curve = computeLearningCurve(series([0.2, 0.18, 0.15, 0.12, 0.1, 0.08]));
    expect(curve.slope).toBeLessThan(0);
    expect(curve.totalImprovement).toBeGreaterThan(0);
  });

  it("detects a plateau: improved once, now flat", () => {
    // The finding that says stop drilling this — it has given what it will give.
    const curve = computeLearningCurve(series([0.2, 0.15, 0.11, 0.09, 0.09, 0.088, 0.09, 0.089]));
    expect(curve.plateaued).toBe(true);
  });

  it("does not call a still-improving target a plateau", () => {
    const curve = computeLearningCurve(series([0.2, 0.17, 0.14, 0.11, 0.08, 0.05, 0.03]));
    expect(curve.plateaued).toBe(false);
  });

  it("does not call a target that never improved a plateau", () => {
    // Flat from the start is not a plateau — it is a target that never
    // responded, which calls for a different diagnosis, not for stopping.
    const curve = computeLearningCurve(series([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]));
    expect(curve.plateaued).toBe(false);
  });

  it("orders by timestamp rather than trusting the caller's order", () => {
    const forward = computeLearningCurve(series([0.2, 0.15, 0.1, 0.08, 0.06, 0.05]));
    const shuffled = computeLearningCurve(
      [...series([0.2, 0.15, 0.1, 0.08, 0.06, 0.05])].reverse(),
    );
    expect(shuffled.slope).toBeCloseTo(forward.slope, 10);
  });

  it("measures against repetitions, not calendar days", () => {
    // A fortnight's break must not register as a fortnight of flat learning.
    const points = series([0.2, 0.15, 0.1, 0.08, 0.06, 0.05]);
    points[3].at = "2026-09-20T00:00:00.000Z";
    points[4].at = "2026-09-21T00:00:00.000Z";
    points[5].at = "2026-09-22T00:00:00.000Z";
    expect(computeLearningCurve(points).slope).toBeLessThan(0);
  });

  it("smooths the endpoints instead of trusting two single observations", () => {
    // One freak final reading must not become the headline "improvement".
    const curve = computeLearningCurve(series([0.2, 0.19, 0.18, 0.17, 0.17, 0.001]));
    expect(curve.last).toBeGreaterThan(0.001);
  });

  it("is not reportable below MIN_CURVE_POINTS", () => {
    const curve = computeLearningCurve(series([0.2, 0.1, 0.05]));
    expect(curve.reportable).toBe(false);
    expect(MIN_CURVE_POINTS).toBeGreaterThan(3);
  });

  it("is not reportable when the underlying observations are too few", () => {
    expect(computeLearningCurve(series([0.2, 0.18, 0.15, 0.12, 0.1, 0.08], 2)).reportable).toBe(
      false,
    );
  });

  it("handles an empty series", () => {
    expect(computeLearningCurve([])).toMatchObject({ slope: 0, reportable: false });
  });
});
