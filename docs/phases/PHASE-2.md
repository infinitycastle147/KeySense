# Phase 2 — Auth + offline-first sync

**Goal:** tests recorded on any device appear on every device, and the app works fully
offline.

**Depends on:** `src/lib/types.ts` (fixed). The Supabase schema is **already applied** —
7 tables, RLS enabled, owner policies live. Do not write new migrations unless a genuine
gap appears; if one does, add `supabase/migrations/0003_*.sql` and follow the
`db-migration` skill.

---

## Scope

### 1. Auth — `src/app/(auth)/`

Supabase email magic-link (no password to manage; this is a single-user personal tool).

- `login/page.tsx` — email input, sends magic link
- `auth/callback/route.ts` — exchanges the code for a session
- Clients already exist in `src/lib/db/supabase/` — **use them, do not create new ones**:
  - `client.ts` browser · `server.ts` server (RLS applies) · `admin.ts` bypasses RLS
- `src/proxy.ts` already refreshes the session. Add the redirect for unauthenticated
  users there, but **allow `/` to stay public** — typing must work without an account, with
  results held locally until sign-in.

### 2. IndexedDB queue — `src/lib/db/local.ts`

Phase 1 creates this store. Extend it with:

- `getUnsynced()` — tests where `syncedAt === null`
- `markSynced(id, at)`
- A stable `deviceId` in `localStorage`, generated once

### 3. Sync — `src/lib/db/sync.ts`

```ts
syncPending(): Promise<{ pushed: number; failed: number }>
```

Because rows are append-only with **client-generated UUIDs**, sync is an idempotent
upsert — there is no conflict resolution, and there must not be. Do not introduce mutable
per-test state that two devices could both edit.

Per test, in one transaction-ish sequence:

1. `upsert` into `tests` (`onConflict: "id"`, `ignoreDuplicates: false`)
2. `upsert` into `test_events` — the full `KeyEvent[]` as the `events` JSONB blob
3. Compute and `upsert` per-test rollups into `key_stats` and `bigram_stats`

> **`test_events` is INSERT + SELECT only.** UPDATE, DELETE, and TRUNCATE are revoked at
> the grant level. An upsert that attempts an UPDATE will fail — use
> `ignoreDuplicates: true` for that table specifically, since re-syncing the same
> immutable blob is a no-op by definition.

**Rollups:** Phase 3 owns the real statistics. For now compute only what the schema needs
(`n`, `errors`, `latency_p50`, `same_finger`) using simple median and the >1000ms outlier
filter. Import from `src/lib/analysis/` **if it exists** by the time you run; otherwise
write minimal local helpers and leave a `TODO(phase-3)` to swap them out.

### 4. Sync triggers

- On test completion, if online and signed in
- On sign-in (flush the backlog)
- On `window.online`
- Manual "sync now" in settings

Never block the UI on sync. Never sync mid-test.

### 5. History — `src/app/history/page.tsx`

Server component using `server.ts`. Paginated list of tests, newest first — mode,
duration, WPM, accuracy, date. Uses the `tests_user_started_idx` index.

### 6. Sync status UI

A small indicator: synced / n pending / offline. Use the `sonner` toaster for failures,
with the honest message: *"Sync failed — 3 tests stored locally, will retry."*

---

## Out of scope

The typing engine, analysis, dashboard charts, AI. Do not edit `src/lib/engine/` or
`src/lib/analysis/`.

## Acceptance

- [ ] Magic-link sign-in works end to end
- [ ] A test taken offline syncs when connectivity returns
- [ ] Re-running sync twice does not duplicate rows or error on `test_events`
- [ ] Signing in on a second browser profile shows the same history
- [ ] Anonymous users can still type; results persist locally
- [ ] `npm run typecheck && npm run lint && npm test && npm run build` all clean
