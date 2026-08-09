-- KeySense initial schema
-- See docs/ARCHITECTURE.md §4 for rationale.
--
-- Core principle: test_events is immutable and append-only. Everything else is a
-- derived view that can be recomputed from it. Never UPDATE test_events.

-- ---------------------------------------------------------------------------
-- tests — one row per completed typing test
-- ---------------------------------------------------------------------------
create table if not exists public.tests (
  id              uuid primary key,              -- client-generated, enables idempotent sync
  user_id         uuid not null references auth.users(id) on delete cascade,

  started_at      timestamptz not null,
  ended_at        timestamptz not null,
  duration_ms     integer not null,

  mode            text not null,                 -- 'time' | 'words' | 'quote' | 'zen' | 'drill'
  mode_setting    text,                          -- '60', '25', quote id, …
  language        text not null default 'english',
  layout          text not null default 'qwerty',

  -- headline stats (denormalised for fast history/dashboard reads)
  wpm             numeric(6,2) not null,
  raw_wpm         numeric(6,2) not null,
  accuracy        numeric(5,2) not null,
  consistency     numeric(5,2),

  chars_correct   integer not null default 0,
  chars_incorrect integer not null default 0,
  chars_extra     integer not null default 0,
  chars_missed    integer not null default 0,

  -- provenance
  source          text not null default 'freeplay',   -- 'freeplay' | 'prescribed'
  prescription_id uuid,                               -- FK added after prescriptions exists
  device_id       text,
  app_version     text,

  created_at      timestamptz not null default now()
);

create index if not exists tests_user_started_idx
  on public.tests (user_id, started_at desc);
create index if not exists tests_prescription_idx
  on public.tests (prescription_id) where prescription_id is not null;

-- ---------------------------------------------------------------------------
-- test_events — the immutable raw archive. One blob per test.
-- ---------------------------------------------------------------------------
-- Stored as a single JSONB document rather than one row per keystroke: ~400
-- events/test would mean ~1.5M rows/year, making every dashboard query a scan
-- over millions of rows. This blob is archival — it is never queried directly,
-- only read wholesale when recomputing rollups.
create table if not exists public.test_events (
  test_id     uuid primary key references public.tests(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  schema_ver  smallint not null default 1,
  events      jsonb not null,                    -- KeyEvent[] (see ARCHITECTURE.md §3.1)
  event_count integer not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- key_stats / bigram_stats — per-test rollups, written at sync time
-- ---------------------------------------------------------------------------
-- Cross-session analysis aggregates these (a few thousand rows) instead of the
-- raw blobs. analysis_version lets us detect and recompute stale rollups.
create table if not exists public.key_stats (
  test_id          uuid not null references public.tests(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  key              text not null,
  n                integer not null,
  errors           integer not null,
  latency_p50      integer not null,             -- ms, median (robust — see §5.3)
  latency_p90      integer,
  analysis_version smallint not null default 1,
  primary key (test_id, key)
);

create index if not exists key_stats_user_key_idx
  on public.key_stats (user_id, key);

create table if not exists public.bigram_stats (
  test_id          uuid not null references public.tests(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  bigram           text not null,                -- 2 chars, e.g. 'th'
  n                integer not null,
  errors           integer not null,
  latency_p50      integer not null,
  same_finger      boolean not null default false,
  analysis_version smallint not null default 1,
  primary key (test_id, bigram)
);

create index if not exists bigram_stats_user_bigram_idx
  on public.bigram_stats (user_id, bigram);

-- ---------------------------------------------------------------------------
-- snapshots — periodic metric profile for longitudinal tracking
-- ---------------------------------------------------------------------------
create table if not exists public.snapshots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  window_start  timestamptz not null,
  window_end    timestamptz not null,
  tests_in_window integer not null,
  metrics       jsonb not null,                  -- full computed profile
  created_at    timestamptz not null default now()
);

create index if not exists snapshots_user_window_idx
  on public.snapshots (user_id, window_end desc);

-- ---------------------------------------------------------------------------
-- reports — LLM diagnoses. Audit trail: keep model + prompt version.
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  window_start   timestamptz not null,
  window_end     timestamptz not null,
  findings       jsonb not null,                 -- structured; each carries metric + n
  prose          text,
  model          text not null,
  prompt_version text not null,
  input_profile  jsonb not null,                 -- exact numbers sent to the model
  created_at     timestamptz not null default now()
);

create index if not exists reports_user_created_idx
  on public.reports (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- prescriptions — the closed loop (ARCHITECTURE.md §7)
-- ---------------------------------------------------------------------------
-- baseline MUST be captured at prescription time; it cannot be reconstructed later.
create table if not exists public.prescriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  report_id     uuid references public.reports(id) on delete set null,

  target_type   text not null,                   -- 'bigram' | 'key' | 'finger' | 'sfb' | 'class'
  targets       text[] not null,
  drill_config  jsonb not null,                  -- word count, ratio, corpus …

  baseline      jsonb not null,                  -- metrics at time of prescription
  outcome       jsonb,                           -- metrics after completion
  verdict       text,                            -- 'resolved'|'improved'|'no-change'|'regressed'

  status        text not null default 'active',  -- 'active' | 'completed' | 'abandoned'
  drills_target integer not null default 5,
  drills_done   integer not null default 0,

  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index if not exists prescriptions_user_status_idx
  on public.prescriptions (user_id, status);

alter table public.tests
  drop constraint if exists tests_prescription_id_fkey;
alter table public.tests
  add constraint tests_prescription_id_fkey
  foreign key (prescription_id) references public.prescriptions(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Row Level Security — every table is user-scoped
-- ---------------------------------------------------------------------------
alter table public.tests         enable row level security;
alter table public.test_events   enable row level security;
alter table public.key_stats     enable row level security;
alter table public.bigram_stats  enable row level security;
alter table public.snapshots     enable row level security;
alter table public.reports       enable row level security;
alter table public.prescriptions enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'tests','test_events','key_stats','bigram_stats',
    'snapshots','reports','prescriptions'
  ] loop
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = (select auth.uid()))
         with check (user_id = (select auth.uid()))',
      t || '_owner', t
    );
  end loop;
end $$;

-- test_events is append-only: revoke UPDATE from clients entirely.
revoke update on public.test_events from authenticated;
