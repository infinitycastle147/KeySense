/**
 * IndexedDB persistence for completed tests — the offline write-ahead queue
 * (docs/ARCHITECTURE.md §3.3, §4.1).
 *
 * Tests are written exactly once, on completion. Never mid-test — see
 * docs/ARCHITECTURE.md §3.2 and the typing-engine skill. Rows carry a
 * client-generated UUID (`CompletedTest.id`) and a `syncedAt` index so Phase 2's
 * sync worker can find unsynced rows without a full scan.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { CompletedTest } from "@/lib/types";

const DB_NAME = "keysense";
const DB_VERSION = 1;
const STORE = "tests";

/**
 * `null` is not a valid IndexedDB key — an index built directly on `syncedAt`
 * would silently *exclude* every unsynced row (the one case we need to find).
 * So indexing happens on this shadow string field ("" = unsynced, ISO string =
 * synced) instead, kept in sync with `syncedAt` internally and never exposed
 * outside this file.
 */
type StoredTest = CompletedTest & { _syncedAtIndex: string };

interface KeySenseDB extends DBSchema {
  tests: {
    key: string;
    value: StoredTest;
    indexes: { syncedAt: string };
  };
}

let dbPromise: Promise<IDBPDatabase<KeySenseDB>> | null = null;

function getDb(): Promise<IDBPDatabase<KeySenseDB>> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("IndexedDB is not available in this environment")
    );
  }
  if (!dbPromise) {
    dbPromise = openDB<KeySenseDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("syncedAt", "_syncedAtIndex");
      },
    });
  }
  return dbPromise;
}

function toStored(test: CompletedTest): StoredTest {
  return { ...test, _syncedAtIndex: test.syncedAt ?? "" };
}

function fromStored(stored: StoredTest): CompletedTest {
  const { _syncedAtIndex: _unused, ...test } = stored;
  void _unused;
  return test;
}

/**
 * Fires a best-effort background sync after a local write. `saveTest` is only
 * called once, at test completion (see docs/ARCHITECTURE.md §3.2/§3.3), so
 * this can never fire mid-test — it is the "on test completion" trigger from
 * PHASE-2.md §4. `syncPending` itself no-ops when signed out, so "if online
 * and signed in" is enforced there, not here.
 *
 * Dynamic import keeps this module (and its callers, e.g. the typing engine)
 * free of a static dependency on the Supabase client, and avoids a circular
 * static import with sync.ts, which imports `getUnsyncedTests`/`markSynced`
 * from this file.
 */
function triggerBackgroundSync(): void {
  if (typeof window === "undefined" || !navigator.onLine) return;
  void import("./sync")
    .then((sync) => sync.syncPending())
    .catch(() => {
      // Surfaced via the sync status UI (src/components/sync/), not here —
      // a failed background sync must never throw into the caller of saveTest.
    });
}

/** Persist a completed test. Idempotent — writing the same `id` twice overwrites
 *  rather than duplicating, matching the append-only-by-UUID sync model
 *  (docs/ARCHITECTURE.md §3.3). */
export async function saveTest(test: CompletedTest): Promise<void> {
  const db = await getDb();
  await db.put(STORE, toStored(test));
  triggerBackgroundSync();
}

export async function getTest(id: string): Promise<CompletedTest | undefined> {
  const db = await getDb();
  const stored = await db.get(STORE, id);
  return stored ? fromStored(stored) : undefined;
}

/** Newest first. */
export async function getAllTests(): Promise<CompletedTest[]> {
  const db = await getDb();
  const all = await db.getAll(STORE);
  return all.map(fromStored).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Tests not yet pushed to Supabase — the queue Phase 2's sync worker drains. */
export async function getUnsyncedTests(): Promise<CompletedTest[]> {
  const db = await getDb();
  const unsynced = await db.getAllFromIndex(STORE, "syncedAt", "");
  return unsynced.map(fromStored);
}

export async function markSynced(id: string, at: string): Promise<void> {
  const db = await getDb();
  const existing = await db.get(STORE, id);
  if (!existing) return;
  await db.put(STORE, { ...existing, syncedAt: at, _syncedAtIndex: at });
}

const DEVICE_ID_KEY = "keysense:deviceId";

/** Stable per-browser id, generated once and cached in localStorage. Needed to
 *  populate `CompletedTest.deviceId` from the moment tests are first recorded —
 *  Phase 2 reads it for multi-device history but does not need to create it. */
export function getDeviceId(): string {
  if (typeof localStorage === "undefined") return "server";
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
