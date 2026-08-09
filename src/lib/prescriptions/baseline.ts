/**
 * Extracts a Prescription's baseline or outcome metric for a given target.
 *
 * Two data sources, ONE aggregation path (`aggregate`) — that's what makes
 * "evaluate() must compare like with like" (PHASE-5.md) true in code rather
 * than by convention:
 *
 *   - `extractFromCompactProfile` reads the exact `CompactProfile` a report
 *     persisted as `input_profile` — the same numbers the model was shown
 *     when the Finding was written. Used to capture the baseline at
 *     prescription creation (src/lib/prescriptions/create.ts).
 *   - `extractFromAnalyses` pools a fresh window of `TestAnalysis` (raw
 *     per-test rollups) into a `MetricProfile` and reads from that. Used to
 *     measure the outcome after treatment (src/lib/prescriptions/evaluate.ts).
 *
 * Both funnel through `aggregate`, which sums n/errors (lossless), takes an
 * n-weighted average of latency, and applies the exact same MIN_FINDING_N
 * gate via `reportable`.
 */

import type { CompactProfile } from "@/lib/ai/profile-input";
import type { PrescriptionTargetType } from "@/lib/types";
import type { TestAnalysis } from "@/lib/analysis/profile";
import { MIN_FINDING_N } from "@/lib/analysis/stats";

export type TargetStat = {
  errorRate: number;
  latencyP50: number;
  n: number;
  /** n >= MIN_FINDING_N. A stat below this can never become a baseline or an
   *  outcome — see docs/ARCHITECTURE.md §5.3. */
  reportable: boolean;
};

type Row = { n: number; errors: number; latencyP50: number };

/** Sentinel meaning "latency has no meaning for this target" — used for
 *  taxonomy `class` targets, where the metric is a proportion of errors, not
 *  a per-keystroke timing. `evaluate.ts` treats a baseline of exactly 0 here
 *  as "skip the latency dimension," never as "instantaneous." */
const LATENCY_NOT_APPLICABLE = 0;

function weightedAverage(pairs: { value: number; weight: number }[]): number {
  let sum = 0;
  let weight = 0;
  for (const p of pairs) {
    sum += p.value * p.weight;
    weight += p.weight;
  }
  return weight > 0 ? sum / weight : 0;
}

function aggregate(rows: Row[]): TargetStat {
  const n = rows.reduce((a, r) => a + r.n, 0);
  const errors = rows.reduce((a, r) => a + r.errors, 0);
  const latencyP50 = weightedAverage(rows.map((r) => ({ value: r.latencyP50, weight: r.n })));
  return {
    errorRate: n > 0 ? errors / n : 0,
    latencyP50,
    n,
    reportable: n >= MIN_FINDING_N,
  };
}

/**
 * Baseline extraction from a persisted report's exact `CompactProfile`.
 *
 * `finger` targets use `relativeLatency` (a ratio against the user's own
 * median — the metric docs/ARCHITECTURE.md §7's own example uses: "2.1x
 * slower than your median") rather than an absolute ms figure, because that
 * is the only latency-shaped number `CompactProfile` carries for fingers
 * (src/lib/ai/profile-input.ts never sends the model raw per-finger ms).
 * `extractFromAnalyses` below uses the same ratio for the same target type,
 * so baseline and outcome stay comparable.
 */
