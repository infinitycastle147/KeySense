# KeySense — Measurement Audit

> An adversarial review of KeySense as a *measurement system*: what the instrument can
> see, what it collects and discards, which reported numbers mean something other than
> what they claim, and what is missing that matters most.
>
> Scope: docs, schema, typing engine, every module in `src/lib/analysis/`, and the
> stats→LLM boundary. Reviewed against `docs/ARCHITECTURE.md` and `CLAUDE.md`.

> **Status: all eighteen findings have been addressed.** The document is kept in its
> original diagnostic form rather than rewritten in the past tense — the reasoning behind
> each item is the part worth preserving, and a fix is easier to evaluate against the
> argument that motivated it. Each entry in §5 now names where it landed.
>
> Migrations `0004`–`0007` are applied. Event schema is at version 2.

---

## Verdict first

KeySense's stated thesis is *"the typing test is a sensor; the product is the pipeline."*
The pipeline is well built. But interrogated as a measurement system, it has one
structural weakness that outranks everything else:

> **The system selects extremes, then re-measures them, and calls the difference
> improvement. Nothing in the codebase controls for that. It is currently unable to
> distinguish a working diagnosis from regression to the mean.**

`rankByBadness` (`src/lib/analysis/profile.ts:305`) takes ~500 bigrams, filters
`n >= 30`, and sorts by raw `errorRate` descending. That is a maximum-of-noisy-estimators
selection with no shrinkage and no multiple-comparison control. The winners of that sort
are, on average, the bigrams whose *estimates* were unluckiest — not the ones that are
worst. Then `prescriptions.baseline` freezes that inflated value (correctly, per
ARCHITECTURE §7), the user drills, and `evaluate.ts` compares to a fresh measurement. The
fresh measurement regresses toward truth **whether or not the drill did anything**. So the
closed loop — the single feature that makes this a diagnostic instead of a horoscope — is
biased toward reporting `improved` / `resolved`.

ARCHITECTURE §7 says the loop "gives honest feedback on whether the analysis logic is any
good." As built, it cannot. That is the headline.

---

## §1 — The sensor's ceiling: what cannot be recovered later

This matters most because ARCHITECTURE §9 states that data cannot be collected
retroactively.

### 1.1 `keydown` only — no `keyup` anywhere in the repo

`src/lib/engine/engine.ts:205` is the sole capture path. Consequence: every latency in the
entire product is a single composite number, the inter-key interval. It cannot be
decomposed into:

- **Dwell time** (key down → up) — how long keys are held. A distinct motor signal.
- **Flight time** (previous key up → next key down) — actual transit.
- **Rollover / overlap** (next key goes down *before* the previous comes up → negative
  flight). The clearest technique marker separating fluent typists from fast
  hunt-and-peck, and it is completely invisible.

Two typists with identical 180ms `ol` intervals — one holding keys 140ms with 40ms
transit, the other holding 40ms with 140ms transit — have opposite problems and need
opposite drills. Today they are the same row in the data.

Adding a `"keyup"` event kind is append-only and cheap; `EVENT_SCHEMA_VERSION`
(`src/lib/types.ts:14`) exists for exactly this. Every month of delay is a month of data
that can never be re-analysed.

### 1.2 Context covariates recorded but unused

`deviceId` and `startedAt` are stored on every test and read by **zero** analysis code. A
session on a laptop chiclet keyboard and one on an external mechanical are pooled into the
same personal baseline — which quietly invalidates the "baseline against self"
methodology that ARCHITECTURE §5.3 rests on. Same for time-of-day, and for **session
index** (the nth test in a sitting).

Fatigue is measured **within** a test (`src/lib/analysis/fatigue.ts`) and never **across**
a session — which is the fatigue people actually feel.

### 1.3 Test difficulty is not held constant

`src/lib/db/sync.ts:77` comments that punctuation/numbers flags are "queryable so trends
can exclude mismatched workloads" — and then `buildMetricProfile` pools every test in the
window regardless. `trend.wpmDelta` therefore conflates "you got better" with "you
happened to run fewer punctuation tests this week."

---

## §2 — Signal already collected and thrown on the floor

These are free. The data exists; nothing reads it.

| Signal | Where it lives | Status |
| --- | --- | --- |
| `KeyEvent.mods` | captured on every event, `engine.ts:69` | **read by zero analysis modules.** Shift/capitals cost is unmeasured. |
| `computeRhythm` | `analysis/rhythm.ts`, implemented + tested | **never called.** Not in `TestAnalysis`, not in `MetricProfile`, never reaches the LLM. |
| `layout.areAdjacent` | `analysis/layout.ts:140`, implemented + tested | **never called.** |
| `layout.keyToRow` | `analysis/layout.ts:136` | **never called.** |
| `snapshots` table | `supabase/migrations/0001_init.sql:102`, with RLS and index | **never written to.** No longitudinal tracking exists. |

