/**
 * Sync idempotency tests. The critical constraint under test: `test_events`
 * has UPDATE/DELETE/TRUNCATE revoked at the grant level
 * (supabase/migrations/0002_test_events_immutable.sql), so re-syncing the
 * same test must go through as `ignoreDuplicates: true` — an upsert that
 * tries to UPDATE it would fail outright. The fake Supabase client below
 * enforces that constraint the same way Postgres does, so a regression here
 * (flipping the flag, or attempting an UPDATE on conflict) fails the test
 * instead of only showing up against the real database.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { CompletedTest } from "@/lib/types";
import { charEvent } from "@/lib/analysis/test-utils";

type Row = Record<string, unknown>;
type UpsertOpts = { onConflict: string; ignoreDuplicates: boolean };

/**
 * Minimal in-memory stand-in for the four tables sync.ts writes to. Mirrors
 * real Postgres upsert semantics closely enough to catch the bugs that
 * matter here: duplicate rows on conflict, and UPDATE attempts against a
 * table where the grant is revoked.
 */
function makeFakeSupabase(userId: string | null) {
  const tables: Record<string, Map<string, Row>> = {
    tests: new Map(),
    test_events: new Map(),
    key_stats: new Map(),
    bigram_stats: new Map(),
  };

  // authenticated has no UPDATE/DELETE/TRUNCATE on test_events — see
  // supabase/migrations/0002_test_events_immutable.sql.
  const updateForbidden = new Set(["test_events"]);

  function keyFor(table: string, row: Row): string {
    switch (table) {
      case "tests":
        return String(row.id);
      case "test_events":
        return String(row.test_id);
      case "key_stats":
        return `${row.test_id}:${row.key}`;
      case "bigram_stats":
        return `${row.test_id}:${row.bigram}`;
      default:
        throw new Error(`fake supabase: unknown table "${table}"`);
    }
  }

  return {
    auth: {
      getUser: async () => ({ data: { user: userId ? { id: userId } : null } }),
    },
    from(table: string) {
      const map = tables[table];
      return {
        upsert(rowsInput: Row | Row[], opts: UpsertOpts) {
          const rows = Array.isArray(rowsInput) ? rowsInput : [rowsInput];
          for (const row of rows) {
            const key = keyFor(table, row);
            const exists = map.has(key);
            if (exists && updateForbidden.has(table) && !opts.ignoreDuplicates) {
              return Promise.resolve({
                error: new Error(
                  `fake supabase: UPDATE rejected on "${table}" (grant revoked)`
                ),
              });
            }
            if (exists && opts.ignoreDuplicates) continue; // ON CONFLICT DO NOTHING
            map.set(key, row);
          }
          return Promise.resolve({ error: null });
        },
      };
    },
    tables,
  };
}

type FakeSupabase = ReturnType<typeof makeFakeSupabase>;

let fakeSupabase: FakeSupabase;
let unsyncedTests: CompletedTest[];
const markSyncedCalls: string[] = [];

vi.mock("@/lib/db/supabase/client", () => ({
  createClient: () => fakeSupabase,
}));

vi.mock("@/lib/db/local", () => ({
  getUnsyncedTests: async () => unsyncedTests,
  markSynced: async (id: string) => {
    markSyncedCalls.push(id);
  },
}));

function buildTest(id: string): CompletedTest {
  const events = [
    charEvent({ t: 0, expected: "t", key: "t" }),
    charEvent({ t: 120, expected: "h", key: "h", prev: "t" }),
    charEvent({ t: 250, expected: "e", key: "x", prev: "h" }), // error
    charEvent({ t: 380, expected: "t", key: "t", prev: "e" }),
    charEvent({ t: 500, expected: "h", key: "h", prev: "t" }),
  ];

  return {
    id,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:00:30.000Z",
    durationMs: 30000,
    config: {
      mode: "time",
      modeSetting: "30",
      language: "english",
      layout: "qwerty",
      punctuation: false,
      numbers: false,
    },
    result: {
      wpm: 72,
      rawWpm: 75,
      accuracy: 0.8,
      consistency: 88,
      charsCorrect: 4,
      charsIncorrect: 1,
      charsExtra: 0,
      charsMissed: 0,
    },
    events,
    source: "freeplay",
    prescriptionId: null,
    deviceId: "device-1",
    appVersion: "0.1.0",
    syncedAt: null,
  };
}

