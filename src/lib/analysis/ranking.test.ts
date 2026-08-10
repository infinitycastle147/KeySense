import { describe, expect, it } from "vitest";
import {
  fitBetaPrior,
  shrinkRate,
  binomialUpperTailP,
  benjaminiHochberg,
  rankWeaknesses,
  DEFAULT_FDR_Q,
  type RankableRow,
} from "./ranking";

function row(n: number, errorRate: number, latencyP50 = 200): RankableRow {
  const errors = Math.round(n * errorRate);
  return { n, errors, errorRate: errors / n, latencyP50 };
}

/** A realistic background population: many rows near a common low rate. */
function population(count: number, n = 200, rate = 0.05): RankableRow[] {
  return Array.from({ length: count }, (_, i) => row(n, rate + (i % 5) * 0.002));
}

describe("fitBetaPrior", () => {
  it("centres on the pooled rate, not the unweighted mean of rates", () => {
    // One huge clean row and one small dirty row. An unweighted mean of rates
    // would land near 0.30; the pooled truth is far lower, and the noisy row
    // must not get to define the prior meant to correct it.
    const prior = fitBetaPrior([row(10000, 0.02), row(40, 0.6)]);
    expect(prior.mean).toBeLessThan(0.05);
  });

  it("falls back to a weak prior when there is nothing to fit", () => {
    expect(fitBetaPrior([]).strength).toBe(2);
    expect(fitBetaPrior([row(100, 0.05)]).strength).toBe(2);
  });

  it("falls back rather than fitting a degenerate all-identical population", () => {
    const identical = Array.from({ length: 20 }, () => row(100, 0.05));
    expect(fitBetaPrior(identical).strength).toBe(2);
  });

  it("produces a stronger prior when the population is tightly clustered", () => {
    // n large enough that the intended spread survives rounding to whole
    // error counts — at n=200 a 0.001 difference rounds away entirely and the
    // population becomes degenerate rather than tight.
    const tight = Array.from({ length: 40 }, (_, i) => row(2000, 0.05 + (i % 3) * 0.005));
    const loose = Array.from({ length: 40 }, (_, i) => row(2000, 0.05 + (i % 3) * 0.08));
    expect(fitBetaPrior(tight).strength).toBeGreaterThan(fitBetaPrior(loose).strength);
  });
});

describe("shrinkRate", () => {
  it("pulls a small-sample extreme hard toward the population rate", () => {
    const rows = [...population(60), row(30, 0.5)];
    const prior = fitBetaPrior(rows);
    const shrunk = shrinkRate(row(30, 0.5), prior);
    expect(shrunk).toBeLessThan(0.5);
    expect(shrunk).toBeGreaterThan(prior.mean);
  });

  it("barely moves a large-sample estimate", () => {
    const rows = [...population(60), row(5000, 0.5)];
    const prior = fitBetaPrior(rows);
    expect(shrinkRate(row(5000, 0.5), prior)).toBeGreaterThan(0.4);
  });

  it("moves a small sample more than a large one at the same observed rate", () => {
    const rows = [...population(60), row(30, 0.4), row(3000, 0.4)];
    const prior = fitBetaPrior(rows);
    const small = shrinkRate(row(30, 0.4), prior);
    const large = shrinkRate(row(3000, 0.4), prior);
    expect(0.4 - small).toBeGreaterThan(0.4 - large);
  });
});

describe("binomialUpperTailP", () => {
  it("is small when the row is far worse than baseline", () => {
    expect(binomialUpperTailP(60, 200, 0.05)).toBeLessThan(0.001);
  });

  it("is large when the row sits at baseline", () => {
    expect(binomialUpperTailP(10, 200, 0.05)).toBeGreaterThan(0.2);
  });

  it("is bounded and finite at the degenerate edges", () => {
    expect(binomialUpperTailP(0, 0, 0.5)).toBe(1);
    expect(binomialUpperTailP(1, 10, 0)).toBe(0);
    expect(binomialUpperTailP(1, 10, 1)).toBe(1);
  });
});

