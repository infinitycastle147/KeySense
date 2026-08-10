/**
 * Separating "this finger is slow" from "the keys before it are far away".
 *
 * ## The confound
 *
 * Every latency in this codebase is an inter-key interval, `t[i] - t[i-1]`.
 * That number is a property of the **transition** from key i-1 to key i, but
 * fingers.ts and keys.ts charge it entirely to key i. So the flagship claim —
 * "right pinky is 2.1x slower than your median" — may in truth be "the keys
 * that happen to precede pinky keys are far away from the pinky."
 *
 * The two readings call for opposite prescriptions. One says drill the pinky;
 * the other says the pinky is fine and the approach to it is what costs time.
 * A marginal average cannot tell them apart, because in ordinary English text
 * the distribution of predecessors is wildly uneven across fingers.
 *
 * ## The model
 *
 * Fit an additive decomposition over transitions:
 *
 *     interval ≈ mu + from[fromFinger] + to[toFinger]
 *
 * `to[g]` is then the part attributable to *arriving* at finger g once the
 * typical cost of departing from whatever preceded it has been accounted for.
 * That residual is the honest version of the claim.
 *
 * Fitted by backfitting on **medians**, not means, per the robust-statistics
 * rule — the residual of a skewed distribution is still skewed, and a single
 * hesitation would otherwise redefine a finger's effect. Medians make the fit
 * iterative (there is no closed form), but the parameter count is tiny: nine
 * fingers each side, so it converges in a handful of passes.
 *
 * Effects are re-centred each pass. Without it the model is unidentifiable —
 * adding a constant to every `from` and subtracting it from every `to` gives an
 * identical fit — and the numbers would wander between runs on the same data.
 *
 * Pure. See residual.test.ts.
 */

import type { KeyEvent, Finger } from "@/lib/types";
import type { LayoutIndex } from "./layout";
import { OUTLIER_MS, median } from "./stats";

export type Transition = {
  from: Finger;
  to: Finger;
  interval: number;
};

export type ResidualModel = {
  /** Overall median transition time, in ms. */
  mu: number;
  /** ms attributable to departing from each finger. */
  from: Map<Finger, number>;
  /** ms attributable to arriving at each finger, net of the predecessor. */
  to: Map<Finger, number>;
  /** Transitions the fit was built from. */
  n: number;
};

const FIT_PASSES = 12;

/**
 * Extracts finger-to-finger transitions from an event stream.
 *
 * Only consecutive "char" events count, and only when both characters resolve
 * to a finger through the layout. Intervals above OUTLIER_MS are dropped
 * before the fit, exactly as everywhere else — a thinking pause is not a
 * transition cost.
 */
export function extractTransitions(events: KeyEvent[], layout: LayoutIndex): Transition[] {
  const transitions: Transition[] = [];

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev.kind !== "char" || curr.kind !== "char") continue;

    const fromKey = layout.charToKey(prev.expected);
    const toKey = layout.charToKey(curr.expected);
    if (!fromKey || !toKey) continue;

    const from = layout.keyToFinger(fromKey);
    const to = layout.keyToFinger(toKey);
    if (!from || !to) continue;

    const interval = curr.t - prev.t;
    if (interval < 0 || interval > OUTLIER_MS) continue;

    transitions.push({ from, to, interval });
  }

  return transitions;
}

function centre(effects: Map<Finger, number>): void {
  if (effects.size === 0) return;
  const offset = median([...effects.values()]);
  for (const [finger, value] of effects) effects.set(finger, value - offset);
}

/** Fits the additive model. Empty input yields an all-zero model rather than
 *  throwing; callers gate on `n`. */
export function fitResidualModel(transitions: Transition[]): ResidualModel {
  const from = new Map<Finger, number>();
  const to = new Map<Finger, number>();

  if (transitions.length === 0) return { mu: 0, from, to, n: 0 };

  const mu = median(transitions.map((t) => t.interval));

  const byFrom = new Map<Finger, Transition[]>();
  const byTo = new Map<Finger, Transition[]>();
  for (const t of transitions) {
    (byFrom.get(t.from) ?? byFrom.set(t.from, []).get(t.from)!).push(t);
    (byTo.get(t.to) ?? byTo.set(t.to, []).get(t.to)!).push(t);
    from.set(t.from, 0);
    to.set(t.to, 0);
  }

  for (let pass = 0; pass < FIT_PASSES; pass++) {
    for (const [finger, rows] of byFrom) {
      from.set(finger, median(rows.map((t) => t.interval - mu - (to.get(t.to) ?? 0))));
    }
    centre(from);

    for (const [finger, rows] of byTo) {
      to.set(finger, median(rows.map((t) => t.interval - mu - (from.get(t.from) ?? 0))));
    }
    centre(to);
  }

  return { mu, from, to, n: transitions.length };
}

export type FingerResidual = {
  finger: Finger;
  /** Median latency adjusted for which fingers preceded this one, in ms. */
  adjustedLatency: number;
  /** adjustedLatency / mu. >1 is genuinely slower than this typist's typical
   *  transition, with the approach cost removed. This is the number a finding
   *  should cite in place of the raw `relativeLatency`. */
  relativeAdjusted: number;
  /** The raw marginal for comparison — the gap between the two is the size of
   *  the confound, and is worth showing rather than quietly correcting away. */
  rawRelative: number;
  n: number;
};

/**
 * Per-finger adjusted latency, alongside the unadjusted figure it corrects.
 *
 * `rawRelative` is computed here from the same transitions as the adjusted
 * value — not read from FingerStat — so the two are guaranteed to describe the
 * same sample. Comparing an adjusted number against a marginal computed over a
 * different set of events would make the correction look larger or smaller
 * than it is.
 */
export function computeFingerResiduals(
  transitions: Transition[],
  model: ResidualModel,
): FingerResidual[] {
  if (model.n === 0 || model.mu === 0) return [];

  const byTo = new Map<Finger, number[]>();
  for (const t of transitions) {
    const list = byTo.get(t.to) ?? [];
    list.push(t.interval);
    byTo.set(t.to, list);
  }

  const residuals: FingerResidual[] = [];
  for (const [finger, intervals] of byTo) {
    const adjustedLatency = model.mu + (model.to.get(finger) ?? 0);
    residuals.push({
      finger,
      adjustedLatency,
      relativeAdjusted: adjustedLatency / model.mu,
      rawRelative: median(intervals) / model.mu,
      n: intervals.length,
    });
  }

  return residuals.sort((a, b) => b.relativeAdjusted - a.relativeAdjusted);
}
