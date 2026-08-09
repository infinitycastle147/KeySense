---
name: add-metric
description: Add or change a metric in the KeySense analysis layer. Use when adding a diagnostic measurement (bigram latency, SFB detection, fatigue curve, confusion matrix, error taxonomy), changing how an existing metric is computed, or when a metric produces suspicious/noisy output. Covers the robust-statistics and minimum-n rules that findings depend on.
---

# Adding an analysis metric

Metrics are the substrate of every diagnosis. A metric that looks correct on clean data
and produces nonsense on small samples is the exact failure mode this product cannot
afford — a wrong finding destroys trust in the whole report.

## Rules (from ARCHITECTURE.md §5.3)

1. **Robust statistics only.** Median, MAD, trimmed mean. Never a raw mean — typing
   latency distributions have brutal outliers (thinking pauses, interruptions).
2. **Discard inter-key intervals > 1000ms** before computing anything. That is not typing.
3. **Minimum n ≥ 30** before a metric may produce a *finding*. Below that it may still be
   displayed, but flagged as provisional.
4. **Wilson score intervals** for error rates, never naive `errors/n`. A 2/3 error rate on
   n=3 must not outrank 40/400 on n=400.
5. **Baseline is the user's own history**, never a population norm.

## Procedure

### 1. Write it as a pure function

Everything in `src/lib/analysis/` takes data and returns data. No I/O, no React, no
Supabase — this is what makes metrics testable and retroactively recomputable.

```ts
// src/lib/analysis/<metric-name>.ts
export function computeX(events: KeyEvent[], opts: XOpts): XResult { … }
```

### 2. Use the shared primitives

Do not hand-roll statistics. Reuse `src/lib/analysis/stats.ts`:
`median`, `trimmedMean`, `mad`, `wilsonInterval`, `filterOutliers`.

If a primitive you need is missing, add it there with its own tests rather than inlining
the maths in a metric.

### 3. Decide the storage tier

| If the metric is… | Store it… |
| --- | --- |
| per-key or per-bigram, aggregated across tests | a column in `key_stats` / `bigram_stats` |
| whole-test scalar | a column on `tests` |
| composite / windowed | computed at read time into `snapshots.metrics` |

Adding a column to a rollup table means **bumping `analysis_version`** and backfilling
from `test_events`. Never edit raw events.

### 4. Test the failure paths first

This is the part that matters. Unit tests must cover:

- **n below threshold** — returns provisional/null, does not emit a finding
- **all-outlier input** — every interval > 1000ms; must not divide by zero
- **single sample**
- **perfect input** — zero errors; interval maths must not produce NaN
- **empty input**

A metric with only happy-path tests is not done.

### 5. Wire it into the profile

If it should influence diagnosis, add it to the metric profile builder that feeds the LLM.
Keep the profile compact — top-N only, never raw events. Every number the model receives
must arrive with its `n` so the report can cite evidence.

## Checklist

- [ ] Pure function in `src/lib/analysis/`
- [ ] Uses `stats.ts` primitives, not hand-rolled maths
- [ ] Outliers filtered before computation
- [ ] Returns `n` alongside every value
- [ ] Small-n / outlier / empty tests written
- [ ] `analysis_version` bumped if a stored column changed
- [ ] Backfill path considered for existing tests
- [ ] `npm run typecheck && npm test` clean
