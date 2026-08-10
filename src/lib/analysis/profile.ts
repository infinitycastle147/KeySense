/**
 * Assembles the compact MetricProfile handed to the LLM (Phase 4) from a
 * window of tests. Per docs/ARCHITECTURE.md §5.2/§5.4: a single 30s test has
 * only 1-3 occurrences of any bigram — noise. Findings only emerge pooled
 * across a window of ~20-50 tests.
 *
 * Pooling judgement call (documented per PHASE-3.md §4, which explicitly
 * leaves this open): per docs/ARCHITECTURE.md §4.1/§4.2, the durable storage
 * tier for cross-session aggregation is *per-test rollups*
 * (key_stats/bigram_stats), not raw events — "cheap cross-session
 * aggregation" is the whole point of that tier. So this module merges
 * already-computed per-test KeyStat/BigramStat/FingerStat rollups rather than
 * re-scanning raw events across the whole window:
 *
 *   - n and errors: summed exactly (no approximation — counts compose
 *     losslessly).
 *   - errorRateCI: recomputed via wilsonInterval on the *pooled* n/errors,
 *     never averaged confidence intervals (averaging CIs is not statistically
 *     meaningful).
 *   - latencyP50 / latencyP90: pooled from the stored per-test latency
 *     histograms (migration 0007, src/lib/analysis/histogram.ts), which sum
 *     bin-wise and therefore give the TRUE pooled percentile rather than an
 *     average of per-test percentiles. A median is not a mean, so no weighting
 *     of per-test medians recovers the pooled one — that was a real, if
 *     bounded, error, and it was worst exactly where it mattered most: a
 *     bigram seen twice in a test contributed a coin-flip "median" carrying
 *     full per-observation weight.
 *
 *     Rollups written before 0007 carry no histogram, and those fall back to
 *     the old n-weighted average of percentiles. The fallback is per-row, so a
 *     window mixing old and new rows uses the exact path wherever it can.
 */

import type {
  CompletedTest,
  BigramStat,
  KeyStat,
  FingerStat,
  Finger,
  ErrorTaxonomy,
  ConfusionMatrix,
  MetricProfile,
  Measured,
  TestResult,
} from "@/lib/types";
import type { LayoutIndex } from "./layout";
import { computeKeyStats } from "./keys";
import { computeBigramStats, filterSameFingerBigrams } from "./bigrams";
import { computeFingerStats } from "./fingers";
import {
  computeErrorTaxonomy,
  computeConfusionMatrix,
  computeErrorTaxonomyAligned,
  computeConfusionMatrixAligned,
  classifyConfusions,
} from "./errors";
import { computeCharClassStats, type CharClassStats } from "./charclass";
import { computeGeometry, type GeometryStats } from "./geometry";
import { computeFatigueCurve, type FatigueBucket } from "./fatigue";
import { computeCorrections, type CorrectionStats } from "./corrections";
import { computeDynamics, type DynamicsStats } from "./dynamics";
import { computeQuality, isDistracted, type QualityStats } from "./quality";
import { computeRhythm, type RhythmStats } from "./rhythm";
import { MIN_FINDING_N, median, wilsonInterval } from "./stats";
import { rankWeaknesses } from "./ranking";
import { buildTimeLossModel } from "./timeloss";
import { mergeHistograms, histogramPercentile, histogramCount } from "./histogram";

export type TestAnalysis = {
  testId: string;
  endedAt: string;
  durationMs: number;
  result: TestResult;
  keyStats: KeyStat[];
  bigramStats: BigramStat[];
  fingerStats: FingerStat[];
  errorTaxonomy: ErrorTaxonomy;
  confusionMatrix: ConfusionMatrix;
  /** False when this test predates the archived word list and had to be
   *  classified positionally. Carried so a window mixing both is visible
   *  rather than silently pooled — see computeTestAnalysis. */
  alignedClassification: boolean;
  fatigue: FatigueBucket[];
  corrections: CorrectionStats;
  /** Dwell / flight / overlap. All-zero and non-reportable for schema
   *  version 1 archives, which carry no key releases — see ./dynamics.ts. */
  dynamics: DynamicsStats;
  /** Burst/stall structure. Distinct from raw speed: someone who is
   *  fast-then-freezes types differently from someone evenly slow. */
  rhythm: RhythmStats;
  /** How much of this test was actually typing — see ./quality.ts. */
  quality: QualityStats;
  /** Shift / capitals / digits / punctuation as their own class. */
  charClasses: CharClassStats;
  /** Alternation, scissors, stretches, redirects — see ./geometry.ts. */
  geometry: GeometryStats;
};

