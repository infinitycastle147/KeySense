import { describe, expect, it } from "vitest";
import type { CompletedTest, KeyEvent, TestResult } from "@/lib/types";
import { computeTestAnalysis, buildMetricProfile } from "./profile";
import { charEvent, loadLayoutIndex } from "./test-utils";
import { MIN_FINDING_N } from "./stats";

const qwerty = loadLayoutIndex("qwerty");

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    wpm: 60,
    rawWpm: 65,
    accuracy: 0.95,
    consistency: 0.8,
    charsCorrect: 100,
    charsIncorrect: 5,
    charsExtra: 0,
    charsMissed: 0,
    ...overrides,
  };
}

function makeTest(
  id: string,
  events: KeyEvent[],
  overrides: Partial<CompletedTest> = {}
): CompletedTest {
  return {
    id,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:01:00.000Z",
    durationMs: 30000,
    config: { mode: "time", modeSetting: "30", language: "english", layout: "qwerty", punctuation: false, numbers: false },
    result: makeResult(),
    events,
    source: "freeplay",
    prescriptionId: null,
    deviceId: "device-1",
    appVersion: "0.1.0",
    syncedAt: null,
    ...overrides,
  };
}

function repeatingEvents(count: number, expected: string, key: string, gapMs = 120): KeyEvent[] {
  return Array.from({ length: count }, (_, i) => charEvent({ t: i * gapMs, expected, key }));
}

describe("computeTestAnalysis", () => {
  it("runs every Part-A metric over one test and preserves test metadata", () => {
    const test = makeTest("t1", repeatingEvents(10, "a", "a"));
    const analysis = computeTestAnalysis(test, qwerty);
    expect(analysis.testId).toBe("t1");
    expect(analysis.endedAt).toBe(test.endedAt);
    expect(analysis.durationMs).toBe(test.durationMs);
    expect(analysis.result).toBe(test.result);
    expect(analysis.keyStats.length).toBeGreaterThan(0);
    expect(analysis.fingerStats.length).toBeGreaterThan(0);
    expect(analysis.fatigue.length).toBeGreaterThan(0);
    expect(analysis.errorTaxonomy).toBeDefined();
    expect(analysis.confusionMatrix).toBeDefined();
    expect(analysis.corrections).toBeDefined();
  });

  it("handles a test with zero events without throwing or NaN", () => {
    const test = makeTest("empty-test", []);
    const analysis = computeTestAnalysis(test, qwerty);
    expect(analysis.keyStats).toEqual([]);
    expect(analysis.bigramStats).toEqual([]);
    expect(analysis.fingerStats).toEqual([]);
  });
});

