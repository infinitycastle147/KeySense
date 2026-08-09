import { describe, expect, it } from "vitest";
import { computeFingerStats } from "./fingers";
import { charEvent, loadLayoutIndex } from "./test-utils";
import { MIN_FINDING_N } from "./stats";

const qwerty = loadLayoutIndex("qwerty");

describe("computeFingerStats", () => {
  it("returns [] for empty input", () => {
    expect(computeFingerStats([], qwerty)).toEqual([]);
  });

  it("single sample: n=1, no latency data, relativeLatency is the explicit 0 no-data sentinel", () => {
    const events = [charEvent({ t: 0, expected: "a", key: "a" })];
    const stats = computeFingerStats(events, qwerty);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ finger: "l-pinky", n: 1, errorRate: 0, latencyP50: 0, relativeLatency: 0 });
    expect(Number.isNaN(stats[0].relativeLatency)).toBe(false);
  });

  it("perfect input (zero errors) produces no NaN", () => {
    const events = Array.from({ length: 40 }, (_, i) => charEvent({ t: i * 140, expected: "j", key: "j" }));
    const stats = computeFingerStats(events, qwerty);
    const rIndex = stats.find((s) => s.finger === "r-index")!;
    expect(rIndex.errorRate).toBe(0);
    expect(Number.isNaN(rIndex.relativeLatency)).toBe(false);
    expect(rIndex.relativeLatency).toBeGreaterThan(0);
  });

  it("n below MIN_FINDING_N still returns a stat", () => {
    const events = Array.from({ length: 4 }, (_, i) => charEvent({ t: i * 100, expected: "k", key: "k" }));
    const stats = computeFingerStats(events, qwerty);
    expect(stats[0].n).toBeLessThan(MIN_FINDING_N);
  });

  it("all-outlier input: latency and relativeLatency collapse to 0, not NaN/Infinity", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 5000, expected: "a", key: "a" }),
      charEvent({ t: 12000, expected: "a", key: "a" }),
    ];
    const stats = computeFingerStats(events, qwerty);
    const pinky = stats.find((s) => s.finger === "l-pinky")!;
    expect(pinky.n).toBe(3);
    expect(pinky.latencyP50).toBe(0);
    expect(pinky.relativeLatency).toBe(0);
    expect(Number.isNaN(pinky.relativeLatency)).toBe(false);
  });

  it("computes relativeLatency against the overall median across all fingers, not a population norm", () => {
    // l-pinky ('a') is consistently slow (300ms intervals); r-index ('j') is
    // fast (100ms intervals). Equal interval counts (3 and 3) on each side so
    // the pooled overall median (200ms) lands strictly between them.
    const events = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 300, expected: "a", key: "a" }),
      charEvent({ t: 600, expected: "a", key: "a" }),
      charEvent({ t: 900, expected: "a", key: "a" }),
      charEvent({ t: 1000, expected: "j", key: "j" }),
      charEvent({ t: 1100, expected: "j", key: "j" }),
      charEvent({ t: 1200, expected: "j", key: "j" }),
    ];
    const stats = computeFingerStats(events, qwerty);
    const pinky = stats.find((s) => s.finger === "l-pinky")!;
    const index = stats.find((s) => s.finger === "r-index")!;
    expect(pinky.relativeLatency).toBeGreaterThan(1);
    expect(index.relativeLatency).toBeLessThan(1);
  });

  it("skips events whose expected character is not resolvable in the layout", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 100, expected: "é", key: "é" }), // not in qwerty.json
    ];
    const stats = computeFingerStats(events, qwerty);
    expect(stats).toHaveLength(1);
    expect(stats[0].finger).toBe("l-pinky");
  });
});