/** Runs every Part-A metric over one completed test. The per-test building
 *  block that buildMetricProfile pools across a window. */
export function computeTestAnalysis(
  test: CompletedTest,
  layout: LayoutIndex,
  bucketSeconds = 10
): TestAnalysis {
  // Alignment is the correct classification and is used whenever the archive
  // can support it (see ./align.ts). Tests captured before `words` was
  // archived fall back to the positional reading — degraded, but honest: the
  // alternative is reconstructing an expected string that was never recorded.
  const words = test.words;
  const aligned = words !== undefined && words.length > 0;

  return {
    testId: test.id,
    endedAt: test.endedAt,
    durationMs: test.durationMs,
    result: test.result,
    keyStats: computeKeyStats(test.events),
    bigramStats: computeBigramStats(test.events, layout),
    fingerStats: computeFingerStats(test.events, layout),
    errorTaxonomy: aligned
      ? computeErrorTaxonomyAligned(test.events, words)
      : computeErrorTaxonomy(test.events),
    confusionMatrix: aligned
      ? computeConfusionMatrixAligned(test.events, words)
      : computeConfusionMatrix(test.events),
    alignedClassification: aligned,
    fatigue: computeFatigueCurve(test.events, test.durationMs, bucketSeconds),
    corrections: computeCorrections(test.events),
    dynamics: computeDynamics(test.events, test.keyups ?? []),
    rhythm: computeRhythm(test.events),
    quality: computeQuality(test.events, test.durationMs),
    charClasses: computeCharClassStats(test.events),
    geometry: computeGeometry(test.events, layout),
  };
}

export type BuildProfileOptions = {
  /** How many rows to keep in each top-N list. Default 10. */
  topN?: number;
  /** Config fingerprints, one per analysis in the same order (mode,
   *  punctuation, numbers, language, layout). When supplied, `configMatched`
   *  reports whether the window is homogeneous. Omitted means "unknown", which
   *  is reported as not matched — the conservative reading. */
  configFingerprints?: string[];
  /** Must match the bucketSeconds used when the TestAnalyses were built. */
  bucketSeconds?: number;
  /** A prior window (e.g. the same-length window ending N days earlier) to
   *  diff the trend against. Baseline is always the user's own history —
   *  never a population norm — so this must come from the caller, not from
   *  any hardcoded norm. */
  previousWindow?: TestAnalysis[];
  /** Needed to attach a root cause to each confusion (see classifyConfusions).
   *  Optional: without it the pairs are still reported, just unexplained —
   *  better than guessing a cause from a layout that may not be the one the
   *  tests were typed on. */
  layout?: LayoutIndex;
};

const DEFAULT_TOP_N = 10;
const DEFAULT_BUCKET_SECONDS = 10;

function weightedAverage(pairs: { value: number; weight: number }[]): number {
  let sum = 0;
  let weight = 0;
  for (const p of pairs) {
    sum += p.value * p.weight;
    weight += p.weight;
  }
  return weight > 0 ? sum / weight : 0;
}

function measured(values: number[], n: number): Measured<number> {
  return { value: median(values), n, reportable: n >= MIN_FINDING_N };
}

/**
 * Pools a percentile across a window.
 *
 * Prefers summing the stored distributions, which gives the true pooled
 * percentile. Falls back to the n-weighted average of per-test percentiles for
 * rollups written before histograms existed — documented in the module header
 * as an approximation, and now only used where nothing better survives.
 */
function poolPercentile(
  histograms: (number[] | undefined)[],
  fallback: { value: number; weight: number }[],
  p: number,
): number {
  const present = histograms.filter((h): h is number[] => Array.isArray(h) && h.length > 0);
  if (present.length > 0) {
    const merged = mergeHistograms(present);
    if (histogramCount(merged) > 0) return histogramPercentile(merged, p);
  }
  return weightedAverage(fallback);
}

