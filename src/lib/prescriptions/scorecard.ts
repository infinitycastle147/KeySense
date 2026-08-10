/**
 * The diagnosis engine's report card on itself.
 *
 * docs/ARCHITECTURE.md §7 claims the closed loop "gives honest feedback on
 * whether the analysis logic is any good — if prescriptions routinely produce
 * no change, the diagnosis is wrong." Nothing read the verdicts back, so that
 * feedback existed per-prescription and never in aggregate. This is that
 * aggregate.
 *
 * Two rules keep it honest:
 *
 *   1. **Controlled and uncontrolled verdicts are counted separately.** A
 *      pre/post verdict and a difference-in-differences verdict are not the
 *      same claim (see ./evaluate.ts), and pooling them would let the weaker
 *      evidence inflate the stronger.
 *   2. **The headline is median lift, not the resolved count.** A run of
 *      "resolved" verdicts is exactly what regression to the mean produces on
 *      its own; median lift is the quantity that is zero when the diagnosis is
 *      doing nothing.
 *
 * Pure — no I/O. Feed it whatever window of prescriptions the caller wants.
 */

import type { Prescription, PrescriptionVerdict } from "@/lib/types";
import { improvementScore } from "./evaluate";
import { median } from "@/lib/analysis/stats";

export type DiagnosisScorecard = {
  /** Prescriptions considered, including those still active. */
  total: number;
  /** Those with a recorded outcome — the only ones a verdict exists for. */
  evaluated: number;
  byVerdict: Record<PrescriptionVerdict, number>;
  /** Evaluated prescriptions carrying a usable hold-out control. */
  controlled: number;
  /** Evaluated prescriptions whose verdict is bare pre/post. */
  uncontrolled: number;
  /**
   * Median difference-in-differences across controlled prescriptions.
   *
   * Median rather than mean, per the robust-statistics rule: one prescription
   * whose control happened to collapse would otherwise drag the whole
   * scorecard. Null when nothing controlled has been evaluated yet — the
   * honest answer at that point is "not enough evidence", not 0.
   */
  medianLift: number | null;
  /**
   * Median *uncorrected* pre/post improvement across the same controlled
   * prescriptions. Shown beside `medianLift` because the gap between the two
   * is the size of the artifact the control removed — the clearest single
   * readout of how much a naive pre/post loop would have been overclaiming.
   */
  medianRawImprovement: number | null;
};

function emptyByVerdict(): Record<PrescriptionVerdict, number> {
  return { resolved: 0, improved: 0, "no-change": 0, regressed: 0 };
}

export function buildScorecard(prescriptions: Prescription[]): DiagnosisScorecard {
  const byVerdict = emptyByVerdict();
  const lifts: number[] = [];
  const rawImprovements: number[] = [];
  let evaluated = 0;
  let controlled = 0;

  for (const rx of prescriptions) {
    if (!rx.outcome || !rx.verdict) continue;
    evaluated += 1;
    byVerdict[rx.verdict] += 1;

    const control = rx.control;
    if (!control?.outcome) continue;

    controlled += 1;
    const treatedScore = improvementScore(rx.baseline, rx.outcome);
    rawImprovements.push(treatedScore);
    lifts.push(treatedScore - improvementScore(control.baseline, control.outcome));
  }

  return {
    total: prescriptions.length,
    evaluated,
    byVerdict,
    controlled,
    uncontrolled: evaluated - controlled,
    medianLift: lifts.length > 0 ? median(lifts) : null,
    medianRawImprovement: rawImprovements.length > 0 ? median(rawImprovements) : null,
  };
}
