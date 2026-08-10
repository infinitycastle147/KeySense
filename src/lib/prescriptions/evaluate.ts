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
 * ## The verdict is difference-in-differences, not pre/post
 *
 * A raw pre/post comparison on this data is not evidence. Targets are selected
 * as the extremes of a noisy ranking, so re-measuring them later shows
 * improvement even under a placebo — see ./control.ts for the full argument.
 *
 * So the number that drives the verdict is the *lift*:
 *
 *     lift = improvement(treated) - improvement(control)
 *
 * The untreated hold-out absorbs everything that would have happened anyway —
 * regression to the mean, general skill drift, a better keyboard, a quieter
 * week — and the remainder is what the prescription can claim.
 *
 * This deliberately makes verdicts harder to earn than they were under a
 * pre/post rule: a target that improved 60% while its control improved 45% is
 * now "improved" (15% attributable), not "resolved". That is the correction
 * working, not a regression in the product.
 *
 * When no control is available — a `class` target, an exhausted ranking, or a
 * prescription created before controls existed — the verdict falls back to
 * pre/post and `controlled: false` says so. Callers must surface that
 * distinction rather than presenting both kinds of verdict as equivalent.
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

import type { Prescription, PrescriptionVerdict, TargetMeasurement } from "@/lib/types";
import type { TestAnalysis } from "@/lib/analysis/profile";
import { extractFromAnalyses } from "./baseline";
import {
  RESOLVED_RELATIVE_IMPROVEMENT,
  IMPROVED_RELATIVE_IMPROVEMENT,
  REGRESSED_RELATIVE_WORSENING,
} from "./constants";

export type PrescriptionOutcome = TargetMeasurement;

export type EvaluateResult =
  | {
      ok: true;
      outcome: PrescriptionOutcome;
      /** Measured over the identical post-treatment window as `outcome`.
       *  Null when the prescription carries no control, or when the control's
       *  own post-treatment n fell below MIN_FINDING_N. */
      controlOutcome: PrescriptionOutcome | null;
      /** improvement(treated) - improvement(control). Null exactly when
       *  `controlOutcome` is null. */
      lift: number | null;
      /** False when `verdict` came from a raw pre/post comparison because no
       *  control was usable. An uncontrolled verdict is weaker evidence and
       *  must not be displayed as though it were not. */
      controlled: boolean;
      verdict: PrescriptionVerdict;
    }
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
  return verdictFromScore(improvementScore(baseline, outcome));
}

/** The single scalar a verdict is read off. Exported so the controlled path
 *  (lift) and the uncontrolled fallback (raw pre/post) provably use the same
 *  thresholds — the only difference between them is what goes in. */
export function verdictFromScore(score: number): PrescriptionVerdict {
  if (score >= RESOLVED_RELATIVE_IMPROVEMENT) return "resolved";
  if (score >= IMPROVED_RELATIVE_IMPROVEMENT) return "improved";
  if (score <= -REGRESSED_RELATIVE_WORSENING) return "regressed";
  return "no-change";
}

/** Relative error-rate improvement of one target set, pre to post. */
export function improvementScore(
  baseline: { errorRate: number },
  outcome: { errorRate: number },
): number {
  return relativeImprovement(baseline.errorRate, outcome.errorRate);
}

/**
 * The difference-in-differences estimate: how much of the treated set's
 * improvement is *not* explained by the untreated hold-out moving as well.
 *
 * Both sides are relative improvements, so the subtraction is between two
 * unitless quantities drawn from the same distribution's tail — which is
 * exactly what makes the regression-to-the-mean component cancel.
 */
export function computeLift(
  treated: { baseline: { errorRate: number }; outcome: { errorRate: number } },
  control: { baseline: { errorRate: number }; outcome: { errorRate: number } },
): number {
  return improvementScore(treated.baseline, treated.outcome) -
    improvementScore(control.baseline, control.outcome);
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

  const treated = {
    errorRate: outcome.errorRate,
    latencyP50: outcome.latencyP50,
    n: outcome.n,
  };

  // The control is measured over `postOnly` — the identical window, through
  // the identical extractor. Any divergence in how the two sides are measured
  // would reappear in `lift` as if it were a treatment effect.
  const control = prescription.control;
  const controlOutcome = control
    ? extractFromAnalyses(postOnly, prescription.targetType, control.targets)
    : null;

  // An unreportable control is discarded rather than used with a caveat: lift
  // is a difference, so a noisy control doesn't widen the estimate, it moves
  // it — a control that drifted on 4 observations would fabricate or erase a
  // treatment effect outright.
  if (control && controlOutcome?.reportable) {
    const measuredControl = {
      errorRate: controlOutcome.errorRate,
      latencyP50: controlOutcome.latencyP50,
      n: controlOutcome.n,
    };
    const lift = computeLift(
      { baseline: prescription.baseline, outcome: treated },
      { baseline: control.baseline, outcome: measuredControl },
    );

    return {
      ok: true,
      outcome: treated,
      controlOutcome: measuredControl,
      lift,
      controlled: true,
      verdict: verdictFromScore(lift),
    };
  }

  return {
    ok: true,
    outcome: treated,
    controlOutcome: null,
    lift: null,
    controlled: false,
    verdict: computeVerdict(prescription.baseline, treated),
  };
}
