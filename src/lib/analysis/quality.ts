/**
 * Per-test data quality — how much of this test was actually typing.
 *
 * Every latency metric silently discards inter-key intervals above
 * OUTLIER_MS as "not typing" (stats.ts). That rule is correct and it is also
 * a measurement in its own right, which was being thrown away: a session where
 * 30% of intervals were discarded is a distracted session, and a session where
 * 1% were is a clean one. Until now the two were indistinguishable downstream,
 * and both contributed equally to trends and to WPM.
 *
 * Nothing here changes what the other metrics compute. It records what they
 * had to ignore, so a caller can weight, flag, or exclude a test instead of
 * treating a half-attentive session as evidence.
 *
 * Pure. See quality.test.ts.
 */

import type { KeyEvent } from "@/lib/types";
import { OUTLIER_MS, median } from "./stats";

export type QualityStats = {
  /** Inter-key intervals considered (excluding the first keystroke). */
  intervalCount: number;
  /** How many were discarded as "not typing". */
  discardedCount: number;
  /** discardedCount / intervalCount. The headline: high means distracted. */
  discardRate: number;
  /** Gaps above OUTLIER_MS, treated as pauses. */
  pauseCount: number;
  /** Total time inside those pauses, ms. */
  pauseMs: number;
  longestPauseMs: number;
  /** Wall-clock duration minus time spent paused. The denominator a WPM
   *  computed for *typing speed* rather than *session throughput* would want. */
  activeMs: number;
  /** Median of the intervals that survived — the tempo of the parts that were
   *  genuinely typing, unaffected by how often the typist stopped. */
  activeMedianIki: number;
};

export function computeQuality(events: KeyEvent[], durationMs: number): QualityStats {
  const kept: number[] = [];
  let discardedCount = 0;
  let pauseMs = 0;
  let longestPauseMs = 0;

  for (let i = 1; i < events.length; i++) {
    const interval = events[i].t - events[i - 1].t;
    if (interval < 0) continue; // clock or ordering glitch — not a pause
    if (interval > OUTLIER_MS) {
      discardedCount += 1;
      pauseMs += interval;
      longestPauseMs = Math.max(longestPauseMs, interval);
    } else {
      kept.push(interval);
    }
  }

  const intervalCount = kept.length + discardedCount;

  return {
    intervalCount,
    discardedCount,
    discardRate: intervalCount > 0 ? discardedCount / intervalCount : 0,
    pauseCount: discardedCount,
    pauseMs,
    longestPauseMs,
    // Clamped at zero: pauses are derived from event timestamps and duration
    // from the test clock, so a pathological archive could make these
    // disagree. A negative "active time" is never a useful thing to report.
    activeMs: Math.max(0, durationMs - pauseMs),
    activeMedianIki: median(kept),
  };
}

/**
 * Tests whose discard rate exceeds this were substantially not-typing, and
 * should not carry the same weight as a clean run in a trend.
 *
 * Deliberately a flag rather than an automatic exclusion: dropping a user's
 * data without telling them is worse than including it with a caveat, and the
 * right response differs by caller (a trend may want to exclude, a history
 * list must still show the test happened).
 */
export const DISTRACTED_DISCARD_RATE = 0.15;

export function isDistracted(quality: QualityStats): boolean {
  return quality.intervalCount > 0 && quality.discardRate > DISTRACTED_DISCARD_RATE;
}
