/**
 * Offline queue -> Supabase sync (docs/ARCHITECTURE.md §3.3, PHASE-2.md §3).
 *
 * Append-only rows with client-generated UUIDs make this an idempotent
 * upsert with no conflict resolution to do — see CLAUDE.md invariant 7.
 * Running `syncPending()` twice against the same local queue must never
 * duplicate a row or throw.
 *
 * `test_events` is the one exception to "plain upsert": UPDATE/DELETE/
 * TRUNCATE are revoked for `authenticated` at the grant level
 * (supabase/migrations/0002_test_events_immutable.sql). An upsert that hits
 * a conflict there and tries to UPDATE fails outright, so it goes in with
 * `ignoreDuplicates: true` — re-syncing the same immutable blob is a no-op
 * by definition, never a real conflict.
 *
 * Rollups (`key_stats` / `bigram_stats`) are computed with the real
 * statistics engine in src/lib/analysis/ (complete as of this phase) rather
 * than a local approximation.
 */

import { createClient } from "./supabase/client";
import { getUnsyncedTests, markSynced } from "./local";
import type { CompletedTest } from "@/lib/types";
import { EVENT_SCHEMA_VERSION } from "@/lib/types";
import { computeKeyStats } from "@/lib/analysis/keys";
import { computeBigramStats } from "@/lib/analysis/bigrams";
import { parseLayout, type LayoutIndex, type LayoutJson } from "@/lib/analysis/layout";

export type SyncResult = { pushed: number; failed: number };

// ---------------------------------------------------------------------------
// Layout lookup — bigram rollups need finger-adjacency data, loaded from the
// same public/data/layouts/*.json files the typing engine reads. Cached per
// layout name so a batch of tests on one layout fetches it once.
// ---------------------------------------------------------------------------

const layoutCache = new Map<string, Promise<LayoutIndex>>();

