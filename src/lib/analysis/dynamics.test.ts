import { describe, expect, it } from "vitest";
import { computeDynamics, pairDwells } from "./dynamics";
import { charEvent } from "./test-utils";
import type { KeyEvent, KeyUpEvent } from "@/lib/types";

/**
 * Builds a keystroke sequence with explicit dwell and flight, so the two are
 * independently controllable — which is the whole point of capturing releases.
 */
function sequence(
  keys: string[],
  { dwell, flight }: { dwell: number; flight: number },
): { events: KeyEvent[]; keyups: KeyUpEvent[] } {
  const events: KeyEvent[] = [];
  const keyups: KeyUpEvent[] = [];
  let down = 0;

  for (const key of keys) {
    events.push(charEvent({ t: down, key, expected: key }));
    keyups.push({ t: down + dwell, key });
    down = down + dwell + flight;
  }

  return { events, keyups };
}

describe("pairDwells", () => {
  it("matches each press to its own release", () => {
    const { events, keyups } = sequence(["a", "b"], { dwell: 90, flight: 60 });
    expect(pairDwells(events, keyups).map((p) => p.dwell)).toEqual([90, 90]);
  });

  it("matches by key identity, not by order — releases arrive out of order when keys overlap", () => {
    // 'a' goes down, 'b' goes down while 'a' is still held, then 'a' releases
    // after 'b'. Index-based matching would pair a->b's release and get this
    // exactly backwards, erasing the rollover it is meant to detect.
    const events: KeyEvent[] = [
      charEvent({ t: 0, key: "a", expected: "a" }),
      charEvent({ t: 50, key: "b", expected: "b" }),
    ];
    const keyups: KeyUpEvent[] = [
      { t: 60, key: "b" },
      { t: 80, key: "a" },
    ];
    const pairs = pairDwells(events, keyups);
    expect(pairs.map((p) => p.dwell)).toEqual([80, 10]);
  });

  it("consumes each release once, so a repeated key pairs in order", () => {
    const events: KeyEvent[] = [
      charEvent({ t: 0, key: "l", expected: "l" }),
      charEvent({ t: 100, key: "l", expected: "l" }),
    ];
    const keyups: KeyUpEvent[] = [
      { t: 40, key: "l" },
      { t: 150, key: "l" },
    ];
    expect(pairDwells(events, keyups).map((p) => p.dwell)).toEqual([40, 50]);
  });

  it("drops a press with no matching release rather than guessing a dwell", () => {
    const events: KeyEvent[] = [
      charEvent({ t: 0, key: "a", expected: "a" }),
      charEvent({ t: 100, key: "b", expected: "b" }),
    ];
    expect(pairDwells(events, [{ t: 40, key: "a" }])).toHaveLength(1);
  });

  it("discards a hold longer than the outlier threshold", () => {
    const events = [charEvent({ t: 0, key: "a", expected: "a" })];
    expect(pairDwells(events, [{ t: 5000, key: "a" }])).toEqual([]);
  });
});

describe("computeDynamics — separating what the interval used to hide", () => {
  it("tells two typists with identical inter-key intervals apart", () => {
    // Both type at exactly 180ms per key. The first holds keys; the second
    // travels. A keydown-only log makes them the same row.
    const holder = sequence(["a", "b", "c", "d", "e", "f", "g", "h"], { dwell: 140, flight: 40 });
    const traveller = sequence(["a", "b", "c", "d", "e", "f", "g", "h"], { dwell: 40, flight: 140 });

    const h = computeDynamics(holder.events, holder.keyups);
    const t = computeDynamics(traveller.events, traveller.keyups);

    expect(h.dwellP50.value).toBeCloseTo(140, 0);
    expect(t.dwellP50.value).toBeCloseTo(40, 0);
    expect(h.flightP50.value).toBeCloseTo(40, 0);
    expect(t.flightP50.value).toBeCloseTo(140, 0);
  });

  it("reports no overlap for strictly sequential typing", () => {
    const { events, keyups } = sequence(["a", "b", "c", "d"], { dwell: 60, flight: 80 });
    const stats = computeDynamics(events, keyups);
    expect(stats.overlapRate.value).toBe(0);
    expect(stats.overlapP50).toBe(0);
  });

  it("detects rollover, where the next key goes down before the last is released", () => {
    // dwell 120, flight -40: every key overlaps the one before it.
    const { events, keyups } = sequence(["a", "b", "c", "d", "e"], { dwell: 120, flight: -40 });
    const stats = computeDynamics(events, keyups);
    expect(stats.overlapRate.value).toBe(1);
    expect(stats.overlapP50).toBeCloseTo(40, 0);
    expect(stats.flightP50.value).toBeLessThan(0);
  });

  it("does not clamp negative flight away — that would erase fluency itself", () => {
    const { events, keyups } = sequence(["a", "b", "c"], { dwell: 100, flight: -30 });
    expect(computeDynamics(events, keyups).flightP50.value).toBeCloseTo(-30, 0);
  });

  it("excludes a thinking pause from flight", () => {
    const events: KeyEvent[] = [
      charEvent({ t: 0, key: "a", expected: "a" }),
      charEvent({ t: 9000, key: "b", expected: "b" }),
    ];
    const keyups: KeyUpEvent[] = [
      { t: 50, key: "a" },
      { t: 9050, key: "b" },
    ];
    expect(computeDynamics(events, keyups).flightP50.n).toBe(0);
  });

  it("carries sample sizes, and reports nothing below MIN_FINDING_N", () => {
    const { events, keyups } = sequence(["a", "b", "c"], { dwell: 90, flight: 60 });
    const stats = computeDynamics(events, keyups);
    expect(stats.dwellP50.n).toBe(3);
    expect(stats.dwellP50.reportable).toBe(false);
  });

  it("returns an all-zero, non-reportable result for a version-1 archive", () => {
    // No releases at all. The honest answer is "unavailable", not an estimate.
    const { events } = sequence(["a", "b", "c"], { dwell: 90, flight: 60 });
    const stats = computeDynamics(events, []);
    expect(stats.dwellP50.reportable).toBe(false);
    expect(stats.dwellP50.n).toBe(0);
    expect(stats.overlapRate.value).toBe(0);
  });
});