function mergeKeyStats(analyses: TestAnalysis[]): KeyStat[] {
  type Acc = {
    n: number;
    errors: number;
    p50s: { value: number; weight: number }[];
    p90s: { value: number; weight: number }[];
    hists: (number[] | undefined)[];
  };
  const groups = new Map<string, Acc>();

  for (const analysis of analyses) {
    for (const ks of analysis.keyStats) {
      const acc = groups.get(ks.key) ?? { n: 0, errors: 0, p50s: [], p90s: [], hists: [] };
      acc.n += ks.n;
      acc.errors += ks.errors;
      acc.p50s.push({ value: ks.latencyP50, weight: ks.n });
      acc.p90s.push({ value: ks.latencyP90, weight: ks.n });
      acc.hists.push(ks.latencyHist);
      groups.set(ks.key, acc);
    }
  }

  const merged: KeyStat[] = [];
  for (const [key, acc] of groups) {
    merged.push({
      key,
      n: acc.n,
      errors: acc.errors,
      errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
      errorRateCI: wilsonInterval(acc.errors, acc.n),
      latencyP50: poolPercentile(acc.hists, acc.p50s, 50),
      latencyP90: poolPercentile(acc.hists, acc.p90s, 90),
    });
  }
  return merged;
}

function mergeBigramStats(analyses: TestAnalysis[]): BigramStat[] {
  type Acc = {
    n: number;
    errors: number;
    p50s: { value: number; weight: number }[];
    hists: (number[] | undefined)[];
    sameFinger: boolean;
  };
  const groups = new Map<string, Acc>();

  for (const analysis of analyses) {
    for (const bs of analysis.bigramStats) {
      const acc = groups.get(bs.bigram) ?? { n: 0, errors: 0, p50s: [], hists: [], sameFinger: bs.sameFinger };
      acc.n += bs.n;
      acc.errors += bs.errors;
      acc.p50s.push({ value: bs.latencyP50, weight: bs.n });
      acc.hists.push(bs.latencyHist);
      acc.sameFinger = acc.sameFinger || bs.sameFinger;
      groups.set(bs.bigram, acc);
    }
  }

  const merged: BigramStat[] = [];
  for (const [bigram, acc] of groups) {
    merged.push({
      bigram,
      n: acc.n,
      errors: acc.errors,
      errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
      errorRateCI: wilsonInterval(acc.errors, acc.n),
      latencyP50: poolPercentile(acc.hists, acc.p50s, 50),
      sameFinger: acc.sameFinger,
    });
  }
  return merged;
}

function mergeFingerStats(analyses: TestAnalysis[]): FingerStat[] {
  type Acc = {
    n: number;
    errors: number;
    p50s: { value: number; weight: number }[];
    adjusted: { value: number; weight: number }[];
  };
  const groups = new Map<Finger, Acc>();

  for (const analysis of analyses) {
    for (const fs of analysis.fingerStats) {
      const acc = groups.get(fs.finger) ?? { n: 0, errors: 0, p50s: [], adjusted: [] };
      acc.n += fs.n;
      acc.errors += Math.round(fs.errorRate * fs.n);
      acc.p50s.push({ value: fs.latencyP50, weight: fs.n });
      // Tests that couldn't fit the model contribute nothing rather than a 0,
      // which would read as "perfectly average" instead of "unknown".
      if (fs.relativeAdjusted !== undefined) {
        acc.adjusted.push({ value: fs.relativeAdjusted, weight: fs.n });
      }
      groups.set(fs.finger, acc);
    }
  }

  const latencyByFinger = new Map<Finger, number>();
  for (const [finger, acc] of groups) {
    latencyByFinger.set(finger, weightedAverage(acc.p50s));
  }

  const overallBaseline = weightedAverage(
    Array.from(groups.entries()).map(([finger, acc]) => ({
      value: latencyByFinger.get(finger) ?? 0,
      weight: acc.n,
    }))
  );

  const merged: FingerStat[] = [];
  for (const [finger, acc] of groups) {
    const latencyP50 = latencyByFinger.get(finger) ?? 0;
    merged.push({
      finger,
      n: acc.n,
      errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
      latencyP50,
      relativeLatency: latencyP50 > 0 && overallBaseline > 0 ? latencyP50 / overallBaseline : 0,
      ...(acc.adjusted.length > 0
        ? { relativeAdjusted: weightedAverage(acc.adjusted) }
        : {}),
    });
  }
  return merged;
}

