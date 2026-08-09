import { describe, expect, it } from "vitest";
import {
  computeAccuracy,
  computeCharBreakdown,
  computeConsistency,
  computeResult,
} from "./stats";
import type { KeyEvent } from "@/lib/types";

function charEvent(overrides: Partial<KeyEvent> & { key: string; expected: string; ok: boolean }): KeyEvent {
  return {
    t: overrides.t ?? 0,
    key: overrides.key,
    expected: overrides.expected,
    ok: overrides.ok,
    wordIdx: overrides.wordIdx ?? 0,
    charIdx: overrides.charIdx ?? 0,
    prev: overrides.prev ?? null,
    mods: overrides.mods ?? [],
    kind: overrides.kind ?? "char",
  };
}

describe("computeAccuracy", () => {
  it("is 1 when every char keystroke was correct", () => {
    const events = [
      charEvent({ key: "c", expected: "c", ok: true }),
      charEvent({ key: "a", expected: "a", ok: true }),
    ];
    expect(computeAccuracy(events)).toBe(1);
  });

  it("counts a corrected mistake as a mistake — keystroke-level, not final-state", () => {
    const events = [
      charEvent({ key: "x", expected: "c", ok: false, charIdx: 0 }), // wrong
      charEvent({ key: "c", expected: "c", ok: false, kind: "backspace", charIdx: 0 }),
      charEvent({ key: "c", expected: "c", ok: true, charIdx: 0 }), // fixed
    ];
    // 2 char-kind keystrokes (backspace excluded), 1 correct.
    expect(computeAccuracy(events)).toBeCloseTo(0.5);
  });

  it("returns 0 for no keystrokes", () => {
    expect(computeAccuracy([])).toBe(0);
  });

  it("excludes backspace/word-delete events from the denominator", () => {
    const events = [
      charEvent({ key: "c", expected: "c", ok: true }),
      charEvent({ key: "c", expected: "c", ok: true, kind: "backspace" }),
      charEvent({ key: "c", expected: "c", ok: true, kind: "word-delete" }),
    ];
    expect(computeAccuracy(events)).toBe(1);
  });
});

describe("computeCharBreakdown", () => {
  it("counts correct and incorrect characters net of the final typed state", () => {
    const words = ["cat"];
    const typed = ["cat"];
    const events: KeyEvent[] = [
      charEvent({ key: "c", expected: "c", ok: true, wordIdx: 0, charIdx: 0 }),
      charEvent({ key: "a", expected: "a", ok: true, wordIdx: 0, charIdx: 1 }),
      charEvent({ key: "t", expected: "t", ok: true, wordIdx: 0, charIdx: 2 }),
    ];
    const result = computeCharBreakdown(words, typed, events);
    expect(result).toEqual({
      charsCorrect: 3,
      charsIncorrect: 0,
      charsExtra: 0,
      charsMissed: 0,
    });
  });

  it("counts extra characters typed past a word's end", () => {
    const words = ["cat"];
    const typed = ["catdog"];
    const events: KeyEvent[] = [];
    const result = computeCharBreakdown(words, typed, events);
    expect(result.charsCorrect).toBe(3);
    expect(result.charsExtra).toBe(3);
  });

  it("counts missed characters only for words explicitly committed early with a space", () => {
    const words = ["cat", "dog"];
    const typed = ["ca", ""];
    const events: KeyEvent[] = [
      charEvent({ key: "c", expected: "c", ok: true, wordIdx: 0, charIdx: 0 }),
      charEvent({ key: "a", expected: "a", ok: true, wordIdx: 0, charIdx: 1 }),
      charEvent({ key: " ", expected: " ", ok: false, wordIdx: 0, charIdx: 2 }),
    ];
    const result = computeCharBreakdown(words, typed, events);
    expect(result.charsMissed).toBe(1); // the "t" in "cat"
    expect(result.charsCorrect).toBe(2);
  });

  it("does not count an untouched trailing word as missed", () => {
    const words = ["cat", "dog"];
    const typed = ["cat", ""];
    const events: KeyEvent[] = [
      charEvent({ key: " ", expected: " ", ok: true, wordIdx: 0, charIdx: 3 }),
    ];
    const result = computeCharBreakdown(words, typed, events);
    expect(result.charsMissed).toBe(0);
  });

  it("counts a mismatched character as incorrect, not missed", () => {
    const words = ["cat"];
    const typed = ["cot"];
    const result = computeCharBreakdown(words, typed, []);
    expect(result.charsCorrect).toBe(2);
    expect(result.charsIncorrect).toBe(1);
  });
});

