import { describe, expect, it } from "vitest";
import { buildTimeLossModel, combinedWpmCost, FLOOR_PERCENTILE } from "./timeloss";
import type { BigramStat } from "@/lib/types";

function bigram(name: string, n: number, latencyP50: number, errorRate = 0.02): BigramStat {
  return {
    bigram: name,
    n,
    errors: Math.round(n * errorRate),
    errorRate,
    errorRateCI: { low: 0, high: 1 },
    latencyP50,
    sameFinger: false,
  };
}

/** A typist whose ordinary transitions run ~150ms. */
function baseline(count = 30, n = 300, latency = 150): BigramStat[] {
  return Array.from({ length: count }, (_, i) => bigram(`b${i}`, n, latency));
}

describe("buildTimeLossModel", () => {
  it("ranks by impact, not by error rate", () => {
    // The defect: `rare` has five times the error rate, but occurs so seldom
    // that fixing it would buy almost nothing. `common` is where the time goes.
    const rows = [
      ...baseline(),
      bigram("rare", 40, 400, 0.45),
      bigram("common", 900, 260, 0.09),
    ];
    const model = buildTimeLossModel(rows);

    expect(model.losses[0].bigram).toBe("common");
    const rare = model.losses.find((l) => l.bigram === "rare")!;
    expect(model.losses[0].wpmCost).toBeGreaterThan(rare.wpmCost);
  });

  it("derives the floor from the typist's own fastest transitions", () => {
    const model = buildTimeLossModel([
      ...baseline(20, 100, 120),
      ...baseline(20, 100, 300).map((b, i) => bigram(`slow${i}`, 100, 300)),
    ]);
    // Not a population norm and not the median — a percentile of their own data.
    expect(model.floorMs).toBe(120);
    expect(FLOOR_PERCENTILE).toBeLessThan(50);
  });

  it("charges nothing to a bigram already at the floor", () => {
    const model = buildTimeLossModel([...baseline(), bigram("fast", 300, 100)]);
    const fast = model.losses.find((l) => l.bigram === "fast")!;
    expect(fast.excessMs).toBe(0);
    expect(fast.wpmCost).toBe(0);
  });

  it("produces a WPM cost of a believable magnitude", () => {
    // 900 occurrences at 110ms above a 150ms floor is 99 seconds of a window
    // that is otherwise ~1.4 minutes of transitions — a large, real cost.
    const model = buildTimeLossModel([...baseline(), bigram("ol", 900, 260)]);
    const ol = model.losses.find((l) => l.bigram === "ol")!;
    expect(ol.lostMs).toBeCloseTo(900 * 110, 0);
    expect(ol.wpmCost).toBeGreaterThan(1);
    expect(ol.wpmCost).toBeLessThan(40);
  });

  it("reports a baseline speed consistent with the data it was built from", () => {
    // 300 transitions at exactly 200ms = 60s for 300 chars = 60 WPM.
    const model = buildTimeLossModel([bigram("aa", 300, 200)]);
    expect(model.baselineWpm).toBeCloseTo(60, 5);
  });

  it("returns an empty model rather than throwing on no eligible rows", () => {
    expect(buildTimeLossModel([]).losses).toEqual([]);
    expect(buildTimeLossModel([bigram("x", 5, 0)]).losses).toEqual([]);
  });

  it("respects a minimum sample size", () => {
    const model = buildTimeLossModel([bigram("aa", 300, 200), bigram("zz", 2, 900)], 30);
    expect(model.losses.map((l) => l.bigram)).toEqual(["aa"]);
  });
});

describe("combinedWpmCost", () => {
  it("compounds rather than adding, because WPM is chars over time", () => {
    const model = buildTimeLossModel([
      ...baseline(),
      bigram("ol", 600, 260),
      bigram("ju", 600, 250),
    ]);
    const ol = model.losses.find((l) => l.bigram === "ol")!;
    const ju = model.losses.find((l) => l.bigram === "ju")!;
    const together = combinedWpmCost(model, ["ol", "ju"]);

    // Superadditive: 1/x is convex, so time already saved makes the next
    // saving worth more. Summing the individual costs understates the total.
    expect(together).toBeGreaterThan(ol.wpmCost + ju.wpmCost);
  });

  it("is zero for targets that cost nothing", () => {
    const model = buildTimeLossModel([...baseline(), bigram("fast", 300, 100)]);
    expect(combinedWpmCost(model, ["fast"])).toBe(0);
  });

  it("matches bigrams case-insensitively", () => {
    const model = buildTimeLossModel([...baseline(), bigram("ol", 600, 300)]);
    expect(combinedWpmCost(model, ["OL"])).toBeGreaterThan(0);
  });

  it("returns 0 for an empty model", () => {
    expect(combinedWpmCost(buildTimeLossModel([]), ["ol"])).toBe(0);
  });
});
