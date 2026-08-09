import { describe, expect, it } from "vitest";
import { computeKeyStats } from "./keys";
import { charEvent, deleteEvent } from "./test-utils";
import { MIN_FINDING_N } from "./stats";

describe("computeKeyStats", () => {
  it("returns [] for empty input", () => {
    expect(computeKeyStats([])).toEqual([]);
  });

  it("handles a single sample without NaN, and reports latency 0 (no preceding interval)", () => {
    const events = [charEvent({ t: 100, expected: "a", key: "a" })];
    const stats = computeKeyStats(events);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ key: "a", n: 1, errors: 0, latencyP50: 0, latencyP90: 0 });
    expect(Number.isNaN(stats[0].errorRate)).toBe(false);
    expect(stats[0].errorRateCI.low).toBeGreaterThanOrEqual(0);
    expect(stats[0].errorRateCI.high).toBeLessThanOrEqual(1);
  });

  it("perfect input (zero errors) produces no NaN and a tight-ish CI toward 0", () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      charEvent({ t: i * 150, expected: "j", key: "j" })
    );
    const stats = computeKeyStats(events);
    const j = stats.find((s) => s.key === "j")!;
    expect(j.errors).toBe(0);
    expect(j.errorRate).toBe(0);
    expect(Number.isNaN(j.errorRateCI.low)).toBe(false);
    expect(Number.isNaN(j.errorRateCI.high)).toBe(false);
    expect(j.errorRateCI.low).toBe(0);
    expect(j.latencyP50).toBeGreaterThan(0);
  });

  it("n below MIN_FINDING_N still returns a stat (gating happens downstream, not here)", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      charEvent({ t: i * 100, expected: "q", key: i === 0 ? "w" : "q" })
    );
    const stats = computeKeyStats(events);
    const q = stats.find((s) => s.key === "q")!;
    expect(q.n).toBe(5);
    expect(q.n).toBeLessThan(MIN_FINDING_N);
    // Wide CI at low n is exactly why callers must gate on n, not on the CI shape.
    expect(q.errorRateCI.high - q.errorRateCI.low).toBeGreaterThan(0.3);
  });

  it("all-outlier input: n/errors stay correct, latency collapses to 0 rather than NaN", () => {
    const events = [
      charEvent({ t: 0, expected: "k", key: "k" }),
      charEvent({ t: 2000, expected: "k", key: "x" }), // 2000ms gap, > OUTLIER_MS
      charEvent({ t: 5000, expected: "k", key: "k" }), // another huge gap
    ];
    const stats = computeKeyStats(events);
    const k = stats.find((s) => s.key === "k")!;
    expect(k.n).toBe(3);
    expect(k.errors).toBe(1);
    expect(k.latencyP50).toBe(0);
    expect(k.latencyP90).toBe(0);
    expect(Number.isNaN(k.latencyP50)).toBe(false);
  });

  it("discards outlier intervals but keeps valid ones for the same key", () => {
    const events = [
      charEvent({ t: 0, expected: "l", key: "l" }),
      charEvent({ t: 150, expected: "l", key: "l" }), // valid 150ms
      charEvent({ t: 2500, expected: "l", key: "l" }), // outlier gap, discarded
      charEvent({ t: 2650, expected: "l", key: "l" }), // valid 150ms
    ];
    const stats = computeKeyStats(events);
    const l = stats.find((s) => s.key === "l")!;
    expect(l.n).toBe(4);
    expect(l.latencyP50).toBe(150);
  });

  it("groups by expected character, ignores backspace/word-delete events", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      deleteEvent({ t: 100, kind: "backspace" }),
      charEvent({ t: 200, expected: "b", key: "x" }),
    ];
    const stats = computeKeyStats(events);
    expect(stats.map((s) => s.key).sort()).toEqual(["a", "b"]);
    const b = stats.find((s) => s.key === "b")!;
    expect(b.errors).toBe(1);
    expect(b.errorRate).toBe(1);
  });
});
