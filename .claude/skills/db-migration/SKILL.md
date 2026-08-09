---
name: db-migration
description: Add or change a Supabase/Postgres table, column, index, or RLS policy in KeySense. Use when the schema needs to change, when adding a rollup column, or when a stored metric definition changes and existing rows need backfilling. Covers the append-only and analysis_version rules.
---

# Changing the KeySense schema

Migrations live in `supabase/migrations/`, numbered and applied in order. They are
append-only — never edit a migration that has been applied; write a new one.

## The append-only rule

`test_events` holds the immutable raw archive. Everything else is derived.

- **Never `UPDATE` or `DELETE` from `test_events`.** Client `UPDATE` is revoked at the
  grant level in `0001_init.sql`; keep it that way.
- Derived tables (`key_stats`, `bigram_stats`, `snapshots`) may be dropped and rebuilt
  freely — that is the whole point of keeping raw.

If a change seems to require mutating raw events, the change is wrong. Recompute a derived
view instead.

## Adding a rollup column

Changing what a stored metric means requires three things, not one:

1. The migration adding the column.
2. **Bump `analysis_version`** on that table's default.
3. A backfill that recomputes the column from `test_events` for existing rows.

Shipping 1 without 2 and 3 leaves a table where old and new rows mean different things —
which produces trend charts with a phantom step change at the deploy date. That is worse
than having no metric.

```sql
alter table public.bigram_stats add column rollover boolean not null default false;
alter table public.bigram_stats alter column analysis_version set default 2;
-- then run the backfill job over rows where analysis_version < 2
```

## RLS is mandatory

Every table is user-scoped. A new table needs, in the same migration:

```sql
alter table public.<name> enable row level security;

create policy <name>_owner on public.<name> for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
```

Wrap `auth.uid()` in `(select …)` — it lets Postgres evaluate it once per query rather
than once per row, which matters on the rollup tables.

Every table carries `user_id` directly, even where it could be joined through `tests`.
This is deliberate: it keeps RLS policies simple and index-friendly.

## Indexing

The access patterns are known and narrow:

- history / dashboard → `(user_id, started_at desc)`
- cross-session aggregation → `(user_id, key)` / `(user_id, bigram)`
- active prescriptions → `(user_id, status)`

Add an index when adding an access pattern, not speculatively.

## Applying

With the Supabase MCP connected, apply via the migration tool. Otherwise paste into the
SQL editor in the Supabase dashboard. After applying, regenerate types:

```bash
npx supabase gen types typescript --project-id <ref> > src/lib/db/database.types.ts
```

## Checklist

- [ ] New file in `supabase/migrations/`, never an edit to an applied one
- [ ] `user_id` column present, referencing `auth.users(id) on delete cascade`
- [ ] RLS enabled + owner policy created
- [ ] Indexes match a real access pattern
- [ ] `analysis_version` bumped if a stored metric definition changed
- [ ] Backfill written for existing rows
- [ ] Types regenerated
