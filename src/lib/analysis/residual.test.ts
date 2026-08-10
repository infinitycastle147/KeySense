import { describe, expect, it } from "vitest";
import {
  extractTransitions,
  fitResidualModel,
  computeFingerResiduals,
  type Transition,
} from "./residual";
import { charEvent, loadLayoutIndex } from "./test-utils";
import type { Finger, KeyEvent } from "@/lib/types";

const qwerty = loadLayoutIndex("qwerty");

function transition(from: Finger, to: Finger, interval: number): Transition {
  return { from, to, interval };
}

/** Repeats a transition `count` times, so medians have something to work on. */
function many(from: Finger, to: Finger, interval: number, count = 40): Transition[] {
  return Array.from({ length: count }, (_, i) =>
    // A little jitter, so nothing depends on a degenerate all-identical sample.
    transition(from, to, interval + ((i % 5) - 2)),
  );
}

describe("extractTransitions", () => {
  it("pairs consecutive char events through the layout", () => {
    const events: KeyEvent[] = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 150, expected: "s", key: "s" }),
    ];
    expect(extractTransitions(events, qwerty)).toEqual([
      { from: "l-pinky", to: "l-ring", interval: 150 },
    ]);
  });

  it("drops intervals above the outlier threshold", () => {
    const events: KeyEvent[] = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 5000, expected: "s", key: "s" }),
    ];
    expect(extractTransitions(events, qwerty)).toEqual([]);
  });

  it("does not pair across a backspace", () => {
    const events: KeyEvent[] = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      { t: 100, key: "a", expected: "a", ok: true, wordIdx: 0, charIdx: 0, prev: null, mods: [], kind: "backspace" },
      charEvent({ t: 200, expected: "s", key: "s" }),
    ];
    expect(extractTransitions(events, qwerty)).toEqual([]);
  });

  it("skips characters absent from the layout", () => {
    const events: KeyEvent[] = [
      charEvent({ t: 0, expected: "é", key: "é" }),
      charEvent({ t: 150, expected: "s", key: "s" }),
    ];
    expect(extractTransitions(events, qwerty)).toEqual([]);
  });
});

describe("fitResidualModel", () => {
  it("returns an empty model for no transitions rather than throwing", () => {
    const model = fitResidualModel([]);
    expect(model.n).toBe(0);
    expect(model.mu).toBe(0);
  });

  it("gives every finger a near-zero effect when all transitions cost the same", () => {
    const transitions = [
      ...many("l-index", "r-index", 200),
      ...many("r-index", "l-index", 200),
      ...many("l-middle", "r-middle", 200),
    ];
    const model = fitResidualModel(transitions);
    expect(model.mu).toBeCloseTo(200, 0);
    for (const effect of model.to.values()) expect(Math.abs(effect)).toBeLessThan(5);
  });

  it("attributes a genuinely slow destination finger to the destination", () => {
    const transitions = [
      ...many("l-index", "r-pinky", 300),
      ...many("r-index", "r-pinky", 300),
      ...many("l-index", "r-index", 180),
      ...many("r-index", "l-index", 180),
      ...many("l-middle", "r-index", 180),
    ];
    const model = fitResidualModel(transitions);
    expect(model.to.get("r-pinky")!).toBeGreaterThan(model.to.get("r-index")!);
  });

  it("is identifiable — repeated fits on the same data agree", () => {
    const transitions = [...many("l-index", "r-pinky", 300), ...many("l-index", "r-index", 180)];
    expect(fitResidualModel(transitions).to).toEqual(fitResidualModel(transitions).to);
  });
});

describe("computeFingerResiduals — the confound the raw marginal hides", () => {
  it("clears a fast finger that only ever gets approached from far away", () => {
    // r-pinky itself is quick, but every approach to it is expensive, and
    // every approach FROM l-pinky is expensive too. A marginal average charges
    // all of that to r-pinky and calls it the weak finger.
    const transitions = [
      ...many("l-pinky", "r-pinky", 320), // slow departure, slow arrival
      ...many("l-pinky", "r-index", 300), // same slow departure, ordinary arrival
      ...many("r-index", "r-pinky", 190), // ordinary departure, so r-pinky is fine
      ...many("r-index", "l-index", 180),
      ...many("l-index", "r-index", 180),
      ...many("l-index", "l-middle", 175),
    ];

    const model = fitResidualModel(transitions);
    const residuals = computeFingerResiduals(transitions, model);
    const pinky = residuals.find((r) => r.finger === "r-pinky")!;

    // The uncorrected number accuses the pinky…
    expect(pinky.rawRelative).toBeGreaterThan(1.1);
    // …and the correction shows most of it belonged to the approach.
    expect(pinky.relativeAdjusted).toBeLessThan(pinky.rawRelative);
  });

  it("still convicts a finger that is slow from every direction", () => {
    const transitions = [
      ...many("l-index", "r-pinky", 340),
      ...many("r-index", "r-pinky", 330),
      ...many("l-middle", "r-pinky", 335),
      ...many("l-index", "r-index", 180),
      ...many("r-index", "l-index", 180),
      ...many("l-middle", "l-index", 180),
    ];

    const model = fitResidualModel(transitions);
    const residuals = computeFingerResiduals(transitions, model);

    expect(residuals[0].finger).toBe("r-pinky");
    expect(residuals[0].relativeAdjusted).toBeGreaterThan(1.3);
  });

  it("sorts worst-adjusted first", () => {
    const transitions = [...many("l-index", "r-pinky", 320), ...many("l-index", "r-index", 180)];
    const residuals = computeFingerResiduals(transitions, fitResidualModel(transitions));
    for (let i = 1; i < residuals.length; i++) {
      expect(residuals[i - 1].relativeAdjusted).toBeGreaterThanOrEqual(residuals[i].relativeAdjusted);
    }
  });

  it("returns nothing when there is no model to speak of", () => {
    expect(computeFingerResiduals([], fitResidualModel([]))).toEqual([]);
  });
});