function mergeErrorTaxonomy(analyses: TestAnalysis[]): ErrorTaxonomy {
  const taxonomy: ErrorTaxonomy = { substitution: 0, insertion: 0, omission: 0, transposition: 0 };
  for (const analysis of analyses) {
    for (const key of Object.keys(taxonomy) as (keyof ErrorTaxonomy)[]) {
      taxonomy[key] += analysis.errorTaxonomy[key];
    }
  }
  return taxonomy;
}

function mergeConfusionMatrix(analyses: TestAnalysis[]): ConfusionMatrix {
  const matrix: ConfusionMatrix = {};
  for (const analysis of analyses) {
    for (const [intended, row] of Object.entries(analysis.confusionMatrix)) {
      const target = matrix[intended] ?? {};
      for (const [typed, count] of Object.entries(row)) {
        target[typed] = (target[typed] ?? 0) + count;
      }
      matrix[intended] = target;
    }
  }
  return matrix;
}

function topConfusionsFromMatrix(
  matrix: ConfusionMatrix,
  topN: number
): { intended: string; typed: string; count: number }[] {
  const flat: { intended: string; typed: string; count: number }[] = [];
  for (const [intended, row] of Object.entries(matrix)) {
    for (const [typed, count] of Object.entries(row)) {
      flat.push({ intended, typed, count });
    }
  }
  return flat.sort((a, b) => b.count - a.count).slice(0, topN);
}

function mergeFatigue(
  analyses: TestAnalysis[],
  bucketSeconds: number
): { bucketSeconds: number; wpm: number[] } {
  const maxBuckets = analyses.reduce((max, a) => Math.max(max, a.fatigue.length), 0);
  const wpm: number[] = [];
  for (let i = 0; i < maxBuckets; i++) {
    const contributions: { value: number; weight: number }[] = [];
    for (const analysis of analyses) {
      const bucket = analysis.fatigue[i];
      if (bucket && bucket.n > 0) contributions.push({ value: bucket.wpm, weight: bucket.n });
    }
    wpm.push(weightedAverage(contributions));
  }
  return { bucketSeconds, wpm };
}

function mergeCorrections(analyses: TestAnalysis[]): { backspaceRate: number; meanCharsToNotice: Measured<number> } {
  let backspaceCount = 0;
  let charAttemptCount = 0;
  let noticeN = 0;
  const noticeContributions: { value: number; weight: number }[] = [];

  for (const analysis of analyses) {
    backspaceCount += analysis.corrections.backspaceCount;
    charAttemptCount += analysis.corrections.charAttemptCount;
    noticeN += analysis.corrections.meanCharsToNotice.n;
    if (analysis.corrections.meanCharsToNotice.n > 0) {
      noticeContributions.push({
        value: analysis.corrections.meanCharsToNotice.value,
        weight: analysis.corrections.meanCharsToNotice.n,
      });
    }
  }

  return {
    backspaceRate: charAttemptCount > 0 ? backspaceCount / charAttemptCount : 0,
    meanCharsToNotice: {
      value: weightedAverage(noticeContributions),
      n: noticeN,
      reportable: noticeN >= MIN_FINDING_N,
    },
  };
}

/**
 * Ranks by *shrunken* error rate and keeps only rows that survive FDR control
 * — see ./ranking.ts for why sorting on the raw rate manufactures findings.
 *
 * The n >= MIN_FINDING_N gate still runs first, and is not redundant with the
 * statistics: it is a floor on whether a row is worth *considering at all*,
 * where shrinkage and FDR then decide whether it is worth *reporting*. Fitting
 * the prior on rows that already cleared the floor also keeps a swarm of
 * 2-observation bigrams from defining the population everything else is
 * corrected against.
 *
 * Non-discoveries are dropped rather than shown greyed-out: this list feeds
 * the model and the prescription flow, and anything present in it is liable to
 * be treated as a real weakness regardless of an accompanying flag.
 */
