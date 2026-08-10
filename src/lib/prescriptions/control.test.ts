import { describe, expect, it } from "vitest";
import { selectControlTargets } from "./control";
import type { CompactProfile } from "@/lib/ai/profile-input";

function compact(overrides: Partial<CompactProfile> = {}): CompactProfile {
  return {
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-08T00:00:00.000Z",
    testCount: 40,
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

function bigram(name: string, sameFinger = false, significant = true) {
  return { bigram: name, errorRate: 0.1, latencyP50: 200, n: 100, sameFinger, significant };
}

describe("selectControlTargets", () => {
  it("takes the targets ranked immediately below the treated set", () => {
    const profile = compact({
      worstBigrams: [bigram("ol"), bigram("ju"), bigram("th"), bigram("ni")],
    });
    expect(selectControlTargets(profile, "bigram", ["ol", "ju"])).toEqual(["th", "ni"]);
  });

  it("never puts a treated target in its own control", () => {
    const profile = compact({
      worstBigrams: [bigram("ol"), bigram("ju"), bigram("th")],
    });
    const control = selectControlTargets(profile, "bigram", ["ol"]);
    expect(control).not.toContain("ol");
  });

  it("matches the treated set size by default, so the two sides carry comparable n", () => {
    const profile = compact({
      worstBigrams: [
        bigram("a1"), bigram("b2"), bigram("c3"),
        bigram("d4"), bigram("e5"), bigram("f6"), bigram("g7"),
      ],
    });
    expect(selectControlTargets(profile, "bigram", ["a1", "b2", "c3"])).toEqual(["d4", "e5", "f6"]);
  });

  it("gives an SFB prescription an SFB control, not an arbitrary bigram", () => {
    // A non-SFB control would differ from the treated set in kind, not just in
    // rank, so it could not stand in as the counterfactual.
    const profile = compact({
      worstBigrams: [
        bigram("ol", true),
        bigram("th", false),
        bigram("ec", false),
        bigram("ju", true),
      ],
    });
    expect(selectControlTargets(profile, "sfb", ["ol"])).toEqual(["ju"]);
  });

  it("ranks fingers itself, since the profile emits them unordered", () => {
    const profile = compact({
      fingers: [
        { finger: "l-index", relativeLatency: 0.9, errorRate: 0.01, n: 500 },
        { finger: "r-pinky", relativeLatency: 2.1, errorRate: 0.08, n: 300 },
        { finger: "l-pinky", relativeLatency: 1.4, errorRate: 0.05, n: 320 },
      ],
    });
    expect(selectControlTargets(profile, "finger", ["r-pinky"])).toEqual(["l-pinky"]);
  });

  it("refuses to build a control for a class target", () => {
    // The taxonomy classes partition the error population, so their shares are
    // mechanically coupled — a "control class" would move for reasons that
    // have nothing to do with the counterfactual.
    const profile = compact({
      errorTaxonomy: [
        { class: "substitution", count: 40 },
        { class: "transposition", count: 12 },
      ],
    });
    expect(selectControlTargets(profile, "class", ["transposition"])).toEqual([]);
  });

  it("returns empty rather than a partial control when the ranking is exhausted", () => {
    const profile = compact({ worstBigrams: [bigram("ol")] });
    expect(selectControlTargets(profile, "bigram", ["ol"])).toEqual([]);
  });

  it("returns empty when the profile carries no rows of that type", () => {
    expect(selectControlTargets(compact(), "key", ["a"])).toEqual([]);
  });

  it("matches treated targets case-insensitively", () => {
    const profile = compact({ worstBigrams: [bigram("TH"), bigram("ol")] });
    expect(selectControlTargets(profile, "bigram", ["th"])).toEqual(["ol"]);
  });
});
