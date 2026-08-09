-- Make punctuation/numbers queryable on tests.
--
-- TestConfig carries both, but 0001 only persisted them inside the raw
-- test_events context, so they could not be filtered or grouped on. These modes
-- change the character distribution substantially — mixing a punctuation run
-- into a plain-words trend compares different workloads and makes the trend
-- line mean less than it appears to.
--
-- Existing rows default to false, which matches the app's own default config.
-- No backfill from raw events is attempted: the flags were never recorded in a
-- recoverable form for those rows, and silently inferring them would be worse
-- than an honest default.

alter table public.tests
  add column if not exists punctuation boolean not null default false,
  add column if not exists numbers boolean not null default false;