function rankByBadness<T extends BigramStat | KeyStat>(stats: T[], topN: number): T[] {
  const eligible = stats.filter((s) => s.n >= MIN_FINDING_N);
  return rankWeaknesses(eligible)
    .filter((r) => r.significant)
    .slice(0, topN)
    .map((r) => r.row);
}

/** Pools rhythm across the window. Burst and stall are reported as *rates*
 *  rather than counts: a count conflates "types erratically" with "typed a
 *  lot", and only the first is a finding. */
function mergeRhythm(analyses: TestAnalysis[]) {
  const ikis: { value: number; weight: number }[] = [];
  const cvs: { value: number; weight: number }[] = [];
  let bursts = 0;
  let stalls = 0;
  let n = 0;

  for (const a of analyses) {
    if (a.rhythm.n === 0) continue;
    ikis.push({ value: a.rhythm.medianIki, weight: a.rhythm.n });
    cvs.push({ value: a.rhythm.coefficientOfVariation, weight: a.rhythm.n });
    bursts += a.rhythm.burstCount;
    stalls += a.rhythm.stallCount;
    n += a.rhythm.n;
  }

  return {
    medianIki: weightedAverage(ikis),
    coefficientOfVariation: weightedAverage(cvs),
    burstRate: n > 0 ? bursts / n : 0,
    stallRate: n > 0 ? stalls / n : 0,
    n,
  };
}

/** Pools dwell/flight/overlap over the tests that actually have releases.
 *  Version-1 tests contribute nothing rather than zeros, which would drag
 *  every figure toward zero and read as "this typist holds keys for 0ms". */
function mergeDynamics(analyses: TestAnalysis[]) {
  const dwell: { value: number; weight: number }[] = [];
  const flight: { value: number; weight: number }[] = [];
  const overlap: { value: number; weight: number }[] = [];
  let n = 0;

  for (const a of analyses) {
    const d = a.dynamics;
    if (d.dwellP50.n === 0) continue;
    dwell.push({ value: d.dwellP50.value, weight: d.dwellP50.n });
    flight.push({ value: d.flightP50.value, weight: d.flightP50.n });
    overlap.push({ value: d.overlapRate.value, weight: d.overlapRate.n });
    n += d.dwellP50.n;
  }

  return {
    available: n > 0,
    dwellP50: weightedAverage(dwell),
    flightP50: weightedAverage(flight),
    overlapRate: weightedAverage(overlap),
    n,
  };
}

/** Pools data quality. `discardRate` comes from pooled counts, not an average
 *  of per-test rates — one 4-keystroke test with a single pause would
 *  otherwise dominate a window of clean long ones. */
function mergeQuality(analyses: TestAnalysis[]) {
  let intervals = 0;
  let discarded = 0;
  let distracted = 0;

  for (const a of analyses) {
    intervals += a.quality.intervalCount;
    discarded += a.quality.discardedCount;
    if (isDistracted(a.quality)) distracted += 1;
  }

  return {
    discardRate: intervals > 0 ? discarded / intervals : 0,
    distractedTests: distracted,
    testCount: analyses.length,
  };
}

/** Pools per-class stats. Rates come from pooled counts; `relativeToLowercase`
 *  is recomputed from pooled latencies rather than averaged, since a ratio of
 *  averages is not the average of ratios. */
function mergeCharClasses(analyses: TestAnalysis[]) {
  const groups = new Map<string, { n: number; errors: number; lat: { value: number; weight: number }[] }>();

  for (const a of analyses) {
    for (const c of a.charClasses.classes) {
      const acc = groups.get(c.charClass) ?? { n: 0, errors: 0, lat: [] };
      acc.n += c.n;
      acc.errors += c.errors;
      if (c.latencyP50 > 0) acc.lat.push({ value: c.latencyP50, weight: c.n });
      groups.set(c.charClass, acc);
    }
  }

  const latencyOf = (name: string) => {
    const acc = groups.get(name);
    return acc ? weightedAverage(acc.lat) : 0;
  };
  const lowercase = latencyOf("lowercase");

  return [...groups.entries()].map(([charClass, acc]) => {
    const latency = weightedAverage(acc.lat);
    return {
      charClass,
      n: acc.n,
      errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
      relativeToLowercase: lowercase > 0 && latency > 0 ? latency / lowercase : 0,
    };
  });
}

