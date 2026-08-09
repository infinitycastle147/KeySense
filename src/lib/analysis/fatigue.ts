/**
 * WPM per time bucket across a test — degradation after ~40s is a stamina
 * finding, distinct from a technique finding. Per docs/ARCHITECTURE.md §5.4.
 */

import type { KeyEvent } from "@/lib/types";

export type FatigueBucket = {
  bucketIndex: number;
  startMs: number;
  /** Exclusive end of this bucket, clamped to `durationMs` — the final
   *  bucket is frequently partial and must not be treated as a full-length
   *  window or its WPM would be under-reported. */
  endMs: number;
  /** "Correct" WPM: (correct chars / 5) / bucket duration in minutes. */
  wpm: number;
  /** Total char-kind attempts (correct + incorrect) in this bucket — the
   *  sample size backing `wpm`, kept alongside it so a near-empty bucket
   *  (e.g. the trailing partial second) doesn't read as a real data point. */
  n: number;
};

const CHARS_PER_WORD = 5;

/**
 * Buckets are fixed-width (`bucketSeconds`, default 10s) from test start.
 * `durationMs` should be the actual test duration (not inferred from the
 * last event), so a trailing bucket with few/no events is still sized
 * correctly rather than assumed empty-duration.
 *
 * Empty input, or durationMs <= 0, returns [].
 */
export function computeFatigueCurve(
  events: KeyEvent[],
  durationMs: number,
  bucketSeconds = 10
): FatigueBucket[] {
  if (durationMs <= 0 || bucketSeconds <= 0) return [];

  const bucketMs = bucketSeconds * 1000;
  const bucketCount = Math.max(1, Math.ceil(durationMs / bucketMs));
  const buckets: FatigueBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    bucketIndex: i,
    startMs: i * bucketMs,
    endMs: Math.min((i + 1) * bucketMs, durationMs),
    wpm: 0,
    n: 0,
  }));

  const correctCounts = new Array(bucketCount).fill(0);
  const totalCounts = new Array(bucketCount).fill(0);

  for (const event of events) {
    if (event.kind !== "char") continue;
    if (event.t < 0 || event.t > durationMs) continue;

    const bucketIndex = Math.min(bucketCount - 1, Math.floor(event.t / bucketMs));
    totalCounts[bucketIndex] += 1;
    if (event.ok) correctCounts[bucketIndex] += 1;
  }

  for (let i = 0; i < bucketCount; i++) {
    const bucket = buckets[i];
    bucket.n = totalCounts[i];
    const bucketDurationMinutes = (bucket.endMs - bucket.startMs) / 1000 / 60;
    bucket.wpm =
      bucketDurationMinutes > 0 ? correctCounts[i] / CHARS_PER_WORD / bucketDurationMinutes : 0;
  }

  return buckets;
}
