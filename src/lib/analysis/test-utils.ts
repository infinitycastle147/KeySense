/**
 * Shared fixture builders for analysis-layer unit tests. Not consumed by any
 * production code path — exists purely to keep hand-built KeyEvent[]
 * fixtures readable across the metric test suites.
 */

import fs from "node:fs";
import path from "node:path";
import type { KeyEvent } from "@/lib/types";
import { parseLayout, type LayoutIndex, type LayoutJson } from "./layout";

type CharEventInput = Partial<KeyEvent> & { t: number; expected: string; key: string };

export function charEvent(input: CharEventInput): KeyEvent {
  return {
    wordIdx: 0,
    charIdx: 0,
    prev: null,
    mods: [],
    kind: "char",
    ok: input.key === input.expected,
    ...input,
  };
}

type DeleteEventInput = Partial<KeyEvent> & { t: number; kind?: "backspace" | "word-delete" };

export function deleteEvent(input: DeleteEventInput): KeyEvent {
  return {
    key: "",
    expected: "",
    ok: false,
    wordIdx: 0,
    charIdx: 0,
    prev: null,
    mods: [],
    kind: "backspace",
    ...input,
  };
}

export function loadLayoutIndex(name: string): LayoutIndex {
  const file = path.join(process.cwd(), "public", "data", "layouts", `${name}.json`);
  const json: LayoutJson = JSON.parse(fs.readFileSync(file, "utf-8"));
  return parseLayout(json);
}

/**
 * A complete, all-zero `TestAnalysis`, for tests that care about one field and
 * need the other twenty to simply exist.
 *
 * Lives here rather than being copied into each suite because `TestAnalysis`
 * grows every time a metric is added, and a hand-rolled fixture per suite means
 * every such addition breaks several unrelated test files with a type error
 * that teaches nobody anything.
 */
export function makeTestAnalysis(
  overrides: Partial<import("./profile").TestAnalysis> = {},
): import("./profile").TestAnalysis {
  const zeroInterval = { low: 0, high: 0 };
  const zeroMeasured = { value: 0, n: 0, reportable: false };

  return {
    testId: "t-1",
    endedAt: "2026-08-01T00:00:00.000Z",
    durationMs: 30000,
    result: {
      wpm: 60,
      rawWpm: 62,
      accuracy: 0.97,
      consistency: 80,
      charsCorrect: 100,
      charsIncorrect: 3,
      charsExtra: 0,
      charsMissed: 0,
    },
    keyStats: [],
    bigramStats: [],
    fingerStats: [],
    errorTaxonomy: { substitution: 0, insertion: 0, omission: 0, transposition: 0 },
    confusionMatrix: {},
    alignedClassification: true,
    fatigue: [],
    corrections: {
      backspaceCount: 0,
      charAttemptCount: 0,
      backspaceRate: 0,
      meanCharsToNotice: zeroMeasured,
    },
    dynamics: {
      dwellP50: zeroMeasured,
      dwellCI: zeroInterval,
      flightP50: zeroMeasured,
      flightCI: zeroInterval,
      overlapRate: zeroMeasured,
      overlapP50: 0,
      dwellP90: 0,
    },
    rhythm: {
      n: 0,
      medianIki: 0,
      madIki: 0,
      coefficientOfVariation: 0,
      burstCount: 0,
      stallCount: 0,
    },
    quality: {
      intervalCount: 0,
      discardedCount: 0,
      discardRate: 0,
      pauseCount: 0,
      pauseMs: 0,
      longestPauseMs: 0,
      activeMs: 0,
      activeMedianIki: 0,
    },
    charClasses: {
      classes: [],
      shiftedErrorRate: zeroMeasured,
      unshiftedErrorRate: zeroMeasured,
    },
    geometry: {
      shapes: [],
      alternationRate: zeroMeasured,
      medianSameHandRun: 0,
      longestSameHandRun: 0,
      redirectRate: zeroMeasured,
    },
    ...overrides,
  };
}