beforeEach(() => {
  fakeSupabase = makeFakeSupabase("user-1");
  markSyncedCalls.length = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const match = /\/data\/layouts\/([\w-]+)\.json$/.exec(url);
      if (!match) throw new Error(`fake fetch: unexpected url "${url}"`);
      const file = path.join(process.cwd(), "public", "data", "layouts", `${match[1]}.json`);
      const json = JSON.parse(fs.readFileSync(file, "utf-8"));
      return { ok: true, status: 200, json: async () => json } as Response;
    })
  );
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("syncPending", () => {
  test("pushes a pending test into every table with the right row counts", async () => {
    unsyncedTests = [buildTest("test-1")];
    const { syncPending } = await import("./sync");

    const result = await syncPending();

    expect(result).toEqual({ pushed: 1, failed: 0 });
    expect(fakeSupabase.tables.tests.size).toBe(1);
    expect(fakeSupabase.tables.test_events.size).toBe(1);
    expect(fakeSupabase.tables.key_stats.size).toBeGreaterThan(0);
    expect(fakeSupabase.tables.bigram_stats.size).toBeGreaterThan(0);
    expect(markSyncedCalls).toEqual(["test-1"]);

    const eventsRow = fakeSupabase.tables.test_events.get("test-1");
    expect(eventsRow?.event_count).toBe(5);
  });

  test("running sync twice does not duplicate rows or error on test_events", async () => {
    unsyncedTests = [buildTest("test-1")];
    const { syncPending } = await import("./sync");

    const first = await syncPending();
    const second = await syncPending(); // local queue mock doesn't shrink — simulates a retry

    expect(first).toEqual({ pushed: 1, failed: 0 });
    expect(second).toEqual({ pushed: 1, failed: 0 });

    // No duplication: exactly one row per table, keyed by id/test_id.
    expect(fakeSupabase.tables.tests.size).toBe(1);
    expect(fakeSupabase.tables.test_events.size).toBe(1);

    const keyStatsCountAfterOne = [...fakeSupabase.tables.key_stats.keys()].length;
    const bigramStatsCountAfterOne = [...fakeSupabase.tables.bigram_stats.keys()].length;
    expect(keyStatsCountAfterOne).toBeGreaterThan(0);
    expect(bigramStatsCountAfterOne).toBeGreaterThan(0);
  });

  test("a naive UPDATE-style upsert on test_events would be rejected (sanity check on the fake)", async () => {
    fakeSupabase.tables.test_events.set("test-1", { test_id: "test-1" });
    const res = await fakeSupabase
      .from("test_events")
      .upsert({ test_id: "test-1" }, { onConflict: "test_id", ignoreDuplicates: false });
    expect(res.error).not.toBeNull();
  });

  test("does nothing when signed out", async () => {
    fakeSupabase = makeFakeSupabase(null);
    unsyncedTests = [buildTest("test-1")];
    const { syncPending } = await import("./sync");

    const result = await syncPending();

    expect(result).toEqual({ pushed: 0, failed: 0 });
    expect(fakeSupabase.tables.tests.size).toBe(0);
    expect(markSyncedCalls).toEqual([]);
  });

  test("does nothing when offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    unsyncedTests = [buildTest("test-1")];
    const { syncPending } = await import("./sync");

    const result = await syncPending();

    expect(result).toEqual({ pushed: 0, failed: 0 });
    expect(fakeSupabase.tables.tests.size).toBe(0);
  });

  test("does nothing when the queue is empty", async () => {
    unsyncedTests = [];
    const { syncPending } = await import("./sync");

    const result = await syncPending();

    expect(result).toEqual({ pushed: 0, failed: 0 });
  });

  test("concurrent calls share one in-flight run instead of racing", async () => {
    unsyncedTests = [buildTest("test-1")];
    const { syncPending } = await import("./sync");

    const [a, b] = await Promise.all([syncPending(), syncPending()]);

    expect(a).toEqual({ pushed: 1, failed: 0 });
    expect(b).toEqual({ pushed: 1, failed: 0 });
    // Only synced once, not twice, despite two callers.
    expect(markSyncedCalls).toEqual(["test-1"]);
  });

  test("one failing test does not block the rest of the queue", async () => {
    unsyncedTests = [buildTest("bad"), buildTest("good")];

    const { syncPending } = await import("./sync");

    // Force the first test's `tests` upsert to fail by making its row shape
    // invalid in a way the fake rejects — simulate by monkey-patching `from`
    // for just the first call.
    const realFrom = fakeSupabase.from.bind(fakeSupabase);
    let testsCalls = 0;
    fakeSupabase.from = ((table: string) => {
      if (table === "tests") {
        testsCalls += 1;
        if (testsCalls === 1) {
          return {
            upsert: () => Promise.resolve({ error: new Error("simulated failure") }),
          };
        }
      }
      return realFrom(table);
    }) as typeof fakeSupabase.from;

    const result = await syncPending();

    expect(result).toEqual({ pushed: 1, failed: 1 });
    expect(markSyncedCalls).toEqual(["good"]);
  });
});
