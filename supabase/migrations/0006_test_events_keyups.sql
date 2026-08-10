-- Archive key releases (event schema version 2).
--
-- Until now the log recorded presses only, which collapses two independent
-- quantities into one:
--
--   dwell  — how long a key is held (keydown to its own keyup)
--   flight — how long the hand is in transit (keyup to the next keydown)
--
-- Their sum is the inter-key interval every existing metric is built on. Two
-- typists at an identical 180ms interval — one holding keys 140ms, the other
-- travelling 140ms — have opposite problems and opposite prescriptions, and
-- were previously indistinguishable. Negative flight (a key pressed before the
-- previous one is released) is rollover, the sharpest available marker of
-- fluency as distinct from raw speed, and was likewise unobservable.
--
-- Stored in a column of its own rather than merged into `events`: a release has
-- no expected character, no correctness, and no caret position, so it would be
-- mostly null padding inside a KeyEvent. More importantly, every latency metric
-- in src/lib/analysis/ walks consecutive entries of `events` and takes
-- t[i] - t[i-1]. Interleaving releases would silently corrupt every one of
-- those intervals, with no failing test to announce it.
--
-- Nullable, no backfill. Releases were never recorded for existing rows and
-- cannot be inferred. Those tests report no dynamics at all rather than an
-- estimate — the estimate would be of precisely the quantity in question.

alter table public.test_events
  add column if not exists keyups jsonb;

comment on column public.test_events.keyups is
  'KeyUpEvent[] — {t, key} per release. Null for schema_ver 1 archives.';