The adjacency gap is the most damaging. ARCHITECTURE §5.4 promises the confusion matrix
"separates adjacent-key slips from finger confusion from sequencing errors — different
root causes, different drills." `computeConfusionMatrix` (`analysis/errors.ts:102`) does
none of that; it emits raw intended→typed counts. The root-cause separation that justifies
the metric's existence is unimplemented, and the geometry function needed to implement it
is sitting unused in the same directory.

Also missing from the mechanism vocabulary: **SFBs are isolated and nothing else.** No
hand-alternation ratio, no same-hand run length, no **scissors** (adjacent fingers,
non-adjacent rows), no **lateral stretches** (index-column reaches), no **redirects**
(three same-hand keys reversing direction). Those are the actual causal vocabulary of "why
this transition is slow." One of six ships.

---

## §3 — Where the reported numbers are confounded

Each of these produces a plausible-looking number that means something other than what it
claims.

### 3.1 Per-finger latency is confounded by the preceding key — and it is the flagship claim

`analysis/fingers.ts:51` attributes `t[i] - t[i-1]` to the finger of key *i*. That interval
is a property of the **transition** `j→i`, not of finger *i*. "Right pinky is 2.1× slower
than your median" — the README's headline example — may in truth be "the keys that precede
pinky keys are far away from the pinky." Marginal attribution cannot separate these.

**Fix:** an additive/residual model — fit `interval ≈ from_finger + to_finger + travel`
and report the *residual* per finger.

### 3.2 Per-key latency is the same error one level down

`analysis/keys.ts:44` — "latency of key K" is really "arrival time at K from an arbitrary
predecessor," so worst-key rankings are largely a ranking of which keys tend to follow
awkward keys.

### 3.3 Positional comparison with no alignment corrupts the confusion matrix

`engine.ts:131` compares the typed char to `word[cIdx]` positionally. Type `helo` for
`hello`: the `o` is scored as *substitution `l`→`o`*, and in longer words every subsequent
character cascades into fabricated substitution pairs. One dropped character manufactures a
run of fake "confusions" that flow into `topConfusions` and into the model's prompt.

Mid-word omissions are also structurally uncountable — `taxonomy.omission` only counts
`missed` from early word commits (`analysis/errors.ts:87`).

**Fix:** edit-distance alignment (Needleman–Wunsch over expected vs. typed) before
classification.

### 3.4 Latency has no uncertainty; error rate does

Every error rate gets a Wilson interval. Every median latency gets nothing — no CI, no
significance test. So `relativeLatency: 2.1` and `relativeLatency: 1.15` look equally solid
to the LLM, and `worstBigrams` tie-breaks on a point estimate with unknown spread.
Asymmetric rigor: the careful path guards error rates while the loose path drives the
latency findings.

### 3.5 Pooled percentiles are averages of percentiles

`weightedAverage` over per-test p50s (`analysis/profile.ts:126`) is honestly documented as
a judgement call, but the consequence is real: a bigram with n=2 in a given test
contributes a "median" that is a coin flip.

**Fix:** store a compact interval histogram (or t-digest) per key/bigram in the rollup
tables instead of just `latency_p50`/`latency_p90`, making true pooled percentiles
recoverable at the rollup tier without touching raw blobs.

### 3.6 Data quality is never measured

Intervals >1000ms are silently dropped (`analysis/stats.ts:18`). The *discard rate itself*
is a measurement — a session where 30% of intervals were outliers is a distracted session,
and its WPM should not carry equal weight in a trend. Today it is indistinguishable from a
clean one. Nothing flags tab-aways, long pauses, or abandoned-and-restarted tests.

### 3.7 An invariant the docs say must be measured is not measured

`CLAUDE.md` invariant 3: "Budget: <16ms keydown to caret paint. If a change touches the
input path, measure it." Nothing measures it. There is no instrumentation of the thing the
doc explicitly says must not be assumed.

---

## §4 — The most important missing measurement

**The system never measures whether its own diagnoses are correct.**

All the ingredients exist — `verdict` is computed and persisted per prescription — but no
aggregate reads them. There is no "of my last 20 prescriptions: 6 resolved, 9 no-change, 5
regressed." And even with that dashboard, §1's regression-to-the-mean problem would make
the number optimistically biased and unusable.

Two instruments make this real, and neither is expensive.

### 4.1 A control group of one

When prescribing the top-k weak targets, silently designate the *next* k weak targets as a
hold-out — flagged, never drilled, never mentioned. At outcome time, compare Δ(targeted)
vs Δ(hold-out) over the same window.

That difference-in-differences is the only honest efficacy number available in a
single-user product, and it strips out regression to the mean, general improvement, and
time-of-day drift in one move. It needs one boolean column and changes nothing the user
sees.

### 4.2 Make the diagnosis falsifiable

