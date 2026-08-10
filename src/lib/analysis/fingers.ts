/**
 * Per-finger rollup — attribution via the layout map. `relativeLatency` is
 * always against the user's own overall median for this test/window, never a
 * population norm (docs/ARCHITECTURE.md §5.3).
 */

import type { KeyEvent, FingerStat, Finger } from "@/lib/types";
import type { LayoutIndex } from "./layout";
import { OUTLIER_MS, bootstrapMedianCI, median } from "./stats";
import { extractTransitions, fitResidualModel, computeFingerResiduals } from "./residual";

type FingerAccumulator = {
  n: number;
  errors: number;
  latencies: number[];
};

/**
 * Only "char" events with an expected character resolvable to a physical key
 * (and thence a finger) via the layout are counted. Events for characters not
 * present in the layout (shouldn't happen in practice, but defensively
 * possible) are skipped rather than mis-attributed.
 *
 * `relativeLatency` = this finger's median latency / the median latency
 * across *all* attributable intervals in the input (the user's own overall
 * baseline for this call, not a population norm). A finger with no surviving
 * latency samples (e.g. n=1, or every interval was an outlier) reports
 * latencyP50 = 0 and relativeLatency = 0 — 0 is used as an explicit "no data"
 * sentinel here (never 1/"neutral", which would misleadingly claim the
 * finger performs exactly at baseline). Callers must check latencyP50 > 0 (or
 * n) before treating relativeLatency as meaningful.
 *
 * Fingers with zero attributable events are omitted from the result rather
 * than emitted with n=0 — a FingerStat with no data isn't a stat.
 */
export function computeFingerStats(events: KeyEvent[], layout: LayoutIndex): FingerStat[] {
  const groups = new Map<Finger, FingerAccumulator>();
  const allLatencies: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.kind !== "char") continue;

    const key = layout.charToKey(event.expected);
    const finger = key ? layout.keyToFinger(key) : undefined;
    if (!finger) continue;

    const acc = groups.get(finger) ?? { n: 0, errors: 0, latencies: [] };
    acc.n += 1;
    if (!event.ok) acc.errors += 1;

    if (i > 0) {
      const interval = event.t - events[i - 1].t;
      if (interval >= 0 && interval <= OUTLIER_MS) {
        acc.latencies.push(interval);
        allLatencies.push(interval);
      }
    }

    groups.set(finger, acc);
  }

  const overallMedian = median(allLatencies);

  // The adjusted figure that separates "this finger is slow" from "the keys
  // before it are far away" — see ./residual.ts. Computed from the same event
  // stream, so both numbers describe the same sample.
  const transitions = extractTransitions(events, layout);
  const adjustedByFinger = new Map(
    computeFingerResiduals(transitions, fitResidualModel(transitions)).map((r) => [
      r.finger,
      r.relativeAdjusted,
    ]),
  );

  const stats: FingerStat[] = [];
  for (const [finger, acc] of groups) {
    const latencyP50 = median(acc.latencies);
    stats.push({
      finger,
      n: acc.n,
      errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
      latencyP50,
      latencyCI: bootstrapMedianCI(acc.latencies),
      relativeLatency: latencyP50 > 0 && overallMedian > 0 ? latencyP50 / overallMedian : 0,
      ...(adjustedByFinger.has(finger) ? { relativeAdjusted: adjustedByFinger.get(finger) } : {}),
    });
  }

  return stats;
}
