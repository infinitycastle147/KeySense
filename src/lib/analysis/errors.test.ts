import { describe, expect, it } from "vitest";
import { computeErrorTaxonomy, computeConfusionMatrix } from "./errors";
import { charEvent } from "./test-utils";
import type { KeyEvent } from "@/lib/types";

describe("computeErrorTaxonomy", () => {
  it("returns all-zero taxonomy for empty input", () => {
    expect(computeErrorTaxonomy([])).toEqual({
      substitution: 0,
      insertion: 0,
      omission: 0,
      transposition: 0,
    });
  });

  it("perfect input (zero errors) produces an all-zero taxonomy, no NaN", () => {
    const events = Array.from({ length: 40 }, (_, i) => charEvent({ t: i * 100, expected: "a", key: "a" }));
    const taxonomy = computeErrorTaxonomy(events);
    expect(Object.values(taxonomy).every((v) => v === 0)).toBe(true);
    expect(Object.values(taxonomy).some((v) => Number.isNaN(v))).toBe(false);
  });

  it("single error event classifies as substitution", () => {
    const events = [charEvent({ t: 0, expected: "a", key: "b" })];
    expect(computeErrorTaxonomy(events)).toMatchObject({ substitution: 1 });
  });

  it("classification is unaffected by huge inter-event gaps (all 'outlier' timing)", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "b" }),
      charEvent({ t: 50000, expected: "c", key: "d" }),
      charEvent({ t: 200000, expected: "e", key: "e" }),
    ];
    const taxonomy = computeErrorTaxonomy(events);
    expect(taxonomy.substitution).toBe(2);
  });

  it("n below any threshold: a handful of errors classify individually without special-casing", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "x" }),
      charEvent({ t: 100, expected: "b", key: "b" }),
    ];
    expect(computeErrorTaxonomy(events)).toMatchObject({ substitution: 1 });
  });

  it("detects a transposition: 'ab' typed as 'ba' across adjacent events, counted once (not two substitutions)", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "b", prev: null }),
      charEvent({ t: 100, expected: "b", key: "a", prev: "a" }),
    ];
    const taxonomy = computeErrorTaxonomy(events);
    expect(taxonomy.transposition).toBe(2); // both events belong to the one swap
    expect(taxonomy.substitution).toBe(0);
  });

  it("classifies expected === '' as insertion", () => {
    const events = [charEvent({ t: 0, expected: "", key: "x" })];
    expect(computeErrorTaxonomy(events)).toMatchObject({ insertion: 1 });
  });

  // The engine never emits a `key === ""` sentinel — omissions arrive as
  // `missed` on the committing space instead (see the omission suite below).
  // This asserts the sentinel is NOT the contract, so the old assumption
  // cannot quietly return.
  it("does not treat key === '' as an omission (engine never emits it)", () => {
    const events = [charEvent({ t: 0, expected: "a", key: "" })];
    expect(computeErrorTaxonomy(events)).toMatchObject({ omission: 0 });
  });

  it("ignores backspace/word-delete and correct events", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      { t: 100, key: "", expected: "", ok: false, wordIdx: 0, charIdx: 0, prev: null, mods: [], kind: "backspace" as const },
    ];
    expect(computeErrorTaxonomy(events)).toEqual({
      substitution: 0,
      insertion: 0,
      omission: 0,
      transposition: 0,
    });
  });

  it("taxonomy counts sum to the total error count", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "b" }), // substitution
      charEvent({ t: 100, expected: "", key: "z" }), // insertion
      charEvent({ t: 200, expected: "c", key: "" }), // omission
      charEvent({ t: 300, expected: "d", key: "e", prev: null }), // transposition part 1
      charEvent({ t: 400, expected: "e", key: "d", prev: "d" }), // transposition part 2
    ];
    const taxonomy = computeErrorTaxonomy(events);
    const total = Object.values(taxonomy).reduce((s, v) => s + v, 0);
    expect(total).toBe(5);
  });
});

describe("computeConfusionMatrix", () => {
  it("returns {} for empty input", () => {
    expect(computeConfusionMatrix([])).toEqual({});
  });

  it("returns {} for perfect input", () => {
    const events = [charEvent({ t: 0, expected: "a", key: "a" })];
    expect(computeConfusionMatrix(events)).toEqual({});
  });

  it("records intended -> typed counts for substitutions", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "s" }),
      charEvent({ t: 100, expected: "a", key: "s" }),
    ];
    expect(computeConfusionMatrix(events)).toEqual({ a: { s: 2 } });
  });

  it("records both directions of a transposition", () => {
    const events = [
      charEvent({ t: 0, expected: "t", key: "h", prev: null }),
      charEvent({ t: 100, expected: "h", key: "t", prev: "t" }),
    ];
    expect(computeConfusionMatrix(events)).toEqual({ t: { h: 1 }, h: { t: 1 } });
  });

  it("excludes insertions and omissions (no meaningful intended/typed pair)", () => {
    const events = [
      charEvent({ t: 0, expected: "", key: "x" }), // insertion
      charEvent({ t: 100, expected: "a", key: "" }), // omission
    ];
    expect(computeConfusionMatrix(events)).toEqual({});
  });
});

// --- Regression: omissions must be reachable ---------------------------------
// The engine never emits a `key === ""` sentinel; characters skipped by
// committing a word early are carried as `missed` on the space event. Relying
// on the sentinel left `omission` permanently zero, which would have silently
// removed "you skip letters" from every diagnosis.
describe("omission counting (integration with engine encoding)", () => {
  const ev = (over: Partial<KeyEvent>): KeyEvent => ({
    t: 0, key: "a", expected: "a", ok: true,
    wordIdx: 0, charIdx: 0, prev: null, mods: [], kind: "char", ...over,
  });

  it("counts characters skipped by an early space", () => {
    // "cat" typed as "ca" then space -> one omission
    const events = [
      ev({ t: 0, key: "c", expected: "c", charIdx: 0 }),
      ev({ t: 100, key: "a", expected: "a", charIdx: 1 }),
      ev({ t: 200, key: " ", expected: " ", ok: false, charIdx: 2, missed: 1 }),
    ];
    expect(computeErrorTaxonomy(events).omission).toBe(1);
  });

  it("counts multiple skipped characters", () => {
    const events = [
      ev({ t: 0, key: "c", expected: "c", charIdx: 0 }),
      ev({ t: 100, key: " ", expected: " ", ok: false, charIdx: 1, missed: 4 }),
    ];
    expect(computeErrorTaxonomy(events).omission).toBe(4);
  });

  it("does not count omissions when words are completed", () => {
    const events = [
      ev({ t: 0, key: "c", expected: "c", charIdx: 0 }),
      ev({ t: 100, key: " ", expected: " ", charIdx: 1 }),
    ];
    expect(computeErrorTaxonomy(events).omission).toBe(0);
  });
});
