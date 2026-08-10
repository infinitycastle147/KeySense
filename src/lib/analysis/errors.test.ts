import { describe, expect, it } from "vitest";
import {
  computeErrorTaxonomy,
  computeConfusionMatrix,
  computeErrorTaxonomyAligned,
  computeConfusionMatrixAligned,
  classifyConfusion,
  classifyConfusions,
} from "./errors";
import { charEvent, deleteEvent, loadLayoutIndex } from "./test-utils";
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

// ---------------------------------------------------------------------------
// Alignment-based classification
// ---------------------------------------------------------------------------

/** Types `typed` into word 0 of a one-word prompt, one char event per key,
 *  exactly as the engine records it: `expected` is whatever sits at the same
 *  position, which is the positional assumption under test. */
function typeWord(word: string, typed: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  for (let i = 0; i < typed.length; i++) {
    events.push(
      charEvent({
        t: i * 100,
        key: typed[i],
        expected: i < word.length ? word[i] : "",
        wordIdx: 0,
        charIdx: i,
      }),
    );
  }
  return events;
}

describe("computeErrorTaxonomyAligned", () => {
  it("scores a dropped character as one omission, where the positional read invents a substitution", () => {
    const events = typeWord("hello", "helo");

    // What the positional classifier sees: `o` landed where `l` was expected.
    expect(computeErrorTaxonomy(events)).toMatchObject({ substitution: 1, omission: 0 });

    // What actually happened.
    expect(computeErrorTaxonomyAligned(events, ["hello"])).toEqual({
      substitution: 0,
      insertion: 0,
      omission: 1,
      transposition: 0,
    });
  });

  it("does not let one dropped character cascade through a long word", () => {
    const events = typeWord("keyboard", "kyboard");
    const aligned = computeErrorTaxonomyAligned(events, ["keyboard"]);
    expect(aligned.omission).toBe(1);
    expect(aligned.substitution).toBe(0);
  });

  it("still counts a genuine wrong key as a substitution", () => {
    const events = typeWord("cat", "cst");
    expect(computeErrorTaxonomyAligned(events, ["cat"])).toMatchObject({
      substitution: 1,
      omission: 0,
      insertion: 0,
    });
  });

  it("counts an extra character as an insertion", () => {
    const events = typeWord("cat", "caat");
    expect(computeErrorTaxonomyAligned(events, ["cat"])).toMatchObject({
      insertion: 1,
      substitution: 0,
      omission: 0,
    });
  });

  it("still detects transpositions, and does not double-count them as substitutions", () => {
    const events = typeWord("the", "hte");
    expect(computeErrorTaxonomyAligned(events, ["the"])).toMatchObject({
      transposition: 1,
      substitution: 0,
    });
  });

  it("counts a word skipped with a bare space as a full omission", () => {
    const events = [charEvent({ t: 0, key: " ", expected: " ", wordIdx: 0, charIdx: 0, missed: 3 })];
    expect(computeErrorTaxonomyAligned(events, ["cat"])).toMatchObject({ omission: 3 });
  });

  it("ignores words the test never reached", () => {
    const events = typeWord("cat", "cat");
    // "dog" was never attempted — not typed, not skipped. It is not an omission.
    expect(computeErrorTaxonomyAligned(events, ["cat", "dog"])).toEqual({
      substitution: 0,
      insertion: 0,
      omission: 0,
      transposition: 0,
    });
  });

  it("measures the corrected word, not the abandoned attempt", () => {
    const events = [
      ...typeWord("cat", "cs"),
      deleteEvent({ t: 300, wordIdx: 0, charIdx: 1 }),
      charEvent({ t: 400, key: "a", expected: "a", wordIdx: 0, charIdx: 1 }),
      charEvent({ t: 500, key: "t", expected: "t", wordIdx: 0, charIdx: 2 }),
    ];
    expect(computeErrorTaxonomyAligned(events, ["cat"])).toEqual({
      substitution: 0,
      insertion: 0,
      omission: 0,
      transposition: 0,
    });
  });

  it("returns all-zero counts for an empty stream", () => {
    expect(computeErrorTaxonomyAligned([], ["cat"])).toEqual({
      substitution: 0,
      insertion: 0,
      omission: 0,
      transposition: 0,
    });
  });
});

describe("computeConfusionMatrixAligned", () => {
  it("does not fabricate a confusion pair out of a dropped character", () => {
    const events = typeWord("hello", "helo");
    // The positional matrix claims the typist confuses `l` with `o`.
    expect(computeConfusionMatrix(events)).toEqual({ l: { o: 1 } });
    // They did no such thing — they dropped a letter.
    expect(computeConfusionMatrixAligned(events, ["hello"])).toEqual({});
  });

  it("records a real confusion", () => {
    const events = typeWord("cat", "cst");
    expect(computeConfusionMatrixAligned(events, ["cat"])).toEqual({ a: { s: 1 } });
  });

  it("accumulates repeated confusions of the same pair across words", () => {
    const events = [...typeWord("cat", "cst"), ...typeWord("bat", "bst").map((e) => ({ ...e, wordIdx: 1 }))];
    expect(computeConfusionMatrixAligned(events, ["cat", "bat"])).toEqual({ a: { s: 2 } });
  });

  it("excludes insertions and omissions, which have no intended/typed pair", () => {
    expect(computeConfusionMatrixAligned(typeWord("cat", "caat"), ["cat"])).toEqual({});
    expect(computeConfusionMatrixAligned(typeWord("cat", "ct"), ["cat"])).toEqual({});
  });
});

describe("classifyConfusion — the root cause ARCHITECTURE §5.4 promised", () => {
  const qwerty = loadLayoutIndex("qwerty");

  it("calls a neighbouring key a spatial slip", () => {
    expect(classifyConfusion(qwerty, "a", "s")).toBe("spatial-slip");
  });

  it("calls two keys owned by one finger a same-finger confusion", () => {
    // Not a miss — the finger went to its own column and picked the wrong row.
    expect(classifyConfusion(qwerty, "e", "d")).toBe("same-finger");
  });

  it("calls a distant same-hand key a row jump", () => {
    expect(classifyConfusion(qwerty, "q", "c")).toBe("row-jump");
  });

  it("calls the wrong hand a sequencing failure, not an aiming one", () => {
    expect(classifyConfusion(qwerty, "a", "l")).toBe("cross-hand");
  });

  it("admits when the geometry explains nothing", () => {
    expect(classifyConfusion(qwerty, "a", "é")).toBe("unrelated");
  });

  it("ranks classified confusions by count", () => {
    const rows = classifyConfusions({ a: { s: 12, l: 3 }, e: { d: 7 } }, qwerty);
    expect(rows.map((r) => r.count)).toEqual([12, 7, 3]);
    expect(rows[0]).toMatchObject({ intended: "a", typed: "s", cause: "spatial-slip" });
    expect(rows[2]).toMatchObject({ intended: "a", typed: "l", cause: "cross-hand" });
  });

  it("respects topN", () => {
    expect(classifyConfusions({ a: { s: 12, l: 3 }, e: { d: 7 } }, qwerty, 2)).toHaveLength(2);
  });
});
