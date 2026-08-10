-- Store latency distributions in the rollups, not just their medians.
--
-- key_stats and bigram_stats keep one median per key per test, so pooling a
-- window means averaging medians. That is not the median of the pooled sample,
-- and no weighting makes it one: a bigram appearing twice in a test contributes
-- a "median" that is a coin flip between two observations, and that coin flip
-- then carries full per-observation weight alongside a median drawn from two
-- hundred.
--
-- A fixed-bin histogram (20ms bins across 0..1000ms, 50 bins — see
-- src/lib/analysis/histogram.ts) fixes it. Fixed bins rather than an adaptive
-- sketch because two histograms then pool by summing counts, which is exactly
-- the operation the rollup tier exists to make cheap.
--
-- Nullable, no backfill from these columns alone. Rows written before this can
-- be recomputed from test_events whenever wanted — which is the entire point of
-- ARCHITECTURE.md §2, and the first time that guarantee has been cashed in.
-- Until then those rows fall back to the averaged-median path.

alter table public.key_stats
  add column if not exists latency_hist jsonb;

alter table public.bigram_stats
  add column if not exists latency_hist jsonb;

comment on column public.key_stats.latency_hist is
  'number[] — 20ms-bin counts of inter-key intervals. Null pre-0007; recomputable from test_events.';
comment on column public.bigram_stats.latency_hist is
  'number[] — 20ms-bin counts of inter-key intervals. Null pre-0007; recomputable from test_events.';