function mergeShift(analyses: TestAnalysis[]) {
  let shiftedN = 0;
  let shiftedErrors = 0;
  let unshiftedN = 0;
  let unshiftedErrors = 0;

  for (const a of analyses) {
    const s = a.charClasses;
    shiftedN += s.shiftedErrorRate.n;
    shiftedErrors += s.shiftedErrorRate.value * s.shiftedErrorRate.n;
    unshiftedN += s.unshiftedErrorRate.n;
    unshiftedErrors += s.unshiftedErrorRate.value * s.unshiftedErrorRate.n;
  }

  return {
    shiftedErrorRate: shiftedN > 0 ? shiftedErrors / shiftedN : 0,
    unshiftedErrorRate: unshiftedN > 0 ? unshiftedErrors / unshiftedN : 0,
    n: shiftedN,
  };
}

function mergeGeometry(analyses: TestAnalysis[]) {
  const groups = new Map<string, { n: number; errors: number; lat: { value: number; weight: number }[] }>();
  const alternations: { value: number; weight: number }[] = [];
  const runs: { value: number; weight: number }[] = [];
  const redirects: { value: number; weight: number }[] = [];
  let n = 0;

  for (const a of analyses) {
    for (const shape of a.geometry.shapes) {
      const acc = groups.get(shape.shape) ?? { n: 0, errors: 0, lat: [] };
      acc.n += shape.n;
      acc.errors += shape.errors;
      if (shape.latencyP50 > 0) acc.lat.push({ value: shape.latencyP50, weight: shape.n });
      groups.set(shape.shape, acc);
    }
    if (a.geometry.alternationRate.n > 0) {
      alternations.push({ value: a.geometry.alternationRate.value, weight: a.geometry.alternationRate.n });
      runs.push({ value: a.geometry.medianSameHandRun, weight: a.geometry.alternationRate.n });
      n += a.geometry.alternationRate.n;
    }
    if (a.geometry.redirectRate.n > 0) {
      redirects.push({ value: a.geometry.redirectRate.value, weight: a.geometry.redirectRate.n });
    }
  }

  return {
    shapes: [...groups.entries()].map(([shape, acc]) => ({
      shape,
      n: acc.n,
      errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
      latencyP50: weightedAverage(acc.lat),
    })),
    alternationRate: weightedAverage(alternations),
    medianSameHandRun: weightedAverage(runs),
    redirectRate: weightedAverage(redirects),
    n,
  };
}

/** Impact ranking, alongside the error-rate ranking. Gated at MIN_FINDING_N
 *  like everything else — a WPM cost computed from three observations is a
 *  precise-looking number with nothing behind it. */
function buildTimeLoss(bigrams: BigramStat[], topN: number) {
  const model = buildTimeLossModel(bigrams, MIN_FINDING_N);
  return {
    floorMs: model.floorMs,
    baselineWpm: model.baselineWpm,
    top: model.losses.slice(0, topN).map((l) => ({
      bigram: l.bigram,
      n: l.n,
      excessMs: l.excessMs,
      wpmCost: l.wpmCost,
    })),
  };
}

/** A window is config-matched when every test in it was the same task. Unknown
 *  fingerprints report false: claiming a match we cannot verify would let a
 *  mixed-workload trend be read as a skill trend. */
function isConfigMatched(fingerprints: string[] | undefined): boolean {
  if (!fingerprints || fingerprints.length === 0) return false;
  return fingerprints.every((f) => f === fingerprints[0]);
}

function emptyProfile(bucketSeconds: number): MetricProfile {
  return {
    windowStart: "",
    windowEnd: "",
    testCount: 0,
    overall: {
      wpm: { value: 0, n: 0, reportable: false },
      accuracy: { value: 0, n: 0, reportable: false },
      consistency: { value: 0, n: 0, reportable: false },
    },
    worstBigrams: [],
    worstKeys: [],
    fingers: [],
    errorTaxonomy: { substitution: 0, insertion: 0, omission: 0, transposition: 0 },
    topConfusions: [],
    sameFingerBigrams: [],
    fatigue: { bucketSeconds, wpm: [] },
    corrections: { backspaceRate: 0, meanCharsToNotice: { value: 0, n: 0, reportable: false } },
    rhythm: { medianIki: 0, coefficientOfVariation: 0, burstRate: 0, stallRate: 0, n: 0 },
    dynamics: { available: false, dwellP50: 0, flightP50: 0, overlapRate: 0, n: 0 },
    quality: { discardRate: 0, distractedTests: 0, testCount: 0 },
    charClasses: [],
    shift: { shiftedErrorRate: 0, unshiftedErrorRate: 0, n: 0 },
    geometry: { shapes: [], alternationRate: 0, medianSameHandRun: 0, redirectRate: 0, n: 0 },
    classifiedConfusions: [],
    timeLoss: { floorMs: 0, baselineWpm: 0, top: [] },
    configMatched: false,
    trend: { wpmDelta: 0, accuracyDelta: 0, comparedToDays: 0 },
  };
}

