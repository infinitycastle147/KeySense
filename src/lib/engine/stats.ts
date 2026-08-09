/**
 * Pure statistics for a single completed test.
 *
 * No I/O, no React — see CLAUDE.md "Pure functions for all analysis." These
 * definitions are fixed (docs/phases/PHASE-1.md §4, .claude/skills/typing-engine)
 * and must not drift: every future comparison against test history depends on
 * today's numbers meaning the same thing tomorrow.
 */

import type { KeyEvent, TestResult } from "@/lib/types";

/** Character-producing keydowns only. Backspace / word-delete are corrections,
 *  not new characters, and are excluded from every count in this file except
 *  where a function explicitly says otherwise. */
function charEvents(events: KeyEvent[]): KeyEvent[] {
  return events.filter((e) => e.kind === "char");
}

/**
 * accuracy = correctKeystrokes / totalKeystrokes, over every character-producing
 * keystroke — including ones later fixed with backspace. This is deliberate: it
 * counts corrected mistakes as mistakes, which is the point (docs/phases/PHASE-1.md).
 * Contrast with the char breakdown below, which is net-of-corrections.
 */
export function computeAccuracy(events: KeyEvent[]): number {
  const chars = charEvents(events);
  if (chars.length === 0) return 0;
  const correct = chars.filter((e) => e.ok).length;
  return correct / chars.length;
}

/**
 * Which word indices were "advanced past" (committed with a space) rather than
 * being the word the test ended on mid-way through. Derived from the events
 * themselves rather than tracked separately, so there is exactly one source of
 * truth for engine state.
 *
 * Marked directly by the space keystroke that committed each word — not by
 * "any later event proves earlier words were left behind", which breaks for
 * the very last word touched: if the test ends right on the space that
 * commits it, there is no *later* event to infer that from.
 */
function computeAdvancedWords(events: KeyEvent[], wordCount: number): boolean[] {
  const advanced = new Array<boolean>(wordCount).fill(false);
  for (const e of events) {
    if (e.kind === "char" && e.key === " " && e.wordIdx < wordCount) {
      advanced[e.wordIdx] = true;
    }
  }
  return advanced;
}

/**
 * Final-state character breakdown: what each word ended up containing, compared
 * against what was expected, AFTER all corrections. This is net — a character
 * typed wrong then backspaced-and-fixed counts as correct here (it counts as a
 * mistake in `accuracy` above, which is keystroke-level, not net).
 *
 * - charsExtra: typed past a word's expected length.
 * - charsMissed: word was advanced past (space) before it was fully typed.
 * - A word never reached (test cut short mid-way) contributes to none of these —
 *   it was neither attempted nor skipped.
 */
export function computeCharBreakdown(
  words: string[],
  typed: string[],
  events: KeyEvent[]
): Pick<TestResult, "charsCorrect" | "charsIncorrect" | "charsExtra" | "charsMissed"> {
  const advanced = computeAdvancedWords(events, words.length);
  let charsCorrect = 0;
  let charsIncorrect = 0;
  let charsExtra = 0;
  let charsMissed = 0;

  for (let i = 0; i < words.length; i++) {
    const expected = words[i] ?? "";
    const got = typed[i] ?? "";
    if (got === "" && !advanced[i]) continue; // never attempted

    const minLen = Math.min(expected.length, got.length);
    for (let c = 0; c < minLen; c++) {
      if (got[c] === expected[c]) charsCorrect++;
      else charsIncorrect++;
    }
    if (got.length > expected.length) {
      charsExtra += got.length - expected.length;
    }
    if (advanced[i] && got.length < expected.length) {
      charsMissed += expected.length - got.length;
    }
  }

  return { charsCorrect, charsIncorrect, charsExtra, charsMissed };
}

/**
 * consistency = 100 - (coefficient of variation of per-second wpm), clamped to
 * [0, 100]. Built from correct-char counts bucketed by second (using `t`, which
 * is already relative to test start — see docs/ARCHITECTURE.md §3.1). The same
 * character set as `wpm` (net correct chars) is used here so the two numbers
 * describe the same thing at different resolutions.
 */
export function computeConsistency(events: KeyEvent[], durationMs: number): number {
  if (durationMs <= 0) return 100;
  const totalSeconds = Math.max(1, Math.ceil(durationMs / 1000));
  const buckets = new Array<number>(totalSeconds).fill(0);
  for (const e of charEvents(events)) {
    if (!e.ok) continue;
    const sec = Math.min(totalSeconds - 1, Math.max(0, Math.floor(e.t / 1000)));
    buckets[sec] += 1;
  }
  if (buckets.length < 2) return 100;

  const wpmSeries = buckets.map((count) => (count / 5) * 60);
  const mean = wpmSeries.reduce((a, b) => a + b, 0) / wpmSeries.length;
  if (mean === 0) return 0;
  const variance =
    wpmSeries.reduce((sum, v) => sum + (v - mean) ** 2, 0) / wpmSeries.length;
  const stdDev = Math.sqrt(variance);
  const cv = (stdDev / mean) * 100;
  return Math.max(0, Math.min(100, 100 - cv));
}

/**
 * Assembles the full `TestResult`. `words`/`typed` give the net (post-correction)
 * outcome; `events` gives the full keystroke-level record for accuracy and the
 * rhythm-based consistency figure.
 */
export function computeResult(
  words: string[],
  typed: string[],
  events: KeyEvent[],
  durationMs: number
): TestResult {
  const { charsCorrect, charsIncorrect, charsExtra, charsMissed } =
    computeCharBreakdown(words, typed, events);

  const minutes = durationMs > 0 ? durationMs / 60000 : 0;
  const allTypedChars = charEvents(events).length;

  const wpm = minutes > 0 ? charsCorrect / 5 / minutes : 0;
  const rawWpm = minutes > 0 ? allTypedChars / 5 / minutes : 0;
  const accuracy = computeAccuracy(events);
  const consistency = computeConsistency(events, durationMs);

  return {
    wpm,
    rawWpm,
    accuracy,
    consistency,
    charsCorrect,
    charsIncorrect,
    charsExtra,
    charsMissed,
  };
}
