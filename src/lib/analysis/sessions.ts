/**
 * Session, time-of-day, and device as analysis dimensions.
 *
 * `startedAt` and `deviceId` have been recorded on every test since Phase 2 and
 * were read by no analysis code. Three consequences, each of which quietly
 * undermines a claim the product makes:
 *
 *   1. **Device pooling breaks the baseline.** docs/ARCHITECTURE.md §5.3 rests
 *      on comparing a typist against themselves. A laptop chiclet keyboard and
 *      an external mechanical produce materially different latencies, so
 *      pooling them compares a typist against a mixture of two typists.
 *   2. **Fatigue was only measured inside a test.** fatigue.ts buckets by
 *      position within a single 30-second run. The fatigue people actually
 *      notice accumulates across a sitting, and nothing measured it.
 *   3. **Warm-up was invisible.** The first test of a session is reliably
 *      slower than the fourth, and pooling them understates real speed while
 *      adding variance to every trend.
 *
 * Pure. See sessions.test.ts.
 */

import { MIN_FINDING_N, median } from "./stats";
import type { Measured } from "@/lib/types";

/** Gap between tests that ends a sitting. Chosen as a documented judgement
 *  call: long enough that a pause to read something doesn't split a session,
 *  short enough that a morning and an evening run never merge. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export type TestContext = {
  testId: string;
  startedAt: string;
  deviceId: string;
  wpm: number;
  accuracy: number;
};

export type PositionedTest = TestContext & {
  /** 0-based sitting number across the input, oldest first. */
  sessionIndex: number;
  /** 0-based position within its sitting. 0 is the warm-up test. */
  positionInSession: number;
  /** Local hour, 0-23, of the machine that produced the timestamp. */
  hourOfDay: number;
};

/**
 * Assigns each test its sitting and position.
 *
 * Sorted oldest-first internally, so callers may pass any order — history
 * queries return newest-first and silently reversing the meaning of
 * "position 0" would be a nasty trap.
 */
export function assignSessions(tests: TestContext[]): PositionedTest[] {
  const sorted = [...tests].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  let sessionIndex = 0;
  let positionInSession = 0;
  let previousTime: number | null = null;

  return sorted.map((test) => {
    const time = new Date(test.startedAt).getTime();

    if (previousTime !== null) {
      if (Number.isFinite(time) && time - previousTime > SESSION_GAP_MS) {
        sessionIndex += 1;
        positionInSession = 0;
      } else {
        positionInSession += 1;
      }
    }
    previousTime = Number.isFinite(time) ? time : previousTime;

    return {
      ...test,
      sessionIndex,
      positionInSession,
      hourOfDay: Number.isFinite(time) ? new Date(time).getHours() : 0,
    };
  });
}

export type WarmupCurve = {
  /** Median WPM at each position in a sitting, position 0 first. */
  wpmByPosition: number[];
  /** How many tests contributed to each position. */
  nByPosition: number[];
  /** Median WPM at position 0 against the median across later positions.
   *  Below 1 means the first test of a sitting is reliably slower — a warm-up
   *  effect, not a skill measurement. */
  warmupRatio: Measured<number>;
};

export function computeWarmupCurve(positioned: PositionedTest[], maxPositions = 6): WarmupCurve {
  const buckets: number[][] = Array.from({ length: maxPositions }, () => []);

  for (const test of positioned) {
    if (test.positionInSession < maxPositions) buckets[test.positionInSession].push(test.wpm);
  }

  const first = buckets[0] ?? [];
  const later = buckets.slice(1).flat();
  const firstMedian = median(first);
  const laterMedian = median(later);

  return {
    wpmByPosition: buckets.map((b) => median(b)),
    nByPosition: buckets.map((b) => b.length),
    warmupRatio: {
      value: laterMedian > 0 && firstMedian > 0 ? firstMedian / laterMedian : 0,
      n: first.length,
      reportable: first.length >= MIN_FINDING_N,
    },
  };
}

export type SegmentStat = {
  key: string;
  n: number;
  medianWpm: number;
  medianAccuracy: number;
};

/** Groups by an arbitrary dimension. Used for device and hour-of-day, which
 *  are the two segmentations that can invalidate a personal baseline. */
export function segmentBy(
  positioned: PositionedTest[],
  keyOf: (test: PositionedTest) => string,
): SegmentStat[] {
  const groups = new Map<string, PositionedTest[]>();
  for (const test of positioned) {
    const key = keyOf(test);
    const list = groups.get(key) ?? [];
    list.push(test);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .map(([key, tests]) => ({
      key,
      n: tests.length,
      medianWpm: median(tests.map((t) => t.wpm)),
      medianAccuracy: median(tests.map((t) => t.accuracy)),
    }))
    .sort((a, b) => b.n - a.n);
}

/**
 * True when the window spans devices whose typical speeds differ enough that
 * pooling them would corrupt a personal baseline.
 *
 * Threshold is relative, not absolute, so it means the same thing for a 40 WPM
 * typist and a 120 WPM one.
 */
export const DEVICE_DIVERGENCE_RATIO = 0.1;

export function devicesDiverge(segments: SegmentStat[]): boolean {
  const usable = segments.filter((s) => s.n >= 3 && s.medianWpm > 0);
  if (usable.length < 2) return false;

  const speeds = usable.map((s) => s.medianWpm);
  const fastest = Math.max(...speeds);
  const slowest = Math.min(...speeds);
  return (fastest - slowest) / fastest > DEVICE_DIVERGENCE_RATIO;
}