/** Pools a window of per-test analyses into the compact profile the LLM
 *  receives. Empty input returns a well-formed all-zero, non-reportable
 *  profile rather than throwing. */
export function buildMetricProfile(analyses: TestAnalysis[], opts: BuildProfileOptions = {}): MetricProfile {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const bucketSeconds = opts.bucketSeconds ?? DEFAULT_BUCKET_SECONDS;

  if (analyses.length === 0) return emptyProfile(bucketSeconds);

  const sorted = [...analyses].sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  const windowStart = sorted[0].endedAt;
  const windowEnd = sorted[sorted.length - 1].endedAt;

  const wpmValues = analyses.map((a) => a.result.wpm);
  const accuracyValues = analyses.map((a) => a.result.accuracy);
  const consistencyValues = analyses.map((a) => a.result.consistency);

  const mergedKeyStats = mergeKeyStats(analyses);
  const mergedBigramStats = mergeBigramStats(analyses);
  const mergedFingerStats = mergeFingerStats(analyses);
  const confusionMatrix = mergeConfusionMatrix(analyses);

  let trend = { wpmDelta: 0, accuracyDelta: 0, comparedToDays: 0 };
  if (opts.previousWindow && opts.previousWindow.length > 0) {
    const prev = opts.previousWindow;
    const prevWpm = median(prev.map((a) => a.result.wpm));
    const prevAccuracy = median(prev.map((a) => a.result.accuracy));
    const prevSorted = [...prev].sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    const prevEnd = new Date(prevSorted[prevSorted.length - 1].endedAt).getTime();
    const currentStart = new Date(windowStart).getTime();
    const comparedToDays =
      Number.isFinite(prevEnd) && Number.isFinite(currentStart)
        ? Math.round((currentStart - prevEnd) / (1000 * 60 * 60 * 24))
        : 0;
    trend = {
      wpmDelta: median(wpmValues) - prevWpm,
      accuracyDelta: median(accuracyValues) - prevAccuracy,
      comparedToDays,
    };
  }

  return {
    windowStart,
    windowEnd,
    testCount: analyses.length,
    overall: {
      wpm: measured(wpmValues, analyses.length),
      accuracy: measured(accuracyValues, analyses.length),
      consistency: measured(consistencyValues, analyses.length),
    },
    worstBigrams: rankByBadness(mergedBigramStats, topN),
    worstKeys: rankByBadness(mergedKeyStats, topN),
    fingers: mergedFingerStats,
    errorTaxonomy: mergeErrorTaxonomy(analyses),
    topConfusions: topConfusionsFromMatrix(confusionMatrix, topN),
    // Same correction as worstBigrams: an SFB list ranked on raw rates would
    // reintroduce exactly the selection artifact ranking.ts removes.
    sameFingerBigrams: rankByBadness(filterSameFingerBigrams(mergedBigramStats), topN),
    fatigue: mergeFatigue(analyses, bucketSeconds),
    corrections: mergeCorrections(analyses),
    rhythm: mergeRhythm(analyses),
    dynamics: mergeDynamics(analyses),
    quality: mergeQuality(analyses),
    charClasses: mergeCharClasses(analyses),
    shift: mergeShift(analyses),
    geometry: mergeGeometry(analyses),
    classifiedConfusions: opts.layout
      ? classifyConfusions(confusionMatrix, opts.layout, topN)
      : [],
    timeLoss: buildTimeLoss(mergedBigramStats, topN),
    configMatched: isConfigMatched(opts.configFingerprints),
    trend,
  };
}
