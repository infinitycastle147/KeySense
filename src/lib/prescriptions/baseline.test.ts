import { describe, expect, it } from "vitest";
import { extractFromCompactProfile, extractFromAnalyses } from "./baseline";
import type { CompactProfile } from "@/lib/ai/profile-input";
import type { TestAnalysis } from "@/lib/analysis/profile";
import { MIN_FINDING_N } from "@/lib/analysis/stats";

function compactProfile(overrides: Partial<CompactProfile> = {}): CompactProfile {
  return {
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-01-10T00:00:00.000Z",
    testCount: 20,
    overall: [],
    worstBigrams: [],
    worstKeys: [],
    fingers: [],
    errorTaxonomy: [],
    topConfusions: [],
    corrections: { backspaceRate: 0, meanCharsToNotice: null, n: 0 },
    rhythm: null,
    dynamics: null,
    quality: { discardRate: 0, distractedTests: 0, testCount: 0 },
    charClasses: [],
    shift: null,
    geometry: null,
    classifiedConfusions: [],
    timeLoss: { floorMs: 0, baselineWpm: 0, top: [] },
    configMatched: true,
    trend: { wpmDelta: 0, accuracyDelta: 0, comparedToDays: 0 },
    ...overrides,
  };
}

function analysis(overrides: Partial<TestAnalysis> = {}): TestAnalysis {
  return {
    testId: "t",
    endedAt: "2026-01-01T00:00:00.000Z",
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
      meanCharsToNotice: { value: 0, n: 0, reportable: false },
    },
    dynamics: {
      dwellP50: { value: 0, n: 0, reportable: false },
      dwellCI: { low: 0, high: 0 },
      flightP50: { value: 0, n: 0, reportable: false },
      flightCI: { low: 0, high: 0 },
      overlapRate: { value: 0, n: 0, reportable: false },
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
      shiftedErrorRate: { value: 0, n: 0, reportable: false },
      unshiftedErrorRate: { value: 0, n: 0, reportable: false },
    },
    geometry: {
      shapes: [],
      alternationRate: { value: 0, n: 0, reportable: false },
      medianSameHandRun: 0,
      longestSameHandRun: 0,
      redirectRate: { value: 0, n: 0, reportable: false },
    },
    ...overrides,
  };
}

describe("extractFromCompactProfile", () => {
  it("aggregates n and errors exactly across multiple target bigrams", () => {
    const compact = compactProfile({
      worstBigrams: [
        { bigram: "ol", errorRate: 0.1, latencyP50: 200, n: 20, sameFinger: true, significant: true },
        { bigram: "ju", errorRate: 0.2, latencyP50: 300, n: 20, sameFinger: true, significant: true },
      ],
    });
    const stat = extractFromCompactProfile(compact, "sfb", ["ol", "ju"]);
    expect(stat.n).toBe(40);
    expect(stat.errorRate).toBeCloseTo((2 + 4) / 40, 5);
    expect(stat.latencyP50).toBeCloseTo(250, 5); // equal weight -> simple average
    expect(stat.reportable).toBe(true);
  });

  it("marks a target below MIN_FINDING_N as not reportable", () => {
    const compact = compactProfile({
      worstBigrams: [{ bigram: "th", errorRate: 0.1, latencyP50: 200, n: 10, sameFinger: false, significant: false }],
    });
    const stat = extractFromCompactProfile(compact, "bigram", ["th"]);
    expect(stat.n).toBe(10);
    expect(stat.reportable).toBe(false);
  });

  it("returns a zeroed, non-reportable stat when the target isn't present at all", () => {
    const stat = extractFromCompactProfile(compactProfile(), "bigram", ["zz"]);
    expect(stat).toEqual({ errorRate: 0, latencyP50: 0, n: 0, reportable: false });
  });

  it("uses relativeLatency (not an absolute ms figure) for finger targets", () => {
    const compact = compactProfile({
      fingers: [{ finger: "r-pinky", relativeLatency: 2.1, errorRate: 0.05, n: 340 }],
    });
    const stat = extractFromCompactProfile(compact, "finger", ["r-pinky"]);
    expect(stat.latencyP50).toBeCloseTo(2.1, 5);
    expect(stat.n).toBe(340);
    expect(stat.reportable).toBe(true);
  });

  it("computes a class target as the proportion of all errors in that class", () => {
    const compact = compactProfile({
      errorTaxonomy: [
        { class: "substitution", count: 20 },
        { class: "transposition", count: 10 },
        { class: "omission", count: 3 },
        { class: "insertion", count: 5 },
      ],
    });
    const stat = extractFromCompactProfile(compact, "class", ["transposition"]);
    expect(stat.n).toBe(38);
    expect(stat.errorRate).toBeCloseTo(10 / 38, 5);
    expect(stat.latencyP50).toBe(0); // not applicable, sentinel
    expect(stat.reportable).toBe(true);
  });
});

describe("extractFromAnalyses", () => {
  it("pools bigram stats across tests even when the target is no longer 'worst'", () => {
    // Two tests where the target bigram has dramatically improved and would
    // not rank in a small top-N "worst" list — must still be found.
    const analyses = [
      analysis({
        testId: "a",
        bigramStats: [
          { bigram: "zz", n: 100, errors: 50, errorRate: 0.5, errorRateCI: { low: 0, high: 1 }, latencyP50: 900, sameFinger: false },
          { bigram: "th", n: 20, errors: 1, errorRate: 0.05, errorRateCI: { low: 0, high: 1 }, latencyP50: 150, sameFinger: false },
        ],
      }),
      analysis({
        testId: "b",
        bigramStats: [
          { bigram: "th", n: 20, errors: 1, errorRate: 0.05, errorRateCI: { low: 0, high: 1 }, latencyP50: 150, sameFinger: false },
        ],
      }),
    ];
    const stat = extractFromAnalyses(analyses, "bigram", ["th"]);
    expect(stat.n).toBe(40);
    expect(stat.errorRate).toBeCloseTo(2 / 40, 5);
    expect(stat.reportable).toBe(true);
  });

  it("gates finger stats on MIN_FINDING_N even though the profile itself doesn't", () => {
    const analyses = [
      analysis({
        fingerStats: [
          { finger: "r-pinky", n: MIN_FINDING_N - 1, errorRate: 0.1, latencyP50: 300, relativeLatency: 1.9 },
        ],
      }),
    ];
    const stat = extractFromAnalyses(analyses, "finger", ["r-pinky"]);
    expect(stat.reportable).toBe(false);
  });

  it("only considers tests with n >= MIN_FINDING_N for a class target", () => {
    const analyses = [
      analysis({
        errorTaxonomy: { substitution: 15, insertion: 5, omission: 3, transposition: 10 },
      }),
    ];
    const stat = extractFromAnalyses(analyses, "class", ["transposition"]);
    expect(stat.n).toBe(33);
    expect(stat.errorRate).toBeCloseTo(10 / 33, 5);
    expect(stat.reportable).toBe(true);
  });

  it("returns a non-reportable zero stat for an empty analyses window", () => {
    const stat = extractFromAnalyses([], "bigram", ["th"]);
    expect(stat).toEqual({ errorRate: 0, latencyP50: 0, n: 0, reportable: false });
  });
});
