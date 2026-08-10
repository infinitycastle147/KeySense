/**
 * Writing and reading the `snapshots` table.
 *
 * The table has existed since 0001_init.sql — with RLS, an index, and a
 * documented purpose ("periodic metric profile for longitudinal tracking") —
 * and nothing ever wrote a row. The result was a product built entirely around
 * recomputable history that could not show a typist their history.
 *
 * A snapshot is a *derived* record, not an archival one: it can be rebuilt at
 * any time from `test_events`, so unlike the raw log it is safe to overwrite,
 * and it carries no independent authority. It exists purely so the longitudinal
 * views don't have to re-analyse a year of raw blobs to draw one line.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetricProfile } from "@/lib/types";
import type { SeriesPoint } from "@/lib/analysis/learning";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase's generic client type without generated Database types
type AnySupabaseClient = SupabaseClient<any, any, any>;

/**
 * The subset of a MetricProfile worth keeping for longitudinal tracking.
 *
 * Deliberately not the whole profile. Storing everything would make snapshots
 * as large as the analysis they summarise and would freeze every metric's
 * current shape into a table that outlives it — the top-N lists in particular
 * are a *view*, recomputed whenever the ranker improves, and pinning them here
 * would create a second, stale answer to "what are my worst bigrams".
 */
export type SnapshotMetrics = {
  wpm: number;
  accuracy: number;
  consistency: number;
  errorTaxonomy: MetricProfile["errorTaxonomy"];
  rhythm: MetricProfile["rhythm"];
  dynamics: MetricProfile["dynamics"];
  quality: MetricProfile["quality"];
  geometry: { alternationRate: number; redirectRate: number; medianSameHandRun: number };
  timeLoss: { floorMs: number; baselineWpm: number };
  /** Per-target error rates, so a learning curve can be drawn per bigram
   *  without re-reading raw events. Keyed by bigram. */
  bigramErrorRates: Record<string, { errorRate: number; n: number }>;
};

export function toSnapshotMetrics(profile: MetricProfile): SnapshotMetrics {
  const bigramErrorRates: SnapshotMetrics["bigramErrorRates"] = {};
  // The display list, not the discovery list. A learning curve needs a bigram
  // sampled on every window, and FDR significance is a property of the window,
  // not of the bigram: gating on it would drop each target from the snapshot on
  // exactly the windows where it stopped looking like an outlier — punching
  // holes in the curve at the moment the drills started working.
  for (const b of profile.bigramStats) {
    bigramErrorRates[b.bigram] = { errorRate: b.errorRate, n: b.n };
  }

  return {
    wpm: profile.overall.wpm.value,
    accuracy: profile.overall.accuracy.value,
    consistency: profile.overall.consistency.value,
    errorTaxonomy: profile.errorTaxonomy,
    rhythm: profile.rhythm,
    dynamics: profile.dynamics,
    quality: profile.quality,
    geometry: {
      alternationRate: profile.geometry.alternationRate,
      redirectRate: profile.geometry.redirectRate,
      medianSameHandRun: profile.geometry.medianSameHandRun,
    },
    timeLoss: { floorMs: profile.timeLoss.floorMs, baselineWpm: profile.timeLoss.baselineWpm },
    bigramErrorRates,
  };
}

export async function writeSnapshot(
  supabase: AnySupabaseClient,
  userId: string,
  profile: MetricProfile,
): Promise<{ error: string | null }> {
  // An empty window has nothing to track and would draw a zero into every
  // longitudinal chart.
  if (profile.testCount === 0) return { error: null };

  const { error } = await supabase.from("snapshots").insert({
    user_id: userId,
    window_start: profile.windowStart,
    window_end: profile.windowEnd,
    tests_in_window: profile.testCount,
    metrics: toSnapshotMetrics(profile),
  });

  return { error: error ? error.message : null };
}

type SnapshotRow = {
  window_end: string;
  tests_in_window: number;
  metrics: SnapshotMetrics;
};

export async function listSnapshots(
  supabase: AnySupabaseClient,
  limit = 100,
): Promise<{ snapshots: SnapshotRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from("snapshots")
    .select("window_end, tests_in_window, metrics")
    .order("window_end", { ascending: true })
    .limit(limit);

  if (error) return { snapshots: [], error: error.message };
  return { snapshots: (data ?? []) as SnapshotRow[], error: null };
}

/**
 * Extracts one metric's history as a series ready for
 * `computeLearningCurve`.
 *
 * Snapshots missing the requested value are skipped rather than contributing a
 * zero — a metric that did not exist yet is not a metric that was zero, and
 * plotting it as zero would show a dramatic "improvement" on the day it was
 * first computed.
 */
export function snapshotSeries(
  snapshots: SnapshotRow[],
  pick: (metrics: SnapshotMetrics) => { value: number; n: number } | undefined,
): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const row of snapshots) {
    const picked = pick(row.metrics);
    if (!picked || !Number.isFinite(picked.value)) continue;
    points.push({ at: row.window_end, value: picked.value, n: picked.n });
  }
  return points;
}