describe("computeConsistency", () => {
  it("is high for a perfectly steady typing rhythm", () => {
    // One correct char exactly every 100ms for 3 seconds — same rate every bucket.
    const events: KeyEvent[] = [];
    for (let t = 0; t < 3000; t += 100) {
      events.push(charEvent({ key: "a", expected: "a", ok: true, t }));
    }
    const consistency = computeConsistency(events, 3000);
    expect(consistency).toBeGreaterThan(95);
  });

  it("is lower for a bursty rhythm (fast burst then a long stall)", () => {
    const events: KeyEvent[] = [];
    // Burst: 20 correct chars in second 0.
    for (let t = 0; t < 900; t += 45) {
      events.push(charEvent({ key: "a", expected: "a", ok: true, t }));
    }
    // Then nothing for 4 more seconds (buckets of 0).
    const consistency = computeConsistency(events, 5000);
    expect(consistency).toBeLessThan(50);
  });

  it("returns 100 for a near-zero-duration test rather than dividing by zero", () => {
    expect(computeConsistency([], 0)).toBe(100);
    expect(computeConsistency([], 400)).toBe(100);
  });

  it("stays within [0, 100]", () => {
    const events: KeyEvent[] = [charEvent({ key: "a", expected: "a", ok: true, t: 0 })];
    const consistency = computeConsistency(events, 10000);
    expect(consistency).toBeGreaterThanOrEqual(0);
    expect(consistency).toBeLessThanOrEqual(100);
  });
});

describe("computeResult — WPM / accuracy maths", () => {
  it("matches the fixed formulas: wpm = (correctChars/5)/minutes, rawWpm = (allTyped/5)/minutes", () => {
    // 60 seconds, 50 correct chars typed net, 55 total char keystrokes (5 were
    // typo+backspace+refix — net result still correct).
    const words = ["a".repeat(50)];
    const typed = ["a".repeat(50)];
    const events: KeyEvent[] = [];
    for (let i = 0; i < 50; i++) {
      events.push(charEvent({ key: "a", expected: "a", ok: true, wordIdx: 0, charIdx: i, t: i * 1000 }));
    }
    // 5 extra wrong keystrokes that were immediately corrected (not present in
    // final `typed`, but they did happen — they count in accuracy/rawWpm).
    for (let i = 0; i < 5; i++) {
      events.push(charEvent({ key: "x", expected: "a", ok: false, t: 50000 + i }));
    }

    const durationMs = 60_000;
    const result = computeResult(words, typed, events, durationMs);

    expect(result.charsCorrect).toBe(50);
    expect(result.wpm).toBeCloseTo(50 / 5 / 1, 5); // 10 wpm
    expect(result.rawWpm).toBeCloseTo(55 / 5 / 1, 5); // 11 wpm
    expect(result.accuracy).toBeCloseTo(50 / 55, 5);
  });

  it("returns zeroed wpm figures for zero duration instead of Infinity/NaN", () => {
    const result = computeResult(["cat"], ["cat"], [], 0);
    expect(result.wpm).toBe(0);
    expect(result.rawWpm).toBe(0);
    expect(Number.isFinite(result.wpm)).toBe(true);
  });
});
