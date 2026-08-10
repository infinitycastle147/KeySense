import { describe, it, expect } from "vitest";
import {
  buildCompactProfile,
  collectAllowedNumbers,
  collectValidTargets,
  collectAllTargets,
} from "./profile-input";
import { MAX_PROFILE_BYTES } from "./model";
import type { MetricProfile } from "@/lib/types";

function measured(value: number, n: number, reportable = true) {
  return { value, n, reportable };
}

const OL = {
  bigram: "ol",
  n: 340,
  errors: 29,
  errorRate: 0.084,
  errorRateCI: { low: 0.06, high: 0.12 },
  latencyP50: 211,
  sameFinger: true,
};

const SEMI = {
  key: ";",
  n: 120,
  errors: 9,
  errorRate: 0.075,
  errorRateCI: { low: 0.04, high: 0.14 },
  latencyP50: 198,
  latencyP90: 320,
};

function profile(over: Partial<MetricProfile> = {}): MetricProfile {
  return {
    windowStart: "2026-07-01T00:00:00Z",
    windowEnd: "2026-08-01T00:00:00Z",
    testCount: 42,
    overall: {
      wpm: measured(84.2, 42),
      accuracy: measured(96.1, 42),
      consistency: measured(78.5, 42),
    },
    // The model reads the ranked lists (bigramStats/keyStats), not the
    // discovery subset — see CompactProfile.worstBigrams. worstBigrams here is
    // the subset that cleared the gate, as it is in a real profile.
    worstBigrams: [OL],
    worstKeys: [SEMI],
    bigramStats: [
      { ...OL, significant: true },
      {
        bigram: "ju",
        n: 12, // below threshold — must be dropped
        errors: 4,
        errorRate: 0.33,
        errorRateCI: { low: 0.1, high: 0.65 },
        latencyP50: 260,
        sameFinger: false,
        significant: false,
      },
    ],
    keyStats: [{ ...SEMI, significant: true }],
    fingers: [
      { finger: "r-pinky", n: 340, errorRate: 0.084, latencyP50: 211, relativeLatency: 2.13 },
    ],
    errorTaxonomy: { substitution: 40, insertion: 5, omission: 3, transposition: 8 },
    topConfusions: [{ intended: "a", typed: "s", count: 12 }],
    sameFingerBigrams: [],
    fatigue: { bucketSeconds: 10, wpm: [88, 86, 84, 80] },
    corrections: { backspaceRate: 0.06, meanCharsToNotice: measured(1.8, 55) },
    trend: { wpmDelta: 4.2, accuracyDelta: -0.3, comparedToDays: 30 },
    rhythm: { medianIki: 180, coefficientOfVariation: 0.32, burstRate: 0.02, stallRate: 0.03, n: 900 },
    dynamics: { available: true, dwellP50: 78, flightP50: 96, overlapRate: 0.41, n: 900 },
    quality: { discardRate: 0.04, distractedTests: 1, testCount: 42 },
    charClasses: [],
    shift: { shiftedErrorRate: 0, unshiftedErrorRate: 0, n: 0 },
    geometry: { shapes: [], alternationRate: 0, medianSameHandRun: 0, redirectRate: 0, n: 0 },
    classifiedConfusions: [],
    timeLoss: { floorMs: 140, baselineWpm: 84, top: [] },
    configMatched: true,
    ...over,
  };
}