describe("benjaminiHochberg", () => {
  it("rejects nothing when every p-value is large", () => {
    expect(benjaminiHochberg([0.6, 0.7, 0.9], 0.1)).toEqual([false, false, false]);
  });

  it("rejects the clearly significant ones", () => {
    const result = benjaminiHochberg([0.0001, 0.0002, 0.9, 0.8], 0.1);
    expect(result).toEqual([true, true, false, false]);
  });

  it("returns verdicts in the caller's original order", () => {
    expect(benjaminiHochberg([0.9, 0.0001], 0.1)).toEqual([false, true]);
  });

  it("is stricter than an uncorrected threshold as the candidate count grows", () => {
    // p = 0.04 would pass an uncorrected 0.05 test. Among 100 candidates that
    // are otherwise all null, it is exactly the kind of finding BH exists to
    // suppress.
    const many = [0.04, ...Array.from({ length: 99 }, () => 0.9)];
    expect(benjaminiHochberg(many, 0.1)[0]).toBe(false);
  });

  it("gives tied p-values the same verdict", () => {
    const result = benjaminiHochberg([0.001, 0.001, 0.9], 0.1);
    expect(result[0]).toBe(result[1]);
  });

  it("handles an empty input", () => {
    expect(benjaminiHochberg([], 0.1)).toEqual([]);
  });
});

describe("rankWeaknesses", () => {
  it("does not let a lucky small sample outrank a solid larger one", () => {
    // The defect: sorting on the raw rate puts the 30-sample row first, it is
    // then drilled, and it then "improves" on its own.
    //
    // The background here is deliberately homogeneous — a few hundred bigrams
    // clustered around one typist's usual rate — because that is what makes
    // the prior strong enough to be worth trusting. Shrinkage is not a fixed
    // discount: when the population really is heterogeneous, the fitted prior
    // is weak and a small sample is correctly left near its observed value.
    const background = Array.from({ length: 300 }, (_, i) => row(2000, 0.05 + (i % 3) * 0.0005));
    const lucky = row(30, 0.5);
    const real = row(3000, 0.12);
    const ranked = rankWeaknesses([...background, lucky, real]);

    expect(ranked[0].row).toBe(real);
    // The raw sort would have disagreed — that's the whole point.
    expect(lucky.errorRate).toBeGreaterThan(real.errorRate);
  });

  it("suppresses noise in a large scan: nothing is a discovery when nothing is real", () => {
    // 300 candidates all drawn from the same rate, with the jitter you would
    // expect from finite samples. An uncorrected top-10 would confidently name
    // ten weaknesses here.
    const rows = Array.from({ length: 300 }, (_, i) => row(200, 0.05 + ((i * 7) % 11) * 0.002));
    const ranked = rankWeaknesses(rows);
    expect(ranked.filter((r) => r.significant)).toHaveLength(0);
  });

  it("still finds a genuinely bad target hiding in a large scan", () => {
    const rows = [...population(300), row(400, 0.45)];
    const ranked = rankWeaknesses(rows);
    expect(ranked[0].row.errorRate).toBeCloseTo(0.45, 2);
    expect(ranked[0].significant).toBe(true);
  });

  it("keeps the raw rate alongside the shrunken one so the correction stays inspectable", () => {
    const ranked = rankWeaknesses([...population(50), row(30, 0.5)]);
    const extreme = ranked.find((r) => r.rawErrorRate === 0.5);
    expect(extreme).toBeDefined();
    expect(extreme!.shrunkErrorRate).toBeLessThan(extreme!.rawErrorRate);
  });

  it("breaks ties on latency, so the slower of two equals is the better target", () => {
    const slow = row(200, 0.05, 400);
    const fast = row(200, 0.05, 100);
    const ranked = rankWeaknesses([slow, fast]);
    expect(ranked[0].row).toBe(slow);
  });

  it("annotates rather than filters, leaving the drop decision to the caller", () => {
    const ranked = rankWeaknesses([...population(300), row(400, 0.45)], DEFAULT_FDR_Q);
    expect(ranked.length).toBe(301);
  });

  it("handles an empty input", () => {
    expect(rankWeaknesses([])).toEqual([]);
  });
});

describe("rankWeaknesses — the FDR gate only engages when multiplicity is real", () => {
  it("does not suppress a lone candidate, which would otherwise never be a discovery", () => {
    // With one row, the row IS the population: its p-value against the fitted
    // mean is ~0.5 by construction, so an unconditional BH gate would discard
    // even a catastrophic weakness.
    const ranked = rankWeaknesses([row(400, 0.4)]);
    expect(ranked[0].significant).toBe(true);
  });

  it("engages once there are enough candidates for flukes to be likely", () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(200, 0.05 + ((i * 7) % 11) * 0.002));
    expect(rankWeaknesses(rows).every((r) => !r.significant)).toBe(true);
  });
});