async function getLayoutIndex(name: string): Promise<LayoutIndex> {
  let cached = layoutCache.get(name);
  if (!cached) {
    cached = fetch(`/data/layouts/${name}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`layout "${name}" fetch failed: ${res.status}`);
        return res.json() as Promise<LayoutJson>;
      })
      .then(parseLayout);
    layoutCache.set(name, cached);
  }
  // A failed fetch shouldn't poison the cache for a retry.
  try {
    return await cached;
  } catch (err) {
    layoutCache.delete(name);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Row mapping — CompletedTest (client contract, src/lib/types.ts) -> the
// column shapes in supabase/migrations/0001_init.sql. `user_id` isn't part
// of the local contract (it doesn't exist until there's a session), so it's
// threaded through from the authenticated user at sync time.
// ---------------------------------------------------------------------------

function toTestRow(test: CompletedTest, userId: string) {
  return {
    id: test.id,
    user_id: userId,
    started_at: test.startedAt,
    ended_at: test.endedAt,
    duration_ms: test.durationMs,
    mode: test.config.mode,
    mode_setting: test.config.modeSetting,
    language: test.config.language,
    layout: test.config.layout,
    // Queryable so trends can exclude mismatched workloads — a punctuation run
    // and a plain-words run are not comparable (migration 0003).
    punctuation: test.config.punctuation,
    numbers: test.config.numbers,
    wpm: test.result.wpm,
    raw_wpm: test.result.rawWpm,
    accuracy: test.result.accuracy,
    consistency: test.result.consistency,
    chars_correct: test.result.charsCorrect,
    chars_incorrect: test.result.charsIncorrect,
    chars_extra: test.result.charsExtra,
    chars_missed: test.result.charsMissed,
    source: test.source,
    prescription_id: test.prescriptionId,
    device_id: test.deviceId,
    app_version: test.appVersion,
  };
}

function toEventsRow(test: CompletedTest, userId: string) {
  return {
    test_id: test.id,
    user_id: userId,
    schema_ver: EVENT_SCHEMA_VERSION,
    events: test.events,
    // Part of the archive, not metadata: without the prompt the event log
    // cannot be replayed (migration 0005, src/lib/types.ts).
    words: test.words ?? null,
    // Separate column, not merged into `events` — see migration 0006 for why
    // interleaving would corrupt every latency metric.
    keyups: test.keyups ?? null,
    event_count: test.events.length,
  };
}

function toKeyStatsRows(test: CompletedTest, userId: string) {
  return computeKeyStats(test.events).map((stat) => ({
    test_id: test.id,
    user_id: userId,
    key: stat.key,
    n: stat.n,
    errors: stat.errors,
    latency_p50: Math.round(stat.latencyP50),
    latency_p90: Math.round(stat.latencyP90),
    // The distribution, so cross-session pooling is exact (migration 0007).
    latency_hist: stat.latencyHist ?? null,
    analysis_version: 2,
  }));
}

async function toBigramStatsRows(test: CompletedTest, userId: string) {
  const layout = await getLayoutIndex(test.config.layout);
  return computeBigramStats(test.events, layout).map((stat) => ({
    test_id: test.id,
    user_id: userId,
    bigram: stat.bigram,
    n: stat.n,
    errors: stat.errors,
    latency_p50: Math.round(stat.latencyP50),
    latency_hist: stat.latencyHist ?? null,
    same_finger: stat.sameFinger,
    analysis_version: 2,
  }));
}

// ---------------------------------------------------------------------------
// The sync itself
// ---------------------------------------------------------------------------

type SupabaseClient = ReturnType<typeof createClient>;

/**
 * Pushes one test in sequence: tests -> test_events -> key_stats ->
 * bigram_stats. Throws on the first failure and leaves the test unsynced —
 * every step here is upsert-based, so a retry after a partial failure just
 * re-applies the steps that already succeeded as no-ops.
 */
async function syncOneTest(
  supabase: SupabaseClient,
  test: CompletedTest,
  userId: string
): Promise<void> {
  const { error: testErr } = await supabase
    .from("tests")
    .upsert(toTestRow(test, userId), { onConflict: "id", ignoreDuplicates: false });
  if (testErr) throw testErr;

  // test_events: INSERT + SELECT only (0002_test_events_immutable.sql).
  // ignoreDuplicates so a re-sync skips the row on conflict instead of
  // attempting an UPDATE the grants would reject.
  const { error: eventsErr } = await supabase
    .from("test_events")
    .upsert(toEventsRow(test, userId), { onConflict: "test_id", ignoreDuplicates: true });
  if (eventsErr) throw eventsErr;

  const keyRows = toKeyStatsRows(test, userId);
  if (keyRows.length > 0) {
    const { error } = await supabase
      .from("key_stats")
      .upsert(keyRows, { onConflict: "test_id,key", ignoreDuplicates: false });
    if (error) throw error;
  }

  const bigramRows = await toBigramStatsRows(test, userId);
  if (bigramRows.length > 0) {
    const { error } = await supabase
      .from("bigram_stats")
      .upsert(bigramRows, { onConflict: "test_id,bigram", ignoreDuplicates: false });
    if (error) throw error;
  }
}

let inFlight: Promise<SyncResult> | null = null;

/**
 * Drains the local offline queue into Supabase. Safe to call redundantly —
 * concurrent callers share the same in-flight run rather than racing two
 * syncs, and the run itself is idempotent per docs/ARCHITECTURE.md §3.3.
 *
 * Never throws: individual test failures are counted, not raised, so one bad
 * row can't block the rest of the queue.
 */
export function syncPending(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(): Promise<SyncResult> {
  const noop: SyncResult = { pushed: 0, failed: 0 };

  if (typeof window === "undefined") return noop;
  if (!navigator.onLine) return noop;

  const supabase = createClient();

  let userId: string | null = null;
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    // No session, or the auth call itself failed offline — nothing to push.
    return noop;
  }
  if (!userId) return noop;

  const pending = await getUnsyncedTests();
  if (pending.length === 0) return noop;

  setState("syncing");
  let pushed = 0;
  let failed = 0;

  for (const test of pending) {
    try {
      await syncOneTest(supabase, test, userId);
      await markSynced(test.id, new Date().toISOString());
      pushed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[sync] failed to push test ${test.id}:`, err);
    }
  }

  setState("idle");
  const result = { pushed, failed };
  notify(result);
  return result;
}

/** Local-queue size, for the sync status indicator. */
export async function getPendingCount(): Promise<number> {
  return (await getUnsyncedTests()).length;
}

// ---------------------------------------------------------------------------
// Status pub/sub — lets components/sync/* reflect sync progress without
// polling. `state` is coarse (idle/syncing) on purpose; per-test detail isn't
// useful UI, only the aggregate result at the end of a run.
// ---------------------------------------------------------------------------

export type SyncUiState = "idle" | "syncing";

let currentState: SyncUiState = "idle";
const stateListeners = new Set<(state: SyncUiState) => void>();
const resultListeners = new Set<(result: SyncResult) => void>();

function setState(state: SyncUiState): void {
  currentState = state;
  for (const cb of stateListeners) cb(state);
}

function notify(result: SyncResult): void {
  for (const cb of resultListeners) cb(result);
}

export function getSyncState(): SyncUiState {
  return currentState;
}

export function onSyncStateChange(cb: (state: SyncUiState) => void): () => void {
  stateListeners.add(cb);
  return () => stateListeners.delete(cb);
}

/** Fires once per completed `syncPending()` run that actually attempted
 *  network work (i.e. not the early-return no-op paths above). */
export function onSyncComplete(cb: (result: SyncResult) => void): () => void {
  resultListeners.add(cb);
  return () => resultListeners.delete(cb);
}
