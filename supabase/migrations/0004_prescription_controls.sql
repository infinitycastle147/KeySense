-- Hold-out controls on prescriptions — the regression-to-the-mean correction.
--
-- A prescription's targets are selected as the extremes of a noisy ranking, so
-- re-measuring them after treatment shows improvement whether or not the drills
-- did anything. Without a control, the closed loop of ARCHITECTURE.md §7 cannot
-- distinguish a working diagnosis from that artifact, which is the one job it
-- exists to do.
--
-- `control` holds the untreated hold-out set: same target type, ranked
-- immediately below the treated targets, never drilled and never shown. Shape:
--
--   {
--     "targets":  ["ol", "ju"],
--     "baseline": { "errorRate": 0.071, "latencyP50": 204, "n": 118 },
--     "outcome":  { "errorRate": 0.058, "latencyP50": 197, "n": 96 } | null
--   }
--
-- Like `baseline`, `control.baseline` is captured at creation and never
-- updated — a control measured after the fact is not a control. Only
-- `control.outcome` is written later, by the same update that writes `outcome`.
--
-- Nullable with no default and no backfill: prescriptions created before this
-- migration genuinely have no control and no way to reconstruct one. They
-- evaluate to an uncontrolled pre/post verdict, which src/lib/prescriptions/
-- evaluate.ts reports as `controlled: false` rather than silently mixing in
-- with controlled results.

alter table public.prescriptions
  add column if not exists control jsonb;

comment on column public.prescriptions.control is
  'Untreated hold-out set: {targets, baseline, outcome}. Never drilled, never shown. Null = uncontrolled prescription.';
