import { describe, expect, it } from "vitest";
import { computeFatigueCurve } from "./fatigue";
import { charEvent } from "./test-utils";

describe("computeFatigueCurve", () => {
  it("returns [] when durationMs is 0", () => {
    expect(computeFatigueCurve([], 0)).toEqual([]);
  });

  it("returns [] for empty events with no duration", () => {
    expect(computeFatigueCurve([], -1)).toEqual([]);
  });

  it("empty events with a real duration still returns zeroed buckets, not []", () => {
    const buckets = computeFatigueCurve([], 20000, 10);
    expect(buckets).toHaveLength(2);
    expect(buckets.every((b) => b.wpm === 0 && b.n === 0)).toBe(true);
    expect(buckets.every((b) => !Number.isNaN(b.wpm))).toBe(true);
  });

  it("single sample lands in exactly one bucket without NaN", () => {
    const buckets = computeFatigueCurve([charEvent({ t: 500, expected: "a", key: "a" })], 10000, 10);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].n).toBe(1);
    expect(Number.isNaN(buckets[0].wpm)).toBe(false);
  });

  it("perfect input (zero errors): wpm reflects all-correct typing, no NaN", () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      charEvent({ t: i * 200, expected: "a", key: "a" })
    );
    const buckets = computeFatigueCurve(events, 10000, 10);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].wpm).toBeGreaterThan(0);
    expect(Number.isNaN(buckets[0].wpm)).toBe(false);
  });

  it("a bucket with only errors scores 0 wpm, not NaN, while n still reflects attempts", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      charEvent({ t: i * 100, expected: "a", key: "z" })
    );
    const buckets = computeFatigueCurve(events, 5000, 10);
    expect(buckets[0].n).toBe(10);
    expect(buckets[0].wpm).toBe(0);
  });

  it("events outside [0, durationMs] are excluded", () => {
    const events = [
      charEvent({ t: -50, expected: "a", key: "a" }),
      charEvent({ t: 999999, expected: "a", key: "a" }),
    ];
    const buckets = computeFatigueCurve(events, 5000, 10);
    expect(buckets.reduce((sum, b) => sum + b.n, 0)).toBe(0);
  });

  it("a partial final bucket is not treated as full-length (no wpm under-reporting)", () => {
    // duration is 12s with a 10s bucket size: bucket 1 spans [10000, 12000) = 2s, not 10s.
    const events = [charEvent({ t: 10500, expected: "a", key: "a" })];
    const buckets = computeFatigueCurve(events, 12000, 10);
    expect(buckets).toHaveLength(2);
    expect(buckets[1].endMs - buckets[1].startMs).toBe(2000);
  });
});