export function extractFromCompactProfile(
  compact: CompactProfile,
  targetType: PrescriptionTargetType,
  targets: string[],
): TargetStat {
  const wanted = new Set(targets.map((t) => t.toLowerCase()));

  if (targetType === "bigram" || targetType === "sfb") {
    return aggregate(
      compact.worstBigrams
        .filter((b) => wanted.has(b.bigram.toLowerCase()))
        .map((b) => ({ n: b.n, errors: Math.round(b.errorRate * b.n), latencyP50: b.latencyP50 })),
    );
  }

  if (targetType === "key") {
    return aggregate(
      compact.worstKeys
        .filter((k) => wanted.has(k.key.toLowerCase()))
        .map((k) => ({ n: k.n, errors: Math.round(k.errorRate * k.n), latencyP50: k.latencyP50 })),
    );
  }

  if (targetType === "finger") {
    // No per-row MIN_FINDING_N pre-filter here: `aggregate` gates on the
    // POOLED n, which is the correct place to apply it — filtering rows
    // individually first would wrongly discard a low-n finger's
    // contribution before it ever gets a chance to be pooled with others.
    return aggregate(
      compact.fingers
        .filter((f) => wanted.has(f.finger.toLowerCase()))
        .map((f) => ({
          n: f.n,
          errors: Math.round(f.errorRate * f.n),
          latencyP50: f.relativeLatency,
        })),
    );
  }

  // class — proportion of ALL observed errors attributable to this taxonomy
  // class. n is the total error count, since that's the population the
  // proportion is drawn from (not total keystrokes, which CompactProfile
  // doesn't carry).
  const totalErrors = compact.errorTaxonomy.reduce((a, e) => a + e.count, 0);
  const classCount = compact.errorTaxonomy
    .filter((e) => wanted.has(e.class.toLowerCase()))
    .reduce((a, e) => a + e.count, 0);
  return aggregate([{ n: totalErrors, errors: classCount, latencyP50: LATENCY_NOT_APPLICABLE }]);
}

/**
 * Outcome extraction from a fresh window of `TestAnalysis`.
 *
 * Pools directly from each test's raw per-test rollups (`bigramStats` /
 * `keyStats` / `fingerStats` / `errorTaxonomy`) rather than going through
 * `buildMetricProfile`'s `worstBigrams`/`worstKeys` lists. Those lists apply
 * the MIN_FINDING_N gate BEFORE ranking and slicing to top-N — deliberately,
 * for display — which means a target below threshold vanishes from them
 * entirely rather than reporting its true (sub-threshold) n. `evaluate()`
 * needs the real n either way: to report accurate "insufficient-n" feedback,
 * and because a prescription that actually worked should make its target
 * LESS bad, not vanish from a top-N-worst view. Pooling raw rows first and
 * gating the pooled total (inside `aggregate`) avoids both problems.
 */
export function extractFromAnalyses(
  analyses: TestAnalysis[],
  targetType: PrescriptionTargetType,
  targets: string[],
): TargetStat {
  const wanted = new Set(targets.map((t) => t.toLowerCase()));

  if (targetType === "bigram" || targetType === "sfb") {
    const rows: Row[] = [];
    for (const a of analyses) {
      for (const b of a.bigramStats) {
        if (wanted.has(b.bigram.toLowerCase())) {
          rows.push({ n: b.n, errors: b.errors, latencyP50: b.latencyP50 });
        }
      }
    }
    return aggregate(rows);
  }

  if (targetType === "key") {
    const rows: Row[] = [];
    for (const a of analyses) {
      for (const k of a.keyStats) {
        if (wanted.has(k.key.toLowerCase())) {
          rows.push({ n: k.n, errors: k.errors, latencyP50: k.latencyP50 });
        }
      }
    }
    return aggregate(rows);
  }

  if (targetType === "finger") {
    const rows: Row[] = [];
    for (const a of analyses) {
      for (const f of a.fingerStats) {
        if (wanted.has(f.finger.toLowerCase())) {
          rows.push({ n: f.n, errors: Math.round(f.errorRate * f.n), latencyP50: f.relativeLatency });
        }
      }
    }
    return aggregate(rows);
  }

  let totalErrors = 0;
  let classCount = 0;
  for (const a of analyses) {
    for (const [cls, count] of Object.entries(a.errorTaxonomy)) {
      totalErrors += count;
      if (wanted.has(cls.toLowerCase())) classCount += count;
    }
  }
  return aggregate([{ n: totalErrors, errors: classCount, latencyP50: LATENCY_NOT_APPLICABLE }]);
}
