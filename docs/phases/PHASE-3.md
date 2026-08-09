# Phase 3 — Statistics engine + dashboard

**Goal:** every number the product will ever claim, computed deterministically and
correctly. This is the substrate the AI narrates in Phase 4 — if it is wrong, everything
downstream is wrong.

**Depends on:** `src/lib/types.ts` only. Can be built before Phase 1 finishes, using
hand-built `KeyEvent[]` fixtures.

Read the **`add-metric` skill** before starting.

---

## Part A — the pure analysis library (`src/lib/analysis/`)

Every function takes data and returns data. **No I/O, no React, no Supabase.** That is
what makes metrics testable and retroactively recomputable.

### 1. `stats.ts` — primitives

`median`, `trimmedMean`, `mad`, `percentile`, `wilsonInterval`, `filterOutliers`,
`coefficientOfVariation`.

Non-negotiable, from `docs/ARCHITECTURE.md §5.3`:

- **Medians and trimmed means only.** Never a raw mean — latency distributions have brutal
  outliers (thinking pauses, interruptions).
- **Discard inter-key intervals > 1000ms** before computing anything. Export this as
  `OUTLIER_MS = 1000`.
- **Wilson score intervals** for every error rate. A 2/3 error rate on n=3 must never
  outrank 40/400 on n=400.
- Export `MIN_FINDING_N = 30`. Below it, `Measured.reportable` is `false`.

### 2. `layout.ts` — keyboard geometry

Parse `/data/layouts/<name>.json` (`{ keys: { row1..row5: [[lower, upper], ...] } }`).

Derive, do not hardcode: `charToKey`, `keyToFinger` (standard touch-typing assignment by
column), `keyToRow`, `areAdjacent(a, b)`, `isSameFinger(a, b)`.

### 3. Metrics — one file each

| File | Produces |
| --- | --- |
| `keys.ts` | `KeyStat[]` — n, errors, Wilson CI, p50/p90 latency |
| `bigrams.ts` | `BigramStat[]` — the **highest-value metric**; weakness lives in transitions |
| `fingers.ts` | `FingerStat[]` — `relativeLatency` vs the user's own median |
| `errors.ts` | `ErrorTaxonomy` + `ConfusionMatrix` |
| `rhythm.ts` | IKI variance, burst/stall detection |
| `fatigue.ts` | WPM per time bucket across the test |
| `corrections.ts` | backspace rate, mean chars-to-notice |
| `profile.ts` | assembles `MetricProfile` over a window of tests |

**Error taxonomy** must distinguish substitution / insertion / omission / **transposition**.
Transpositions specifically indicate hand-alternation timing problems and are highly
actionable — detect them by looking for `ab` typed as `ba` across adjacent events.

### 4. Aggregation across tests

A single 30s test contains 1–3 occurrences of any bigram. That is noise.
`profile.ts` aggregates over a **window of 20–50 tests**. Weighted merge of per-test
rollups: sum `n` and `errors`, and combine medians by pooling the underlying samples where
available, otherwise n-weighted. Document whichever you choose.

### 5. Tests — the part that matters

For every metric: **n below threshold**, **all-outlier input**, **single sample**,
**perfect input** (zero errors — no NaN), **empty input**. A metric with only happy-path
tests is not done.

---

## Part B — dashboard + the trace

### 6. The trace — `src/components/results/Trace.tsx`

**The signature element** (`docs/DESIGN.md §5`). On the results screen, the test replays as
a cardiograph line drawn left to right at the speed it was actually typed.

- Inter-key intervals become the waveform: steady rhythm → even peaks, hesitation → flat
  run, error → `--flag` spike, correction → spike doubles back.
- Inline SVG (no chart library), `stroke-dasharray` draw-on animation.
- **Click to skip** to the completed trace. Never trap the user in an animation.
- `prefers-reduced-motion` → render completed immediately.

### 7. Dashboard — `src/app/dashboard/page.tsx`

**Stacked horizontal strips, not a card grid** (`docs/DESIGN.md §4`). Each strip is one
metric over time on a shared time axis, so correlations read across rows.

Each strip: label (`.label-type`), sparkline (inline SVG), current value in
`--font-display`, delta arrow, and an **evidence tag** (`n=214`).

Also: `KeyHeatmap.tsx` (per-key latency/error over the layout) and `BigramTable.tsx`
(worst transitions, sortable, with CI shown).

**Every claim shows its evidence.** A number without an `n` is not shippable.

---

## Out of scope

The typing engine, sync, AI calls, drills.

## Acceptance

- [ ] All analysis functions pure, no imports from React/Supabase/`next`
- [ ] Outlier filter and `MIN_FINDING_N` applied consistently
- [ ] Every error rate carries a Wilson interval
- [ ] Small-n / outlier / empty tests written for every metric
- [ ] Trace renders from real events, skippable, reduced-motion safe
- [ ] Dashboard strips render with evidence tags
- [ ] `npm run typecheck && npm run lint && npm test && npm run build` all clean
