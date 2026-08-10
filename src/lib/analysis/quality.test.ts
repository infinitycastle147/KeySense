import { describe, expect, it } from "vitest";
import { computeQuality, isDistracted, DISTRACTED_DISCARD_RATE } from "./quality";
import { charEvent } from "./test-utils";
import type { KeyEvent } from "@/lib/types";

/** Keystrokes at the given inter-key gaps, in ms. */
function stream(gaps: number[]): KeyEvent[] {
  const events: KeyEvent[] = [charEvent({ t: 0, key: "a", expected: "a" })];
  let t = 0;
  for (const gap of gaps) {
    t += gap;
    events.push(charEvent({ t, key: "a", expected: "a" }));
  }
  return events;
}

describe("computeQuality", () => {
  it("reports a clean run as clean", () => {
    const q = computeQuality(stream([150, 160, 155, 148]), 1000);
    expect(q.discardRate).toBe(0);
    expect(q.pauseCount).toBe(0);
    expect(q.activeMs).toBe(1000);
  });

  it("counts the intervals the latency metrics silently threw away", () => {
    const q = computeQuality(stream([150, 4000, 160, 3000]), 10000);
    expect(q.intervalCount).toBe(4);
    expect(q.discardedCount).toBe(2);
    expect(q.discardRate).toBe(0.5);
  });

  it("measures pause time, which wall-clock duration alone hides", () => {
    const q = computeQuality(stream([150, 5000, 150]), 6000);
    expect(q.pauseMs).toBe(5000);
    expect(q.longestPauseMs).toBe(5000);
    expect(q.activeMs).toBe(1000);
  });

  it("reports a tempo unaffected by how often the typist stopped", () => {
    // Same typing speed, wildly different session shape.
    const steady = computeQuality(stream([150, 150, 150, 150]), 1000);
    const interrupted = computeQuality(stream([150, 9000, 150, 8000, 150]), 20000);
    expect(interrupted.activeMedianIki).toBeCloseTo(steady.activeMedianIki, 5);
  });

  it("ignores a negative interval rather than counting it as a pause", () => {
    const events: KeyEvent[] = [
      charEvent({ t: 500, key: "a", expected: "a" }),
      charEvent({ t: 100, key: "b", expected: "b" }),
    ];
    const q = computeQuality(events, 1000);
    expect(q.pauseCount).toBe(0);
    expect(q.intervalCount).toBe(0);
  });

  it("never reports negative active time", () => {
    expect(computeQuality(stream([9000]), 100).activeMs).toBe(0);
  });

  it("handles an empty stream", () => {
    const q = computeQuality([], 0);
    expect(q.intervalCount).toBe(0);
    expect(q.discardRate).toBe(0);
  });
});

describe("isDistracted", () => {
  it("flags a session that was substantially not typing", () => {
    const gaps = [...new Array(10).fill(150), ...new Array(4).fill(5000)];
    expect(isDistracted(computeQuality(stream(gaps), 30000))).toBe(true);
  });

  it("does not flag an occasional pause", () => {
    const gaps = [...new Array(60).fill(150), 5000];
    const q = computeQuality(stream(gaps), 20000);
    expect(q.discardRate).toBeLessThan(DISTRACTED_DISCARD_RATE);
    expect(isDistracted(q)).toBe(false);
  });

  it("does not flag a test with no intervals at all", () => {
    expect(isDistracted(computeQuality([], 0))).toBe(false);
  });
});
