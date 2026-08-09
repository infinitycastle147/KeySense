import { describe, expect, it } from "vitest";
import { computeBigramStats, filterSameFingerBigrams } from "./bigrams";
import { charEvent, deleteEvent, loadLayoutIndex } from "./test-utils";
import { MIN_FINDING_N } from "./stats";

const qwerty = loadLayoutIndex("qwerty");

describe("computeBigramStats", () => {
  it("returns [] for empty input", () => {
    expect(computeBigramStats([], qwerty)).toEqual([]);
  });

  it("returns [] when there is no bigram context (single event, prev=null)", () => {
    const events = [charEvent({ t: 0, expected: "a", key: "a", prev: null })];
    expect(computeBigramStats(events, qwerty)).toEqual([]);
  });

  it("single occurrence of a bigram produces n=1 without NaN", () => {
    const events = [
      charEvent({ t: 0, expected: "f", key: "f", prev: null }),
      charEvent({ t: 120, expected: "g", key: "g", prev: "f" }),
    ];
    const stats = computeBigramStats(events, qwerty);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ bigram: "fg", n: 1, errors: 0, latencyP50: 120 });
    expect(Number.isNaN(stats[0].errorRate)).toBe(false);
  });

  it("perfect input (zero errors) produces no NaN", () => {
    const events: ReturnType<typeof charEvent>[] = [charEvent({ t: 0, expected: "t", key: "t", prev: null })];
    for (let i = 0; i < 40; i++) {
      events.push(charEvent({ t: (i + 1) * 130, expected: "h", key: "h", prev: "t" }));
      events.push(charEvent({ t: (i + 2) * 130, expected: "t", key: "t", prev: "h" }));
    }
    const stats = computeBigramStats(events, qwerty);
    const th = stats.find((s) => s.bigram === "th")!;
    expect(th.errors).toBe(0);
    expect(th.errorRateCI.low).toBe(0);
    expect(Number.isNaN(th.latencyP50)).toBe(false);
  });

  it("n below MIN_FINDING_N is still returned (gating is a caller concern)", () => {
    const events = [
      charEvent({ t: 0, expected: "q", key: "q", prev: null }),
      charEvent({ t: 100, expected: "u", key: "u", prev: "q" }),
    ];
    const stats = computeBigramStats(events, qwerty);
    expect(stats[0].n).toBeLessThan(MIN_FINDING_N);
  });

  it("all-outlier input: n/errors correct, latency collapses to 0 not NaN", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "a", prev: null }),
      charEvent({ t: 3000, expected: "s", key: "s", prev: "a" }), // 3000ms, outlier
    ];
    const stats = computeBigramStats(events, qwerty);
    const as = stats.find((s) => s.bigram === "as")!;
    expect(as.n).toBe(1);
    expect(as.latencyP50).toBe(0);
    expect(Number.isNaN(as.latencyP50)).toBe(false);
  });

  it("detects same-finger bigrams via the layout", () => {
    const events = [
      charEvent({ t: 0, expected: "f", key: "f", prev: null }),
      charEvent({ t: 100, expected: "g", key: "g", prev: "f" }), // both l-index -> SFB
      charEvent({ t: 300, expected: "j", key: "j", prev: "g" }), // g(l-index) -> j(r-index) -> not SFB
    ];
    const stats = computeBigramStats(events, qwerty);
    expect(stats.find((s) => s.bigram === "fg")!.sameFinger).toBe(true);
    expect(stats.find((s) => s.bigram === "gj")!.sameFinger).toBe(false);
  });

  it("does not record latency across a correction, but still counts n/errors", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "a", prev: null }),
      charEvent({ t: 100, expected: "s", key: "d", prev: "a" }), // wrong char typed
      deleteEvent({ t: 200, kind: "backspace" }),
      charEvent({ t: 300, expected: "s", key: "s", prev: "a" }), // corrected attempt
    ];
    const stats = computeBigramStats(events, qwerty);
    const as = stats.find((s) => s.bigram === "as")!;
    // Two attempts at "as": one wrong (t=100, immediately after 'a' -> latency recorded),
    // one corrected (t=300, immediately after a backspace -> latency skipped).
    expect(as.n).toBe(2);
    expect(as.errors).toBe(1);
  });
});

describe("filterSameFingerBigrams", () => {
  it("returns [] for empty input", () => {
    expect(filterSameFingerBigrams([])).toEqual([]);
  });

  it("keeps only bigrams flagged sameFinger", () => {
    const events = [
      charEvent({ t: 0, expected: "f", key: "f", prev: null }),
      charEvent({ t: 100, expected: "g", key: "g", prev: "f" }),
      charEvent({ t: 300, expected: "j", key: "j", prev: "g" }),
    ];
    const stats = computeBigramStats(events, qwerty);
    const sfbs = filterSameFingerBigrams(stats);
    expect(sfbs.map((b) => b.bigram)).toEqual(["fg"]);
  });
});