describe("buildCompactProfile", () => {
  // The rule from ARCHITECTURE.md §5.1: the model gets statistics, never events.
  it("contains no raw event data", () => {
    const serialised = JSON.stringify(buildCompactProfile(profile(), 30));
    expect(serialised).not.toContain('"events"');
    expect(serialised).not.toContain('"timeStamp"');
    expect(serialised).not.toContain('"expected"');
    expect(serialised).not.toContain('"charIdx"');
  });

  it("stays small enough to be cheap to send", () => {
    const bytes = Buffer.byteLength(
      JSON.stringify(buildCompactProfile(profile(), 30)),
      "utf8",
    );
    expect(bytes).toBeLessThan(MAX_PROFILE_BYTES * 4);
  });

  it("drops rows below the minimum sample size", () => {
    const compact = buildCompactProfile(profile(), 30);
    const bigrams = compact.worstBigrams.map((b) => b.bigram);
    expect(bigrams).toContain("ol");
    expect(bigrams).not.toContain("ju"); // n=12
  });

  it("carries an n alongside every measurement", () => {
    const compact = buildCompactProfile(profile(), 30);
    for (const row of compact.overall) expect(row.n).toBeGreaterThan(0);
    for (const row of compact.worstBigrams) expect(row.n).toBeGreaterThan(0);
    for (const row of compact.worstKeys) expect(row.n).toBeGreaterThan(0);
    for (const row of compact.fingers) expect(row.n).toBeGreaterThan(0);
  });

  it("omits non-reportable headline metrics", () => {
    const compact = buildCompactProfile(
      profile({
        overall: {
          wpm: measured(84.2, 3, false),
          accuracy: measured(96.1, 42),
          consistency: measured(78.5, 42),
        },
      }),
      30,
    );
    expect(compact.overall.map((o) => o.label)).not.toContain("wpm");
    expect(compact.overall.map((o) => o.label)).toContain("accuracy");
  });

  it("handles an empty profile without throwing", () => {
    const compact = buildCompactProfile(
      profile({ bigramStats: [], keyStats: [], worstBigrams: [], worstKeys: [], fingers: [], topConfusions: [] }),
      30,
    );
    expect(compact.worstBigrams).toEqual([]);
    expect(compact.fingers).toEqual([]);
  });
});

describe("collectAllowedNumbers", () => {
  it("collects every number the model may cite", () => {
    const compact = buildCompactProfile(profile(), 30);
    const allowed = collectAllowedNumbers(compact);
    expect(allowed).toContain(0.084); // bigram error rate
    expect(allowed).toContain(211); // bigram latency
    expect(allowed).toContain(340); // sample size
    expect(allowed).toContain(2.13); // relative latency
  });

  it("does not collect numbers that were filtered out", () => {
    const allowed = collectAllowedNumbers(buildCompactProfile(profile(), 30));
    expect(allowed).not.toContain(0.33); // the dropped n=12 bigram
  });
});

describe("collectValidTargets", () => {
  // The contract: a target the model may name is exactly a target a
  // prescription can baseline. When these came apart, the model wrote findings
  // the UI offered a "prescribe drill" button for and the API could only 422.
  it("offers exactly what extractFromCompactProfile can resolve", () => {
    const compact = buildCompactProfile(profile(), 30);
    const targets = collectValidTargets(compact);
    expect(targets.bigram).toEqual(compact.worstBigrams.map((b) => b.bigram));
    expect(targets.key).toEqual(compact.worstKeys.map((k) => k.key));
    expect(targets.finger).toEqual(compact.fingers.map((f) => f.finger));
    expect(targets.class).toEqual(compact.errorTaxonomy.map((e) => e.class));
  });

  it("narrows sfb to same-finger bigrams, so type and target agree", () => {
    const compact = buildCompactProfile(profile(), 30);
    for (const b of targetsOf(compact, "sfb")) {
      expect(compact.worstBigrams.find((x) => x.bigram === b)?.sameFinger).toBe(true);
    }
  });

  it("never offers a geometry shape name — the bug that started this", () => {
    const compact = buildCompactProfile(profile(), 30);
    const all = collectAllTargets(compact);
    for (const shape of ["same-finger", "scissor", "lateral-stretch", "alternation"]) {
      expect(all).not.toContain(shape);
    }
  });

  it("flattens to a deduplicated union for the schema enum", () => {
    const all = collectAllTargets(buildCompactProfile(profile(), 30));
    expect(new Set(all).size).toBe(all.length);
  });
});

function targetsOf(compact: Parameters<typeof collectValidTargets>[0], type: string): string[] {
  return collectValidTargets(compact)[type] ?? [];
}
