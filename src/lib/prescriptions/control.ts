/**
 * Hold-out control selection — the correction for regression to the mean.
 *
 * ## Why this exists
 *
 * A prescription's targets are the *worst* rows of a ranked list, and that
 * list is built from noisy estimates: a bigram lands at the top partly because
 * it is genuinely bad and partly because its estimate happened to be unlucky
 * in this window. Re-measure it later and the unlucky part washes out. The
 * target improves **whether or not the drills did anything**.
 *
 * That means the pre/post comparison in evaluate.ts, taken alone, cannot tell
 * a working diagnosis from a statistical artifact — which defeats the purpose
 * docs/ARCHITECTURE.md §7 assigns to the closed loop ("it gives honest
 * feedback on whether the analysis logic is any good").
 *
 * The fix is a control group of one: at prescription time, take the targets
 * ranked *immediately below* the treated set — same type, same list, same
 * selection pressure, therefore the same regression-to-the-mean pull — and
 * deliberately do not drill them. Whatever they do between baseline and
 * outcome is the counterfactual: what the treated set would have done anyway.
 *
 * ## Rules
 *
 * - The control is **never drilled and never shown.** Nothing in the drill
 *   generator or the UI reads `Prescription.control.targets`. If a control
 *   target ever became visible to the user it would stop being a control.
 * - Control targets are drawn from the same `CompactProfile` the finding was
 *   written from, so treated and control baselines are measured by the same
 *   instrument at the same moment.
 * - A control is optional. When one cannot be formed, the prescription is
 *   still valid — its verdict is simply uncontrolled and labelled as such.
 */

import type { CompactProfile } from "@/lib/ai/profile-input";
import type { PrescriptionTargetType } from "@/lib/types";

/** Selected when the caller doesn't specify: match the treated set size, so
 *  treated and control carry comparable pooled n. */
function defaultSize(treatedCount: number): number {
  return Math.max(1, treatedCount);
}

function normalise(targets: string[]): Set<string> {
  return new Set(targets.map((t) => t.toLowerCase()));
}

/**
 * Picks the hold-out targets for a prescription.
 *
 * Returns `[]` when no valid control exists. Three cases produce that:
 *
 *   1. `targetType === "class"`. The four taxonomy classes partition the
 *      error population, so their rates are mechanically coupled — driving
 *      substitutions down pushes every other class's *share* up. A "control
 *      class" would move for reasons that have nothing to do with the
 *      counterfactual, which is worse than no control at all.
 *   2. The ranked list is exhausted once the treated targets are removed.
 *   3. The profile carries no rows of that type.
 *
 * Ordering note: `worstBigrams` and `worstKeys` arrive from
 * buildMetricProfile already ranked worst-first and already gated at
 * MIN_FINDING_N, so "the next k" is a straight walk down the list. `fingers`
 * is *not* pre-ranked (it is emitted per finger, unordered), so it is sorted
 * here by the same badness ordering the profile ranker uses.
 */
export function selectControlTargets(
  compact: CompactProfile,
  targetType: PrescriptionTargetType,
  treatedTargets: string[],
  size?: number,
): string[] {
  if (targetType === "class") return [];

  const treated = normalise(treatedTargets);
  const take = size ?? defaultSize(treatedTargets.length);

  if (targetType === "bigram" || targetType === "sfb") {
    // An SFB prescription gets an SFB control: the construct being tested is
    // "same-finger transitions", and a non-SFB control would differ from the
    // treated set in kind, not just in rank.
    const pool =
      targetType === "sfb"
        ? compact.worstBigrams.filter((b) => b.sameFinger)
        : compact.worstBigrams;

    return pool
      .filter((b) => !treated.has(b.bigram.toLowerCase()))
      .slice(0, take)
      .map((b) => b.bigram);
  }

  if (targetType === "key") {
    return compact.worstKeys
      .filter((k) => !treated.has(k.key.toLowerCase()))
      .slice(0, take)
      .map((k) => k.key);
  }

  return [...compact.fingers]
    .filter((f) => !treated.has(f.finger.toLowerCase()))
    .sort((a, b) => b.errorRate - a.errorRate || b.relativeLatency - a.relativeLatency)
    .slice(0, take)
    .map((f) => f.finger);
}