A finding currently says what is wrong. It should also commit to a forecast: *"`ol` and
`ju` cost you ~1.4 WPM; drilling them should return ~0.9."* At outcome time, score
prediction against reality. That is what turns a narrator into a diagnostician — what
ARCHITECTURE §7 reaches for but stops short of.

### 4.3 The README's central claim is not computed anywhere

*"`ol` and `ju` are costing you four words per minute"* — there is **no time-loss
attribution model in the repo.** Nothing multiplies (per-bigram latency − personal floor)
× corpus frequency to convert a weakness into WPM.

`rankByBadness` sorts by error rate, which is **not** impact: a 9% error rate on a bigram
appearing 0.2% of the time is worth less than a 40ms excess on one appearing 3% of the
time. Without an impact model, the prioritisation that decides where the user spends their
practice hours is picking the wrong targets — and the headline promise is unbacked.

---

## §5 — Ranked backlog

### P0 — validity. The system may currently be confirming itself.

1. ~~Hold-out control targets + difference-in-differences.~~ **Done** — `prescriptions/control.ts`, `evaluate.ts` (`lift`, `controlled`), `prescriptions/scorecard.ts`, migration `0004`.
2. ~~Shrinkage + FDR before ranking.~~ **Done** — `analysis/ranking.ts`; `rankByBadness` now delegates to it.
   *Follow-up (2026-08-10):* applying the FDR gate to every consumer was too
   blunt. On a window where nothing cleared it, the dashboard rendered an empty
   keyboard and the model received a profile with no bigrams or keys at all —
   then improvised findings from `geometry.shapes` and `timeLoss`, producing
   targets no prescription could baseline. The gate is now *reported* rather
   than applied: `MetricProfile` carries `bigramStats`/`keyStats` with a
   `significant` flag per row, and the discovery-only lists remain for the
   prescription flow. See `analysis/profile.ts` (`rankForDisplay`).
3. ~~Edit-distance alignment before error classification.~~ **Done** — `analysis/align.ts`, `errors.ts` (`*Aligned`), `test_events.words` via migration `0005`.
4. ~~Bootstrap CIs on median latency.~~ **Done** — `stats.ts` (`bootstrapMedianCI`, deterministically seeded), carried on `KeyStat`/`BigramStat`/`FingerStat`.
5. ~~Confound-adjusted finger latency.~~ **Done** — `analysis/residual.ts`; `relativeAdjusted` is what the prompt now instructs the model to cite.

### P1 — capture. Cost of delay is highest; cannot be backfilled.

6. ~~`keyup` capture.~~ **Done** — `KeyUpEvent`, `engine.handleKeyUp`, `analysis/dynamics.ts`, migration `0006`, schema version 2.
7. ~~Per-test data quality.~~ **Done** — `analysis/quality.ts`, pooled into the profile and sent to the model.
8. ~~Session, time-of-day, device dimensions.~~ **Done** — `analysis/sessions.ts` (warm-up curve, device divergence).
9. ~~Interval histograms in the rollups.~~ **Done** — `analysis/histogram.ts`, migration `0007`; pooled percentiles are now exact, with a per-row fallback for pre-0007 rows.

### P2 — promised in the docs, computable from data already held.

10. ~~Character-class metrics.~~ **Done** — `analysis/charclass.ts`; `KeyEvent.mods` finally has a reader.
11. ~~Root-cause classification of confusions.~~ **Done** — `errors.ts` (`classifyConfusion`), plus `keyToPosition` on `LayoutIndex`.
12. ~~Rhythm wired through.~~ **Done** — reaches the dashboard tier and the prompt as burst/stall *rates*.
13. ~~Bigram geometry.~~ **Done** — `analysis/geometry.ts`.
14. ~~Config-matched trends.~~ **Done** — `configMatched` on the profile; the prompt is told not to read `trend` as skill when false.

### P3 — product.

15. ~~Time-loss attribution.~~ **Done** — `analysis/timeloss.ts`; `wpmCost` is now in the profile and the prompt prefers it to error rate.
16. ~~Learning curves and snapshots.~~ **Done** — `analysis/learning.ts` (slope, plateau) and `db/snapshots.ts`, written on report generation.
17. ~~Input-latency instrumentation.~~ **Done** — `engine/latency-probe.ts`, off by default, rAF-based, fixed ring buffer.
18. ~~Adherence and usage.~~ **Done** — `analysis/usage.ts`; adherence is what separates a failed diagnosis from an untaken prescription.

---

## What is already right

Worth stating plainly, because the list above is one-sided by design.

The statistical hygiene that **is** present — Wilson intervals, MAD, the 1000ms cut,
`n >= 30` gating, the hallucination guard in `src/lib/ai/parse.ts` — is better than most
shipped analytics products.

And the immutable-event-log decision is what makes P0 items 1–5 fixable at all:
`analysis_version` can be bumped and history recomputed. The gaps above are in what is
*derived*, not in what is *kept* — with the single exception of `keyup`, the only item on
this list that gets permanently more expensive every day it waits.
