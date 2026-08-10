-- Archive the prompt text alongside the keystrokes.
--
-- test_events was not fully replayable without it. KeyEvent.expected only
-- covers positions the typist actually reached, so a word left incomplete
-- loses its tail entirely — only a `missed` count survives, never which
-- characters were skipped.
--
-- That gap blocked the one thing the raw archive exists for. Sequence
-- alignment (src/lib/analysis/align.ts) is what distinguishes a dropped
-- character from a run of fabricated substitutions, and it needs the whole
-- expected string, not the prefix the typist happened to reach.
--
-- Nullable, no backfill: rows written before this column genuinely do not
-- carry the prompt, and it cannot be reconstructed from the events. Those
-- tests fall back to positional classification, flagged by
-- TestAnalysis.alignedClassification so a mixed window is visible rather than
-- silently pooled.
--
-- Additive only. The append-only guarantee of 0002 is untouched: this column
-- is written once, by the same insert that writes `events`.

alter table public.test_events
  add column if not exists words jsonb;

comment on column public.test_events.words is
  'string[] — the word list the user was asked to type. Null for tests archived before 0005.';
