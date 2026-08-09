/**
 * Per-key rollup: attempt count, error rate with Wilson CI, and robust
 * latency percentiles. See docs/ARCHITECTURE.md §5.4.
 */

import type { KeyEvent, KeyStat } from "@/lib/types";
import { OUTLIER_MS, percentile, wilsonInterval } from "./stats";

type KeyAccumulator = {
  n: number;
  errors: number;
  /** Outlier-filtered inter-key intervals (ms) immediately preceding an
   *  attempt at this key. Only "char" events count as attempts — backspace
   *  and word-delete are corrections, tracked separately in corrections.ts. */
  latencies: number[];
};

/**
 * Computes one KeyStat per distinct `expected` character seen among "char"
 * events. Grouped by *expected*, not *typed* — the question a KeyStat
 * answers is "how does the user perform when this key is called for",
 * regardless of what they actually pressed.
 *
 * Latency for an attempt is the raw inter-event interval (t[i] - t[i-1]);
 * intervals > OUTLIER_MS are discarded before any percentile is computed, per
 * the outlier rule. The very first event in the stream has no preceding
 * interval and contributes to n/errors but not latency.
 *
 * Empty input returns []. A key with no surviving (non-outlier) latency
 * samples reports latencyP50/P90 as 0 — n and errorRate remain accurate
 * regardless, since those don't depend on interval filtering.
 */
export function computeKeyStats(events: KeyEvent[]): KeyStat[] {
  const groups = new Map<string, KeyAccumulator>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.kind !== "char") continue;

    const acc = groups.get(event.expected) ?? { n: 0, errors: 0, latencies: [] };
    acc.n += 1;
    if (!event.ok) acc.errors += 1;

    if (i > 0) {
      const interval = event.t - events[i - 1].t;
      if (interval >= 0 && interval <= OUTLIER_MS) acc.latencies.push(interval);
    }

    groups.set(event.expected, acc);
  }

  const stats: KeyStat[] = [];
  for (const [key, acc] of groups) {
    stats.push({
      key,
      n: acc.n,
      errors: acc.errors,
      errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
      errorRateCI: wilsonInterval(acc.errors, acc.n),
      latencyP50: percentile(acc.latencies, 50),
      latencyP90: percentile(acc.latencies, 90),
    });
  }

  return stats;
}
