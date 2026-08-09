/**
 * Prescription lifecycle: evaluation.
 *
 * Runs once `drillsDone >= drillsTarget` (see PHASE-5.md §2). Never writes
 * to `Prescription.baseline` — see create.ts and CLAUDE.md invariant 6.
 *
 * "Compare like with like" (PHASE-5.md) means: the outcome is extracted
 * through the exact same aggregation + MIN_FINDING_N gate as the baseline
 * (both funnel through `aggregate` in ./baseline.ts), and only tests
 * recorded strictly after `prescription.createdAt` are ever considered.
 *
 * Judgement call, documented here because PHASE-5.md doesn't specify it:
 * the outcome is measured against the user's OVERALL subsequent typing, not
 * just the drill sessions themselves. Checking accuracy only inside
 * "th"-heavy drill sessions after specifically drilling "th" would be
 * circular — of course it improves under repetition. The honest test of
 * whether the weakness actually resolved is whether it shows up better in
 * ordinary typing afterwards, which is also what makes a "no-change"
 * verdict meaningful feedback on the diagnosis logic itself (docs/ARCHITECTURE.md §7).
 */

import type { Prescription, PrescriptionVerdict } from "@/lib/types";
import type { TestAnalysis } from "@/lib/analysis/profile";
import { extractFromAnalyses } from "./baseline";
import {
  RESOLVED_RELATIVE_IMPROVEMENT,
  IMPROVED_RELATIVE_IMPROVEMENT,
  REGRESSED_RELATIVE_WORSENING,
} from "./constants";

export type PrescriptionOutcome = { errorRate: number; latencyP50: number; n: number };

export type EvaluateResult =
  | { ok: true; outcome: PrescriptionOutcome; verdict: PrescriptionVerdict }
  | { ok: false; reason: "insufficient-n"; n: number };

/**
 * Positive = improvement (smaller/faster than baseline), negative = worse.
 * `baseline === 0` is treated as "already perfect": a relative percentage
 * against zero is undefined, and any regression away from a perfect
 * baseline is scored as a full regression (-1) rather than +/-Infinity.
 */
function relativeImprovement(baseline: number, outcome: number): number {
  if (baseline === 0) return outcome === 0 ? 0 : -1;
  return (baseline - outcome) / baseline;
}

/**
 * Verdict is driven by errorRate alone, not an average of errorRate and
 * latency. Judgement call, documented here because PHASE-5.md doesn't spell
 * out how the two would combine: docs/ARCHITECTURE.md §7's own worked
 * example — 0.084 -> 0.031 errorRate, labelled "Resolved" — is narrated
 * purely in terms of errorRate, and a weighted-average formula that folds in
 * latencyP50 does NOT reproduce that example (0.084->0.031 is a 63% error
 * improvement but only ~15% latency improvement in the same example,
 * averaging to ~39%, which would read as "improved" under a 50% resolved
 * threshold). errorRate is also the more universal metric here: it applies
 * to every targetType, whereas latencyP50 is a genuine "not applicable"
 * sentinel (0) for `class` targets. `outcome.latencyP50` is still recorded
 * and shown as supporting evidence — it just isn't part of the verdict math.
 */
export function computeVerdict(
  baseline: { errorRate: number; latencyP50: number },
  outcome: { errorRate: number; latencyP50: number },
): PrescriptionVerdict {
  const score = relativeImprovement(baseline.errorRate, outcome.errorRate);

  if (score >= RESOLVED_RELATIVE_IMPROVEMENT) return "resolved";
  if (score >= IMPROVED_RELATIVE_IMPROVEMENT) return "improved";
  if (score <= -REGRESSED_RELATIVE_WORSENING) return "regressed";
  return "no-change";
}

/**
 * Evaluates one prescription against a window of `TestAnalysis`. Filters to
 * `endedAt > prescription.createdAt` itself — this function does not trust
 * the caller to have pre-filtered, because this is the one comparison in the
 * whole system that must never be contaminated by pre-treatment data.
 *
 * `prescription` is read-only here: this function returns a new
 * outcome/verdict pair, never mutates the prescription it was given. The
 * caller (an API route / store layer) decides how to persist that alongside
 * the untouched baseline.
 */
export function evaluate(prescription: Prescription, analyses: TestAnalysis[]): EvaluateResult {
  const postOnly = analyses.filter((a) => a.endedAt > prescription.createdAt);
  const outcome = extractFromAnalyses(postOnly, prescription.targetType, prescription.targets);

  if (!outcome.reportable) {
    return { ok: false, reason: "insufficient-n", n: outcome.n };
  }

  const verdict = computeVerdict(prescription.baseline, outcome);
  return {
    ok: true,
    outcome: { errorRate: outcome.errorRate, latencyP50: outcome.latencyP50, n: outcome.n },
    verdict,
  };
}
