import { describe, expect, it } from "vitest";
import { computeRhythm } from "./rhythm";
import { charEvent } from "./test-utils";
import { MIN_FINDING_N } from "./stats";

describe("computeRhythm", () => {
  it("returns an all-zero, non-NaN result for empty input", () => {
    const result = computeRhythm([]);
    expect(result).toEqual({
      n: 0,
      medianIki: 0,
      madIki: 0,
      coefficientOfVariation: 0,
      burstCount: 0,
      stallCount: 0,
    });
  });

  it("single sample has no intervals to measure", () => {
    const result = computeRhythm([charEvent({ t: 0, expected: "a", key: "a" })]);
    expect(result.n).toBe(0);
    expect(result.medianIki).toBe(0);
    expect(Number.isNaN(result.coefficientOfVariation)).toBe(false);
  });

  it("perfect steady rhythm (zero errors, uniform intervals): no bursts/stalls, no NaN", () => {
    const events = Array.from({ length: 40 }, (_, i) => charEvent({ t: i * 120, expected: "a", key: "a" }));
    const result = computeRhythm(events);
    expect(result.n).toBe(39);
    expect(result.medianIki).toBe(120);
    expect(result.madIki).toBe(0); // perfectly uniform -> zero deviation
    expect(result.burstCount).toBe(0);
    expect(result.stallCount).toBe(0);
    expect(Number.isNaN(result.coefficientOfVariation)).toBe(false);
  });

  it("n below MIN_FINDING_N still computes a result", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 100, expected: "a", key: "a" }),
      charEvent({ t: 220, expected: "a", key: "a" }),
    ];
    const result = computeRhythm(events);
    expect(result.n).toBe(2);
    expect(result.n).toBeLessThan(MIN_FINDING_N);
  });

  it("all-outlier input: every interval discarded, result is zeroed not NaN", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 2000, expected: "a", key: "a" }),
      charEvent({ t: 5000, expected: "a", key: "a" }),
    ];
    const result = computeRhythm(events);
    expect(result.n).toBe(0);
    expect(result.medianIki).toBe(0);
    expect(result.madIki).toBe(0);
    expect(result.burstCount).toBe(0);
    expect(result.stallCount).toBe(0);
  });

  it("flags a sharp stall against an otherwise steady rhythm", () => {
    // Small natural jitter (90/110ms alternating) keeps MAD > 0 so the
    // modified z-score is defined; a perfectly uniform rhythm (MAD=0) can't
    // support a z-score at all, which is covered by the steady-rhythm test.
    const events = [charEvent({ t: 0, expected: "a", key: "a" })];
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += i % 2 === 0 ? 90 : 110;
      events.push(charEvent({ t, expected: "a", key: "a" }));
    }
    // one dramatically slower keystroke, still under OUTLIER_MS
    t += 900;
    events.push(charEvent({ t, expected: "a", key: "a" }));
    for (let i = 0; i < 10; i++) {
      t += i % 2 === 0 ? 90 : 110;
      events.push(charEvent({ t, expected: "a", key: "a" }));
    }
    const result = computeRhythm(events);
    expect(result.stallCount).toBeGreaterThan(0);
  });
});
