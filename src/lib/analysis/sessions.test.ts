import { describe, expect, it } from "vitest";
import {
  assignSessions,
  computeWarmupCurve,
  segmentBy,
  devicesDiverge,
  SESSION_GAP_MS,
} from "./sessions";
import type { TestContext } from "./sessions";

function test(
  startedAt: string,
  { wpm = 80, deviceId = "laptop", accuracy = 0.97 } = {},
): TestContext {
  return { testId: startedAt, startedAt, deviceId, wpm, accuracy };
}

const T0 = new Date("2026-08-01T09:00:00.000Z").getTime();
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe("assignSessions", () => {
  it("groups tests taken close together into one sitting", () => {
    const positioned = assignSessions([test(at(0)), test(at(60_000)), test(at(120_000))]);
    expect(positioned.map((p) => p.sessionIndex)).toEqual([0, 0, 0]);
    expect(positioned.map((p) => p.positionInSession)).toEqual([0, 1, 2]);
  });

  it("starts a new sitting after a long enough gap", () => {
    const positioned = assignSessions([test(at(0)), test(at(SESSION_GAP_MS + 1000))]);
    expect(positioned.map((p) => p.sessionIndex)).toEqual([0, 1]);
    expect(positioned.map((p) => p.positionInSession)).toEqual([0, 0]);
  });

  it("sorts oldest-first, so position 0 always means the warm-up test", () => {
    // History queries return newest-first; silently inheriting that order would
    // make "the first test of a sitting" mean the last one.
    const positioned = assignSessions([test(at(120_000)), test(at(0)), test(at(60_000))]);
    expect(positioned.map((p) => p.startedAt)).toEqual([at(0), at(60_000), at(120_000)]);
    expect(positioned[0].positionInSession).toBe(0);
  });

  it("handles a single test", () => {
    expect(assignSessions([test(at(0))])[0]).toMatchObject({
      sessionIndex: 0,
      positionInSession: 0,
    });
  });

  it("handles an empty list", () => {
    expect(assignSessions([])).toEqual([]);
  });
});

describe("computeWarmupCurve", () => {
  it("detects that the first test of a sitting is reliably slower", () => {
    // Three sittings, each starting slow and settling.
    const tests: TestContext[] = [];
    for (let session = 0; session < 3; session++) {
      const base = session * (SESSION_GAP_MS * 2);
      tests.push(test(at(base), { wpm: 70 }));
      tests.push(test(at(base + 60_000), { wpm: 85 }));
      tests.push(test(at(base + 120_000), { wpm: 86 }));
    }

    const curve = computeWarmupCurve(assignSessions(tests));
    expect(curve.wpmByPosition[0]).toBe(70);
    expect(curve.warmupRatio.value).toBeLessThan(1);
  });

  it("reports no warm-up effect for a typist who starts at full speed", () => {
    const tests = [test(at(0), { wpm: 85 }), test(at(60_000), { wpm: 85 })];
    expect(computeWarmupCurve(assignSessions(tests)).warmupRatio.value).toBe(1);
  });

  it("carries n per position and gates on MIN_FINDING_N", () => {
    const curve = computeWarmupCurve(assignSessions([test(at(0))]));
    expect(curve.nByPosition[0]).toBe(1);
    expect(curve.warmupRatio.reportable).toBe(false);
  });
});

describe("segmentBy and devicesDiverge", () => {
  const mixed = assignSessions([
    ...Array.from({ length: 5 }, (_, i) => test(at(i * 60_000), { deviceId: "laptop", wpm: 70 })),
    ...Array.from({ length: 5 }, (_, i) =>
      test(at(SESSION_GAP_MS * 2 + i * 60_000), { deviceId: "desktop", wpm: 95 }),
    ),
  ]);

  it("splits a window by device", () => {
    const segments = segmentBy(mixed, (t) => t.deviceId);
    expect(segments.map((s) => s.key).sort()).toEqual(["desktop", "laptop"]);
    expect(segments.find((s) => s.key === "desktop")!.medianWpm).toBe(95);
  });

  it("flags devices that are too different to share a baseline", () => {
    // 70 vs 95 WPM is not one typist's natural variation — it is two keyboards.
    expect(devicesDiverge(segmentBy(mixed, (t) => t.deviceId))).toBe(true);
  });

  it("does not flag a single device", () => {
    const single = assignSessions([test(at(0)), test(at(60_000)), test(at(120_000))]);
    expect(devicesDiverge(segmentBy(single, (t) => t.deviceId))).toBe(false);
  });

  it("ignores devices with too little data to compare", () => {
    const lopsided = assignSessions([
      ...Array.from({ length: 5 }, (_, i) => test(at(i * 60_000), { wpm: 80 })),
      test(at(600_000), { deviceId: "phone", wpm: 20 }),
    ]);
    expect(devicesDiverge(segmentBy(lopsided, (t) => t.deviceId))).toBe(false);
  });

  it("segments by hour of day", () => {
    const segments = segmentBy(mixed, (t) => String(t.hourOfDay));
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => s.n > 0)).toBe(true);
  });
});
