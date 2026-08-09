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
 *   - latencyP50 / latencyP90: an n-weighted average of each test's
 *     percentile, NOT a true re-derived percentile over pooled raw samples
 *     (those raw samples aren't available at this tier). This is the
 *     "otherwise n-weighted" branch PHASE-3.md explicitly sanctions. If a
 *     caller has raw CompletedTest.events for the whole window and wants a
 *     true pooled median instead, they can concatenate events per-key/bigram
 *     themselves and call the percentile functions in stats.ts directly —
 *     computeTestAnalysis/buildMetricProfile intentionally do not do this,
 *     to mirror the production storage tier this will actually run against.
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
import { computeErrorTaxonomy, computeConfusionMatrix } from "./errors";
import { computeFatigueCurve, type FatigueBucket } from "./fatigue";
import { computeCorrections, type CorrectionStats } from "./corrections";
import { MIN_FINDING_N, median, wilsonInterval } from "./stats";

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
  fatigue: FatigueBucket[];
  corrections: CorrectionStats;
};

/** Runs every Part-A metric over one completed test. The per-test building
 *  block that buildMetricProfile pools across a window. */
export function computeTestAnalysis(
  test: CompletedTest,
  layout: LayoutIndex,
  bucketSeconds = 10
): TestAnalysis {
  return {
    testId: test.id,
    endedAt: test.endedAt,
    durationMs: test.durationMs,
    result: test.result,
    keyStats: computeKeyStats(test.events),
    bigramStats: computeBigramStats(test.events, layout),
    fingerStats: computeFingerStats(test.events, layout),
    errorTaxonomy: computeErrorTaxonomy(test.events),
    confusionMatrix: computeConfusionMatrix(test.events),
    fatigue: computeFatigueCurve(test.events, test.durationMs, bucketSeconds),
    corrections: computeCorrections(test.events),
  };
}

export type BuildProfileOptions = {
  /** How many rows to keep in each top-N list. Default 10. */
  topN?: number;
  /** Must match the bucketSeconds used when the TestAnalyses were built. */
  bucketSeconds?: number;
  /** A prior window (e.g. the same-length window ending N days earlier) to
   *  diff the trend against. Baseline is always the user's own history —
   *  never a population norm — so this must come from the caller, not from
   *  any hardcoded norm. */
  previousWindow?: TestAnalysis[];
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

function mergeKeyStats(analyses: TestAnalysis[]): KeyStat[] {
  type Acc = { n: number; errors: number; p50s: { value: number; weight: number }[]; p90s: { value: number; weight: number }[] };
  const groups = new Map<string, Acc>();

  for (const analysis of analyses) {
    for (const ks of analysis.keyStats) {
      const acc = groups.get(ks.key) ?? { n: 0, errors: 0, p50s: [], p90s: [] };
      acc.n += ks.n;
      acc.errors += ks.errors;
      acc.p50s.push({ value: ks.latencyP50, weight: ks.n });
      acc.p90s.push({ value: ks.latencyP90, weight: ks.n });
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
      latencyP50: weightedAverage(acc.p50s),
      latencyP90: weightedAverage(acc.p90s),
    });
  }
  return merged;
}

function mergeBigramStats(analyses: TestAnalysis[]): BigramStat[] {
  type Acc = { n: number; errors: number; p50s: { value: number; weight: number }[]; sameFinger: boolean };
  const groups = new Map<string, Acc>();

  for (const analysis of analyses) {
    for (const bs of analysis.bigramStats) {
      const acc = groups.get(bs.bigram) ?? { n: 0, errors: 0, p50s: [], sameFinger: bs.sameFinger };
      acc.n += bs.n;
      acc.errors += bs.errors;
      acc.p50s.push({ value: bs.latencyP50, weight: bs.n });
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
      latencyP50: weightedAverage(acc.p50s),
      sameFinger: acc.sameFinger,
    });
  }
  return merged;
}

function mergeFingerStats(analyses: TestAnalysis[]): FingerStat[] {
  type Acc = { n: number; errors: number; p50s: { value: number; weight: number }[] };
  const groups = new Map<Finger, Acc>();

  for (const analysis of analyses) {
    for (const fs of analysis.fingerStats) {
      const acc = groups.get(fs.finger) ?? { n: 0, errors: 0, p50s: [] };
      acc.n += fs.n;
      acc.errors += Math.round(fs.errorRate * fs.n);
      acc.p50s.push({ value: fs.latencyP50, weight: fs.n });
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

/** Sorted descending by errorRate, ties broken by latencyP50 descending —
 *  the simplest defensible "badness" ranking given only these two axes.
 *  Documented judgement call: a more sophisticated composite score (e.g.
 *  normalized weighted blend) is plausible future work but not required by
 *  PHASE-3.md, and premature normalization risks being harder to reason
 *  about than it's worth for a top-N display list. */
function rankByBadness<T extends { errorRate: number; latencyP50: number; n: number }>(
  stats: T[],
  topN: number
): T[] {
  return stats
    .filter((s) => s.n >= MIN_FINDING_N)
    .sort((a, b) => b.errorRate - a.errorRate || b.latencyP50 - a.latencyP50)
    .slice(0, topN);
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
    sameFingerBigrams: filterSameFingerBigrams(mergedBigramStats)
      .filter((b) => b.n >= MIN_FINDING_N)
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, topN),
    fatigue: mergeFatigue(analyses, bucketSeconds),
    corrections: mergeCorrections(analyses),
    trend,
  };
}
