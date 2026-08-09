/**
 * Compacts a MetricProfile into the payload actually sent to the model.
 *
 * Two rules, both enforced by tests in profile-input.test.ts:
 *
 *   1. Raw KeyEvents never appear. The model is bad at statistics and the
 *      payload would be enormous — the stats engine has already done the maths
 *      (docs/ARCHITECTURE.md §5.1).
 *   2. Every number carries its `n`. A finding without a sample size cannot be
 *      written, so a number without one has no business being here.
 *
 * Anything below MIN_FINDING_N is dropped rather than sent with a caveat: a
 * model given a shaky number will find a way to use it.
 */

import type { MetricProfile, BigramStat, KeyStat, FingerStat } from "@/lib/types";

/** One measurement as the model sees it: a value, its units, and its n. */
export type ProfileNumber = {
  label: string;
  value: number;
  unit: "wpm" | "percent" | "ms" | "ratio" | "count";
  n: number;
};

export type CompactProfile = {
  windowStart: string;
  windowEnd: string;
  testCount: number;
  overall: ProfileNumber[];
  worstBigrams: {
    bigram: string;
    errorRate: number;
    latencyP50: number;
    n: number;
    sameFinger: boolean;
  }[];
  worstKeys: { key: string; errorRate: number; latencyP50: number; n: number }[];
  fingers: {
    finger: string;
    relativeLatency: number;
    errorRate: number;
    n: number;
  }[];
  errorTaxonomy: { class: string; count: number }[];
  topConfusions: { intended: string; typed: string; count: number }[];
  corrections: { backspaceRate: number; meanCharsToNotice: number | null; n: number };
  trend: { wpmDelta: number; accuracyDelta: number; comparedToDays: number };
};

const TOP_BIGRAMS = 20;
const TOP_KEYS = 10;
const TOP_CONFUSIONS = 10;

function reportable<T extends { n: number }>(rows: T[], minN: number): T[] {
  return rows.filter((r) => r.n >= minN);
}

export function buildCompactProfile(
  profile: MetricProfile,
  minN: number,
): CompactProfile {
  const overall: ProfileNumber[] = [];
  const push = (
    label: string,
    m: { value: number; n: number; reportable: boolean },
    unit: ProfileNumber["unit"],
  ) => {
    if (m.reportable) overall.push({ label, value: m.value, unit, n: m.n });
  };
  push("wpm", profile.overall.wpm, "wpm");
  push("accuracy", profile.overall.accuracy, "percent");
  push("consistency", profile.overall.consistency, "percent");

  return {
    windowStart: profile.windowStart,
    windowEnd: profile.windowEnd,
    testCount: profile.testCount,
    overall,
    worstBigrams: reportable<BigramStat>(profile.worstBigrams, minN)
      .slice(0, TOP_BIGRAMS)
      .map((b) => ({
        bigram: b.bigram,
        errorRate: b.errorRate,
        latencyP50: b.latencyP50,
        n: b.n,
        sameFinger: b.sameFinger,
      })),
    worstKeys: reportable<KeyStat>(profile.worstKeys, minN)
      .slice(0, TOP_KEYS)
      .map((k) => ({
        key: k.key,
        errorRate: k.errorRate,
        latencyP50: k.latencyP50,
        n: k.n,
      })),
    fingers: reportable<FingerStat>(profile.fingers, minN).map((f) => ({
      finger: f.finger,
      relativeLatency: f.relativeLatency,
      errorRate: f.errorRate,
      n: f.n,
    })),
    errorTaxonomy: Object.entries(profile.errorTaxonomy).map(
      ([className, count]) => ({ class: className, count }),
    ),
    topConfusions: profile.topConfusions.slice(0, TOP_CONFUSIONS),
    corrections: {
      backspaceRate: profile.corrections.backspaceRate,
      meanCharsToNotice: profile.corrections.meanCharsToNotice.reportable
        ? profile.corrections.meanCharsToNotice.value
        : null,
      n: profile.corrections.meanCharsToNotice.n,
    },
    trend: profile.trend,
  };
}

/**
 * Every number the model is allowed to cite. The hallucination guard in
 * parse.ts checks findings against this set — see its header for why the set is
 * built here rather than re-walking the MetricProfile.
 *
 * The prescription context must be passed whenever one was sent to the model:
 * the prompt asks it to open the summary with the previous cycle's
 * baseline -> outcome figures, and a number the model is told to cite but that
 * is missing from this set would be rejected as a hallucination.
 */
export function collectAllowedNumbers(
  compact: CompactProfile,
  extra?: unknown,
): number[] {
  const out: number[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "number" && Number.isFinite(node)) {
      out.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  };
  walk(compact);
  if (extra !== undefined) walk(extra);
  return out;
}
