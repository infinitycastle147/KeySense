/**
 * Per-bigram rollup — the highest-value metric per docs/ARCHITECTURE.md §5.4:
 * weakness lives in *transitions*, not individual keys.
 */

import type { KeyEvent, BigramStat } from "@/lib/types";
import type { LayoutIndex } from "./layout";
import { OUTLIER_MS, bootstrapMedianCI, percentile, wilsonInterval } from "./stats";
import { buildHistogram } from "./histogram";

type BigramAccumulator = {
  n: number;
  errors: number;
  latencies: number[];
  sameFinger: boolean;
};

/**
 * A bigram is identified by (prev expected char, this expected char) — i.e.
 * the transition the user was *supposed* to make, regardless of whether they
 * typed it correctly. `event.prev` carries this context directly.
 *
 * Latency for an occurrence is only recorded when the immediately preceding
 * *event* in the raw stream is itself a "char" event whose `expected` equals
 * `event.prev` — i.e. no backspace/word-delete happened between the two
 * keystrokes. This deliberately excludes the case where a correction
 * intervened: `t[i] - t[i-1]` would then measure recovery time, not clean
 * transition time, and would corrupt the bigram-latency signal. The
 * occurrence still counts toward n/errors either way — only the latency
 * sample is skipped for corrected transitions.
 *
 * `sameFinger` is resolved once per bigram via the layout (constant for a
 * given bigram+layout, so the last-seen occurrence's resolution is used).
 * Bigrams whose characters aren't in the layout resolve to `sameFinger: false`.
 */
export function computeBigramStats(events: KeyEvent[], layout: LayoutIndex): BigramStat[] {
  const groups = new Map<string, BigramAccumulator>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.kind !== "char" || event.prev === null) continue;

    const bigram = event.prev + event.expected;
    const acc = groups.get(bigram) ?? {
      n: 0,
      errors: 0,
      latencies: [],
      sameFinger: resolveSameFinger(layout, event.prev, event.expected),
    };
    acc.n += 1;
    if (!event.ok) acc.errors += 1;

    const prevEvent = events[i - 1];
    if (prevEvent.kind === "char" && prevEvent.expected === event.prev) {
      const interval = event.t - prevEvent.t;
      if (interval >= 0 && interval <= OUTLIER_MS) acc.latencies.push(interval);
    }

    groups.set(bigram, acc);
  }

  const stats: BigramStat[] = [];
  for (const [bigram, acc] of groups) {
    stats.push({
      bigram,
      n: acc.n,
      errors: acc.errors,
      errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
      errorRateCI: wilsonInterval(acc.errors, acc.n),
      latencyP50: percentile(acc.latencies, 50),
      latencyCI: bootstrapMedianCI(acc.latencies),
      latencyHist: buildHistogram(acc.latencies),
      sameFinger: acc.sameFinger,
    });
  }

  return stats;
}

function resolveSameFinger(layout: LayoutIndex, first: string, second: string): boolean {
  const keyA = layout.charToKey(first);
  const keyB = layout.charToKey(second);
  if (!keyA || !keyB) return false;
  return layout.isSameFinger(keyA, keyB);
}

/** Convenience filter used by profile.ts and dashboard code: same-finger
 *  bigrams (SFBs) are a universal weak point worth isolating explicitly, per
 *  docs/ARCHITECTURE.md §5.4. */
export function filterSameFingerBigrams(bigramStats: BigramStat[]): BigramStat[] {
  return bigramStats.filter((b) => b.sameFinger);
}
