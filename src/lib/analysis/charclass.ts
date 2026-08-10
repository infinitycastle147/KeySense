/**
 * Shift, capitals, punctuation and numbers as their own class.
 *
 * docs/ARCHITECTURE.md §5.4 lists these as a metric — "usually
 * disproportionately bad and completely invisible in aggregate stats" — and
 * they had never been measured. `KeyEvent.mods` has been captured on every
 * keystroke since Phase 1 and was read by nothing.
 *
 * They deserve separation because a capital letter is not one keystroke. It is
 * a chord: a shift held with the other hand while the letter is struck, and it
 * fails in ways a lowercase letter cannot — released too early, pressed too
 * late, or reached for with the wrong hand. Pooled into an overall accuracy
 * figure, a typist who is fine on prose and hopeless on `Shift`-heavy code
 * looks identical to one who is evenly mediocre.
 *
 * Digits and punctuation are separated for the same reason at a different
 * scale: both live off the home rows, both are rare in ordinary prose, and
 * both are where the pinkies do their worst work.
 *
 * Fully computable from existing archives — this needs no new capture.
 *
 * Pure. See charclass.test.ts.
 */

import type { KeyEvent, Measured } from "@/lib/types";
import { MIN_FINDING_N, OUTLIER_MS, median, wilsonInterval } from "./stats";
import type { Interval } from "@/lib/types";

export type CharClass =
  | "lowercase"
  | "capital"
  | "digit"
  | "punctuation"
  | "space";

export type CharClassStat = {
  charClass: CharClass;
  n: number;
  errors: number;
  errorRate: number;
  errorRateCI: Interval;
  latencyP50: number;
  /** Ratio of this class's median latency to the lowercase baseline. The
   *  interesting number: capitals at 1.8x lowercase is a finding, capitals at
   *  1.05x is not, and the absolute ms figure cannot tell you which. */
  relativeToLowercase: number;
};

export type CharClassStats = {
  classes: CharClassStat[];
  /** Share of shifted keystrokes that were wrong, against the same for
   *  unshifted. Isolates the chord itself from the letters it is used on. */
  shiftedErrorRate: Measured<number>;
  unshiftedErrorRate: Measured<number>;
};

/**
 * Classifies an expected character.
 *
 * Uses the character, not the layout: a digit is a digit on Dvorak too. The
 * one judgement call is that a capital is detected from the character being an
 * uppercase letter rather than from `mods` containing "shift" — a typist who
 * produced `A` without shift (caps lock) still made the capital, and one who
 * held shift and produced `a` did not.
 */
export function classifyChar(char: string): CharClass | undefined {
  if (char === "") return undefined;
  if (char === " ") return "space";
  if (char >= "0" && char <= "9") return "digit";
  if (char.toLowerCase() !== char.toUpperCase()) {
    return char === char.toUpperCase() ? "capital" : "lowercase";
  }
  return "punctuation";
}

const CLASSES: CharClass[] = ["lowercase", "capital", "digit", "punctuation", "space"];

export function computeCharClassStats(events: KeyEvent[]): CharClassStats {
  type Acc = { n: number; errors: number; latencies: number[] };
  const groups = new Map<CharClass, Acc>(
    CLASSES.map((c) => [c, { n: 0, errors: 0, latencies: [] }]),
  );

  let shiftedN = 0;
  let shiftedErrors = 0;
  let unshiftedN = 0;
  let unshiftedErrors = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.kind !== "char") continue;

    const charClass = classifyChar(event.expected);
    if (!charClass) continue;

    const acc = groups.get(charClass)!;
    acc.n += 1;
    if (!event.ok) acc.errors += 1;

    if (i > 0) {
      const interval = event.t - events[i - 1].t;
      if (interval >= 0 && interval <= OUTLIER_MS) acc.latencies.push(interval);
    }

    // The chord itself, independent of which letter it produced.
    if (event.mods.includes("shift")) {
      shiftedN += 1;
      if (!event.ok) shiftedErrors += 1;
    } else {
      unshiftedN += 1;
      if (!event.ok) unshiftedErrors += 1;
    }
  }

  const lowercaseLatency = median(groups.get("lowercase")!.latencies);

  return {
    classes: CLASSES.map((charClass) => {
      const acc = groups.get(charClass)!;
      const latencyP50 = median(acc.latencies);
      return {
        charClass,
        n: acc.n,
        errors: acc.errors,
        errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
        errorRateCI: wilsonInterval(acc.errors, acc.n),
        latencyP50,
        // 0, not 1, when there is no baseline: 1 would claim "exactly as fast
        // as lowercase", which is a measurement, not an absence of one.
        relativeToLowercase:
          lowercaseLatency > 0 && latencyP50 > 0 ? latencyP50 / lowercaseLatency : 0,
      };
    }),
    shiftedErrorRate: {
      value: shiftedN > 0 ? shiftedErrors / shiftedN : 0,
      n: shiftedN,
      reportable: shiftedN >= MIN_FINDING_N,
    },
    unshiftedErrorRate: {
      value: unshiftedN > 0 ? unshiftedErrors / unshiftedN : 0,
      n: unshiftedN,
      reportable: unshiftedN >= MIN_FINDING_N,
    },
  };
}
