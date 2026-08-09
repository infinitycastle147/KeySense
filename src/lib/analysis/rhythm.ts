/**
 * Inter-key-interval (IKI) rhythm: overall spread plus burst/stall counts.
 * "Burst-then-stall" patterns are a distinct signal from raw speed —
 * someone who is fast-then-freezes types differently from someone who is
 * evenly slow. Per docs/ARCHITECTURE.md §5.4.
 */

import type { KeyEvent } from "@/lib/types";
import { OUTLIER_MS, coefficientOfVariation, mad, median } from "./stats";

export type RhythmStats = {
  n: number;
  medianIki: number;
  madIki: number;
  /** MAD / median — robust spread, unitless. Higher = more erratic rhythm. */
  coefficientOfVariation: number;
  /** Intervals unusually fast relative to this run's own rhythm. */
  burstCount: number;
  /** Intervals unusually slow but still <= OUTLIER_MS (a hesitation, not a
   *  full "not typing" gap, which was already discarded). */
  stallCount: number;
};

/**
 * A burst/stall is defined via the modified z-score (Iglewicz & Hoaglin):
 * z = 0.6745 * (x - median) / MAD, flagged at |z| >= 3.5 — a standard robust
 * outlier threshold that doesn't require a normal distribution assumption
 * (typing rhythm isn't remotely normal). Chosen as a documented judgement
 * call; there is no canonical threshold in the architecture docs for this.
 *
 * When MAD is 0 (every surviving interval identical — degenerate, but
 * possible on tiny/synthetic fixtures), burst/stall counts are 0 rather than
 * everything or nothing: a z-score is undefined when MAD is 0, not infinite
 * in a meaningful direction.
 */
const MODIFIED_Z_THRESHOLD = 3.5;
const MODIFIED_Z_CONSISTENCY = 0.6745;

export function computeRhythm(events: KeyEvent[]): RhythmStats {
  const intervals: number[] = [];
  for (let i = 1; i < events.length; i++) {
    if (events[i].kind !== "char") continue;
    const interval = events[i].t - events[i - 1].t;
    if (interval >= 0 && interval <= OUTLIER_MS) intervals.push(interval);
  }

  const medianIki = median(intervals);
  const madIki = mad(intervals);

  let burstCount = 0;
  let stallCount = 0;

  if (madIki > 0) {
    for (const interval of intervals) {
      const z = (MODIFIED_Z_CONSISTENCY * (interval - medianIki)) / madIki;
      if (z <= -MODIFIED_Z_THRESHOLD) burstCount += 1;
      else if (z >= MODIFIED_Z_THRESHOLD) stallCount += 1;
    }
  }

  return {
    n: intervals.length,
    medianIki,
    madIki,
    coefficientOfVariation: coefficientOfVariation(intervals),
    burstCount,
    stallCount,
  };
}