describe("buildMetricProfile", () => {
  it("returns a well-formed, all-zero, non-reportable profile for empty input", () => {
    const profile = buildMetricProfile([]);
    expect(profile.testCount).toBe(0);
    expect(profile.overall.wpm).toEqual({ value: 0, n: 0, reportable: false });
    expect(profile.worstBigrams).toEqual([]);
    expect(profile.worstKeys).toEqual([]);
    expect(profile.fingers).toEqual([]);
    expect(profile.errorTaxonomy).toEqual({ substitution: 0, insertion: 0, omission: 0, transposition: 0 });
    expect(profile.fatigue).toEqual({ bucketSeconds: 10, wpm: [] });
  });

  it("single test in the window: testCount=1, overall stats not reportable (n < MIN_FINDING_N)", () => {
    const analysis = computeTestAnalysis(makeTest("t1", repeatingEvents(10, "a", "a")), qwerty);
    const profile = buildMetricProfile([analysis]);
    expect(profile.testCount).toBe(1);
    expect(profile.overall.wpm.n).toBe(1);
    expect(profile.overall.wpm.reportable).toBe(false);
  });

  it("perfect input (zero errors across the whole window): no NaN anywhere, empty taxonomy", () => {
    const analyses = Array.from({ length: 5 }, (_, i) =>
      computeTestAnalysis(makeTest(`t${i}`, repeatingEvents(20, "a", "a")), qwerty)
    );
    const profile = buildMetricProfile(analyses);
    expect(profile.errorTaxonomy).toEqual({ substitution: 0, insertion: 0, omission: 0, transposition: 0 });
    expect(profile.topConfusions).toEqual([]);
    const flatValues = JSON.stringify(profile);
    expect(flatValues.includes("null")).toBe(false);
    expect(Number.isNaN(profile.overall.wpm.value)).toBe(false);
  });

  it("n below MIN_FINDING_N: a window of a few tests is not reportable at the overall level", () => {
    const analyses = Array.from({ length: 5 }, (_, i) =>
      computeTestAnalysis(makeTest(`t${i}`, repeatingEvents(5, "a", "a")), qwerty)
    );
    const profile = buildMetricProfile(analyses);
    expect(profile.testCount).toBeLessThan(MIN_FINDING_N);
    expect(profile.overall.accuracy.reportable).toBe(false);
  });

  it("all-outlier input across the window: latency-derived fields collapse to 0, not NaN", () => {
    const outlierEvents: KeyEvent[] = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 5000, expected: "a", key: "a" }),
      charEvent({ t: 12000, expected: "a", key: "a" }),
    ];
    const analyses = [computeTestAnalysis(makeTest("t1", outlierEvents), qwerty)];
    const profile = buildMetricProfile(analyses);
    for (const finger of profile.fingers) {
      expect(Number.isNaN(finger.latencyP50)).toBe(false);
      expect(Number.isNaN(finger.relativeLatency)).toBe(false);
    }
  });

  it("MIN_FINDING_N gating keeps a 2/3-on-n=3 bigram out of worstBigrams even though its error rate dwarfs a 40/400 bigram's", () => {
    // Bigram "xy": 2 errors out of 3 occurrences (66.7%) — must be excluded, n < 30.
    const rareEvents: KeyEvent[] = [
      charEvent({ t: 0, expected: "x", key: "x", prev: null }),
      charEvent({ t: 100, expected: "y", key: "z", prev: "x" }),
      charEvent({ t: 300, expected: "x", key: "x", prev: null }),
      charEvent({ t: 400, expected: "y", key: "z", prev: "x" }),
      charEvent({ t: 600, expected: "x", key: "x", prev: null }),
      charEvent({ t: 700, expected: "y", key: "y", prev: "x" }),
    ];
    // Bigram "th": 40 errors out of 400 occurrences (10%) — must be included, n >= 30.
    const commonEvents: KeyEvent[] = [];
    for (let i = 0; i < 400; i++) {
      commonEvents.push(charEvent({ t: i * 200, expected: "t", key: "t", prev: null }));
      const isError = i < 40;
      commonEvents.push(charEvent({ t: i * 200 + 100, expected: "h", key: isError ? "x" : "h", prev: "t" }));
    }

    const analyses = [
      computeTestAnalysis(makeTest("rare", rareEvents), qwerty),
      computeTestAnalysis(makeTest("common", commonEvents), qwerty),
    ];
    const profile = buildMetricProfile(analyses, { topN: 5 });

    expect(profile.worstBigrams.some((b) => b.bigram === "xy")).toBe(false);
    expect(profile.worstBigrams.some((b) => b.bigram === "th")).toBe(true);
  });

  it("computes trend against a previous window, baselined against the user's own history", () => {
    const current = [
      computeTestAnalysis(
        makeTest("c1", repeatingEvents(20, "a", "a"), {
          endedAt: "2026-08-09T00:00:00.000Z",
          result: makeResult({ wpm: 80, accuracy: 0.97 }),
        }),
        qwerty
      ),
    ];
    const previous = [
      computeTestAnalysis(
        makeTest("p1", repeatingEvents(20, "a", "a"), {
          endedAt: "2026-08-02T00:00:00.000Z",
          result: makeResult({ wpm: 60, accuracy: 0.9 }),
        }),
        qwerty
      ),
    ];
    const profile = buildMetricProfile(current, { previousWindow: previous });
    expect(profile.trend.wpmDelta).toBeCloseTo(20);
    expect(profile.trend.accuracyDelta).toBeCloseTo(0.07);
    expect(profile.trend.comparedToDays).toBeGreaterThan(0);
  });

  it("without a previous window, trend is zeroed rather than fabricated against a population norm", () => {
    const analyses = [computeTestAnalysis(makeTest("t1", repeatingEvents(10, "a", "a")), qwerty)];
    const profile = buildMetricProfile(analyses);
    expect(profile.trend).toEqual({ wpmDelta: 0, accuracyDelta: 0, comparedToDays: 0 });
  });

  it("merges fatigue buckets across tests of different lengths without NaN", () => {
    const short = computeTestAnalysis(makeTest("short", repeatingEvents(5, "a", "a"), { durationMs: 5000 }), qwerty, 10);
    const long = computeTestAnalysis(makeTest("long", repeatingEvents(30, "a", "a"), { durationMs: 25000 }), qwerty, 10);
    const profile = buildMetricProfile([short, long], { bucketSeconds: 10 });
    expect(profile.fatigue.bucketSeconds).toBe(10);
    expect(profile.fatigue.wpm.length).toBeGreaterThanOrEqual(3);
    expect(profile.fatigue.wpm.every((v) => !Number.isNaN(v))).toBe(true);
  });
});
