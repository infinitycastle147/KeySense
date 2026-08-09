import { describe, expect, it } from "vitest";
import { generateDrill, DEFAULT_TARGET_RATIO } from "./generate";
import type { DrillConfig } from "@/lib/types";

/** Small deterministic LCG so shuffle/sample tests are reproducible without
 *  mocking the global Math.random. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

// Deliberately split so "contains th" and "the general pool" never overlap —
// that's what lets the ratio tests assert an EXACT matching count rather than
// just a lower bound (a general-pool word coincidentally containing the
// pattern is not a bug; it just makes an exact-count assertion meaningless
// unless the pools are disjoint, as they are here).
const TARGET_WORDS = ["the", "that", "this", "think", "other", "mother", "father", "weather", "theme", "method"];
const GENERAL_WORDS = [
  "cat", "dog", "run", "blue", "green", "apple", "orange", "light", "chair", "paper",
  "music", "happy", "little", "picture", "around", "school", "people", "before", "under", "over",
];
const MIXED_DICTIONARY = [...TARGET_WORDS, ...GENERAL_WORDS];

function config(overrides: Partial<DrillConfig> = {}): DrillConfig {
  return { wordCount: 20, targetRatio: DEFAULT_TARGET_RATIO, corpus: "english_5k", ...overrides };
}

describe("generateDrill", () => {
  it("returns exactly wordCount words", () => {
    const out = generateDrill(["th"], config({ wordCount: 25 }), MIXED_DICTIONARY, {
      rng: seededRng(1),
    });
    expect(out).toHaveLength(25);
  });

  it("enforces the configured targetRatio exactly when pools are disjoint", () => {
    for (const ratio of [0, 0.3, 0.5, 0.7, 1]) {
      const wordCount = 40;
      const out = generateDrill(
        ["th"],
        config({ wordCount, targetRatio: ratio }),
        TARGET_WORDS,
        { rng: seededRng(42), generalWordlist: GENERAL_WORDS },
      );
      const matching = out.filter((w) => w.toLowerCase().includes("th")).length;
      expect(matching).toBe(Math.round(wordCount * ratio));
      expect(out).toHaveLength(wordCount);
    }
  });

  it("defaults to a 0.7 targeted / 0.3 general split", () => {
    const wordCount = 30;
    const out = generateDrill(["th"], config({ wordCount }), TARGET_WORDS, {
      rng: seededRng(7),
      generalWordlist: GENERAL_WORDS,
    });
    const matching = out.filter((w) => w.toLowerCase().includes("th")).length;
    expect(matching).toBe(Math.round(wordCount * 0.7));
  });

  it("guarantees at least the targeted share even when target and general share one pool", () => {
    // The realistic single-dictionary case: general words CAN incidentally
    // match (that's not a bug), so this only asserts the lower bound the
    // generator actually guarantees by construction.
    const wordCount = 30;
    const out = generateDrill(["th"], config({ wordCount }), MIXED_DICTIONARY, {
      rng: seededRng(7),
    });
    const matching = out.filter((w) => w.toLowerCase().includes("th")).length;
    expect(matching).toBeGreaterThanOrEqual(Math.round(wordCount * 0.7));
    expect(out).toHaveLength(wordCount);
  });

  it("shuffles targeted and general words together instead of clustering them", () => {
    const wordCount = 40;
    const out = generateDrill(
      ["th"],
      config({ wordCount, targetRatio: 0.7 }),
      TARGET_WORDS,
      { rng: seededRng(99), generalWordlist: GENERAL_WORDS },
    );
    const targetIndices = out
      .map((w, i) => (w.toLowerCase().includes("th") ? i : -1))
      .filter((i) => i >= 0);
    const targetCount = Math.round(wordCount * 0.7);

    // A naive "targeted words first, then general words" concatenation would
    // put every targeted index below targetCount. A real shuffle spreads
    // them across the whole range.
    expect(Math.max(...targetIndices)).toBeGreaterThanOrEqual(targetCount);
    expect(Math.min(...targetIndices)).toBeLessThan(targetCount - 1);
  });

  it("falls back gracefully when no word matches any target pattern", () => {
    const out = generateDrill(["zzzzz"], config({ wordCount: 15 }), MIXED_DICTIONARY, {
      rng: seededRng(3),
    });
    expect(out).toHaveLength(15);
    out.forEach((w) => expect(MIXED_DICTIONARY).toContain(w));
  });

  it("treats an empty targets array as 'every word already qualifies' (corpus case)", () => {
    const out = generateDrill([], config({ wordCount: 12 }), MIXED_DICTIONARY, {
      rng: seededRng(5),
    });
    expect(out).toHaveLength(12);
  });

  it("draws the general share from a separate pool when given one", () => {
    const generalPool = ["zzz-general-only"];
    const out = generateDrill(
      ["th"],
      config({ wordCount: 10, targetRatio: 0.5 }),
      TARGET_WORDS,
      { rng: seededRng(11), generalWordlist: generalPool },
    );
    const generalWordsUsed = out.filter((w) => w === "zzz-general-only").length;
    expect(generalWordsUsed).toBe(5);
  });

  it("returns [] for wordCount 0 or an empty wordlist, never throws", () => {
    expect(generateDrill(["th"], config({ wordCount: 0 }), MIXED_DICTIONARY)).toEqual([]);
    expect(generateDrill(["th"], config({ wordCount: 10 }), [])).toEqual([]);
  });

  it("clamps an out-of-range or non-finite targetRatio instead of producing nonsense", () => {
    const out = generateDrill(
      ["th"],
      config({ wordCount: 10, targetRatio: 5 }),
      TARGET_WORDS,
      { rng: seededRng(1), generalWordlist: GENERAL_WORDS },
    );
    expect(out).toHaveLength(10);
    const matching = out.filter((w) => w.toLowerCase().includes("th")).length;
    expect(matching).toBe(10); // ratio clamped to 1
  });

  it("is deterministic given the same rng sequence", () => {
    const a = generateDrill(["th"], config({ wordCount: 20 }), MIXED_DICTIONARY, {
      rng: seededRng(123),
    });
    const b = generateDrill(["th"], config({ wordCount: 20 }), MIXED_DICTIONARY, {
      rng: seededRng(123),
    });
    expect(a).toEqual(b);
  });
});
