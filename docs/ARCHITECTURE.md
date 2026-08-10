# KeySense — Architecture

> A typing trainer that diagnoses *why* you're slow, prescribes targeted practice,
> and measures whether the prescription worked.

---

## 1. Product thesis

Monkeytype is a **measurement** tool. KeySense is a **diagnostic** tool that contains a
measurement tool.

That inversion drives every decision in this document. The typing test is a *sensor*.
The product is the data pipeline behind it.

The three things KeySense does that a typing test does not:

1. **Records every keystroke** with full context (what was expected, what was typed, when).
2. **Diagnoses** — deterministic statistics identify weaknesses, an LLM narrates them
   into a concise report.
3. **Closes the loop** — prescribes drills targeting those weaknesses, then measures
   whether the weakness actually improved.

### Why not fork monkeytype

Evaluated and rejected. Monkeytype is GPL-3.0, ~100k LOC of vanilla TypeScript with heavy
jQuery, a bespoke page/controller structure, and self-hosting requires MongoDB + Firebase
Auth + Redis.

The decisive reason is not the stack, though: **monkeytype does not persist the data
KeySense needs.** It computes aggregates (WPM, accuracy, consistency, per-second chart
data) and stores those. Keystroke timings exist only transiently in memory. Its
`weak-spot.ts` is a per-character exponential moving average, in-memory only, reset on
page reload — no bigrams, no persistence, no history.

So a new capture layer and data model were required regardless. Building fresh was
cheaper than grafting one into an unfamiliar 100k-LOC codebase.

**What we did take** (see `public/data/ATTRIBUTION.md`):

- Word lists, quote sets, and keyboard layout definitions — pure data, hundreds of hours
  of curation.
- Because these are GPL-3.0, **KeySense is GPL-3.0**.
- No monkeytype source code is used. The reference clone is worth re-reading for input
  edge cases: `frontend/src/ts/test/` — backspace/ctrl-backspace semantics, extra vs.
  missed characters, IME composition, dead keys.

---

## 2. The foundational principle

> **The raw event log is immutable and append-only. Every metric is a derived view that
> can be recomputed from it.**

Analysis algorithms will improve substantially over the first year. If only aggregates are
stored, historical data can never be re-analysed. If raw events are stored, v3 analysis can
be re-run over data captured on day one.

Consequences:
- Never mutate `test_events`.
- Every derived table carries an `analysis_version`. Bumping it triggers recomputation.
- Storage is cheap enough that this costs nothing (§4.3).

---

## 3. Capture layer

### 3.1 The event record

One record per `keydown` that produces or deletes a character:

```ts
type KeyEvent = {
  t: number;          // ms from test start — from event.timeStamp, NOT Date.now()
  key: string;        // the character actually produced
  expected: string;   // the character that should have been produced
  ok: boolean;
  wordIdx: number;
  charIdx: number;
  prev: string | null; // preceding expected char — bigram context
  mods: string[];      // ["shift"], ["ctrl"] …
  kind: "char" | "backspace" | "word-delete";
};
```

**Use `event.timeStamp`, not `performance.now()` inside the handler.** `timeStamp` is
stamped by the browser at input time; reading the clock inside a React handler measures
when your JS ran, which is polluted by main-thread jank and will silently corrupt latency
data.

Hand / finger / row / physical-adjacency are **not stored** — they are derived at analysis
time from `public/data/layouts/*.json` keyed by the test's `layout` field. Storing them
would bake in a layout assumption and bloat rows.

### 3.2 Input latency is sacred

If typing feels laggy, the tool is unpleasant, it goes unused, and no data is collected.
Everything downstream depends on the test feeling good.

- **Do not re-render the word list on every keystroke.** Keep typing state in a `useRef`
  or reducer; re-render only the active word and the caret.
- Append events to a plain array in a ref. No React state per keystroke.
- Persist to IndexedDB once, on test completion — never mid-test.
- Budget: **< 16ms** from keydown to caret paint. Measure it; don't assume it.

### 3.3 Offline-first

Tests must work with no network.

1. On completion, write the test + events to IndexedDB with a **client-generated UUID**.
2. A background sync worker pushes unsynced rows to Supabase.
3. Sync is an **idempotent upsert** keyed on that UUID.

Because the data is append-only and client-keyed, there is no conflict resolution
problem — a device can be offline for a week and sync cleanly. This property is worth
preserving deliberately; do not introduce mutable per-test state that two devices could
both edit.

---

## 4. Data model

### 4.1 Tables

| Table | Contents | Purpose |
| --- | --- | --- |
| `tests` | metadata + headline stats | history list, dashboard |
| `test_events` | one compact blob per test | immutable raw archive |
| `key_stats` | per-test, per-key rollup | cheap cross-session aggregation |
| `bigram_stats` | per-test, per-bigram rollup | cheap cross-session aggregation |
| `snapshots` | periodic metric profile | longitudinal tracking |
| `reports` | LLM findings + prompt version | audit trail |
| `prescriptions` | targets, baseline, outcome | the closed loop |

### 4.2 Why the hybrid (raw blob + per-test rollups)

Two rejected extremes:

- **Raw rows only** (one row per keystroke): ~1.5M rows/year. Postgres handles this fine,
  but every dashboard query becomes a full scan over millions of rows.
- **Aggregates only**: fast, but violates §2 — nothing can be re-derived.

The hybrid stores raw as one compact blob per test (archival, never queried directly) and
*also* writes small per-test rollups at write time. Cross-session analysis then aggregates
a few thousand rollup rows instead of millions of raw ones, while the raw log remains
available for recomputation.

### 4.3 Volume

A 60-second test at 80 WPM is roughly 400 events, ~5 KB raw JSON (less delta-encoded).
At 10 tests/day that is **~20 MB/year**. Storage is a non-issue; store everything.

Supabase free tier is 500 MB. If it ever becomes tight, roll up and archive raw blobs
older than ~12 months to object storage — the rollups stay.

---

## 5. Analysis pipeline

### 5.1 The split: deterministic stats, LLM narration

**This is the decision that determines whether the diagnosis is credible or is a
horoscope.**

```
keystroke events
      ↓
[ deterministic stats engine ]   ← all numbers produced here
      ↓
compact metric profile (~1–2 KB of structured numbers)
      ↓
[ LLM ]                          ← interprets, prioritises, prescribes
      ↓
report prose + drill targets
```

Rules:

- **Never send raw keystroke logs to the model.** LLMs are poor at statistics, and it is
  slow and expensive.
- The LLM receives *only* pre-computed numbers — top-N problem bigrams, per-finger deltas
  against personal baseline, error taxonomy breakdown.
- The system prompt must state: **use only the numbers provided; never compute or invent
  a figure.**

If the model hallucinates a statistic once, trust in the entire report collapses. Pin the
numbers; let the model do the doctoring.

### 5.2 Two-tier cadence

| Tier | When | Cost | Contents |
| --- | --- | --- | --- |
| Per-test | immediately | free, deterministic | charts, raw numbers, no LLM |
| Rolling diagnosis | on demand or nightly | one LLM call | report over last 20–50 tests |

The second tier is not merely a cost optimisation — **it is a correctness requirement.**

A single 30-second test contains 1–3 occurrences of any given bigram. That is noise.
"You are weak on `th`" cannot be honestly claimed from one test. Weakness signal only
emerges across sessions.

### 5.3 Statistical rules

Two rules separate real diagnosis from noise generation:

**Minimum-n gating.** Do not report a weakness below **n ≥ 30** observations. Use
**Wilson score intervals** for error-rate confidence so small samples cannot produce
dramatic false findings. A finding must carry its `n` into the report.

**Robust statistics.** Use medians, MAD, and trimmed means — never raw means. Typing
latency distributions have brutal outliers: thinking pauses, distractions, someone walking
into the room. **Discard inter-key intervals > 1000 ms as "not typing."** Skipping this
step makes the data garbage.

**Baseline against self, never a population.** The finding is "your right pinky is slow
relative to your other fingers, and relative to you last month." That is what makes it
feel personal and medical.

### 5.4 Metrics that actually diagnose

Headline WPM and accuracy are useless for diagnosis. Signal lives in:

| Metric | Why it matters |
| --- | --- |
| **Per-bigram latency + error rate** | Highest-value metric. Weakness lives in *transitions*, not keys. |
| **Confusion matrix** (intended → typed) | Separates adjacent-key slips from finger confusion from sequencing errors — different root causes, different drills. |
| **Error taxonomy** (substitution / insertion / omission / **transposition**) | Transpositions specifically indicate hand-alternation timing problems. Highly actionable. |

> **Errors are classified by sequence alignment, not by position.** Comparing each
> keystroke to `word[charIdx]` is correct for the caret and wrong for diagnosis: one
> dropped character shifts every position after it, so `hello` typed as `helo` reads as a
> confusion of `l` with `o` that the typist never had — and in longer words the cascade
> manufactures a whole run of fabricated pairs, which then flow into `topConfusions` and
> into the model's prompt as if they were evidence. `src/lib/analysis/align.ts` aligns the
> typed string against the expected one and reports the gap as a gap. This is also the only
> way mid-word omissions become countable at all, since a character that is never typed
> produces no keydown.
>
> Alignment needs the prompt text, so `test_events.words` archives it (migration 0005).
> Tests captured before that column fall back to positional classification and are flagged
> with `TestAnalysis.alignedClassification: false` rather than silently pooled.
| **Same-finger bigrams (SFBs)** | Universal weak point; worth isolating explicitly. |
| **Finger / hand attribution** | Via layout map → "right pinky at 2.1× median latency." |
| **Rhythm** | Inter-key-interval variance; burst-then-stall patterns. |
| **Fatigue curve** | WPM/accuracy vs. position in test — degradation after 40s is a stamina finding, not a technique finding. |
| **Correction behaviour** | Backspace rate, and *time-to-notice* — caught at char 1 or char 5? |
| **Shift / capitals / punctuation / numbers** | Treated as a separate class. Usually disproportionately bad and completely invisible in aggregate stats. |

---

## 6. Practice generation

Two mechanisms, weighted opposite to intuition:

**Primary — deterministic drill synthesis.** Given weak bigrams, filter the dictionary
(`public/data/languages/`) for real words containing them, weight by frequency, assemble a
word list. Instant, free, deterministic, produces real English. Handles ~90% of cases
better than an LLM would.

**Secondary — LLM generation** for natural-sentence drills that emphasise target patterns
while staying readable. Used when deterministic selection produces awkward word salad.

`english_doubleletter.json`, `english_contractions.json`, and
`english_commonly_misspelled.json` are pre-built drill corpora for specific weakness
classes.

### The over-targeting trap

If every session drills only weak keys, general speed regresses and practice becomes
miserable. **Prescribe mixed sessions — ~70% targeted, ~30% general — and keep the ratio
configurable.** This must be enforced by the generator, not left to the user.

---

## 7. The closed loop

The feature that makes this a diagnostic system rather than a fortune cookie.

A stateless "generate a report" LLM call is the obvious design and it is wrong. Instead,
**prescriptions are first-class entities with a measured outcome:**

```ts
{
  target:   { type: "sfb", keys: ["ol", "ju"] },
  baseline: { errRate: 0.084, latencyP50: 210 },   // captured at prescription time
  drillsCompleted: 6,
  outcome:  { errRate: 0.031, latencyP50: 178 },   // measured after
  verdict:  "resolved"                              // resolved | improved | no-change | regressed
}
```

Every report then opens with the previous cycle's result:

> *Last cycle I flagged your right pinky. You completed 6 targeted sessions. Error rate
> dropped 8.4% → 3.1%. **Resolved.** New finding: …*

This does two things. It makes the tool feel like a doctor that commits to a claim and
checks its own work. And it gives honest feedback on whether the analysis logic is any
good — if prescriptions routinely produce no change, the diagnosis is wrong.

**This must exist in the schema from day one.** Retrofitting baselines is impossible; the
baseline has to be captured at the moment of prescription.

### 7.1 The verdict must be controlled

A bare before/after comparison of the numbers above is **not evidence**, and treating it as
evidence would quietly defeat the entire purpose of this section.

Targets are chosen as the worst rows of a ranked list built from noisy estimates. A bigram
reaches the top partly because it is genuinely bad and partly because its estimate was
unlucky in that window. Re-measure it later and the unlucky part washes out: **the target
improves whether or not the drills did anything.** Every prescription would report
`improved` or `resolved`, and the loop would confirm the diagnosis regardless of whether
the diagnosis was right.

So every prescription also carries a **hold-out control**: the same-type targets ranked
immediately below the treated set, captured with their own baseline at the same moment,
and then *never drilled and never shown*. They were drawn from the same tail of the same
distribution, so they regress by the same amount. The verdict is read off the difference:

```
lift = improvement(treated) − improvement(control)
```

Consequences that must not be softened:

- **Verdicts are harder to earn than pre/post.** A target that improved 60% while its
  control improved 45% is `improved` (15% attributable), not `resolved`. That is the
  correction working.
- **`control.baseline` is as immutable as `baseline`.** A control measured after the fact
  is not a control.
- **Both sides are measured over the identical window by the identical extractor.** Any
  asymmetry in *how* they are measured reappears in `lift` as a treatment effect that
  isn't there.
- **An uncontrolled verdict is labelled, never disguised.** `class` targets admit no valid
  control (the taxonomy classes partition the error population, so their shares are
  mechanically coupled), and prescriptions predating this mechanism have none. Those fall
  back to pre/post and carry `controlled: false` all the way into the report prompt.

`src/lib/prescriptions/scorecard.ts` aggregates this across prescriptions. Its headline is
**median lift, not the resolved count** — a run of `resolved` verdicts is exactly what
regression to the mean produces on its own, whereas median lift is the quantity that sits
at zero when the diagnosis is doing nothing.

See `src/lib/prescriptions/control.ts` for selection and
`src/lib/prescriptions/evaluate.ts` for the verdict rule.

---

## 8. Stack

| Layer | Choice | Reasoning |
| --- | --- | --- |
| Framework | **Next.js 16 (App Router)** | Server routes are required to hold the model provider API key; dashboard is data-heavy and benefits from server rendering; Vercel Cron handles nightly rollups. |
| UI | **shadcn/ui v4 + Tailwind v4** | Owned components, no black-box library. Note: v4 uses **Base UI**, not Radix. |
| DB / Auth | **Supabase (Postgres)** | Aggregation here is inherently relational (group by bigram, window over last N tests). Postgres does this natively; Firestore would fight it. JSONB holds raw events. Auth handles multi-device sessions. |
| Local store | **IndexedDB** | Offline write-ahead queue (§3.3). |
| AI | **Gemini**, called directly, server-side only | Single-user project with a single key — the vendor-routing indirection cost more than it bought. The model id stays a config value (`GEMINI_MODEL`); the vendor is now a code dependency, confined to `src/lib/ai/client.ts` and `src/lib/drills/llm.ts`. Never expose the key to the browser. |

**The API key never reaches the client.** All model calls go through Next.js route
handlers.

---

## 9. Build phases

Strictly ordered. Each phase is usable on its own.

### Phase 1 — Typing engine + capture
Test modes, word rendering, caret, input handling, results screen. Full event capture to
IndexedDB.

> **Capture the complete event stream immediately, even though nothing consumes it yet.**
> Data cannot be collected retroactively. By the time the analysis engine exists, months
> of history should already be waiting for it. This is the single most important
> instruction in the phase plan.

### Phase 2 — Sync
Supabase auth, schema, offline queue flush, cross-device history.

### Phase 3 — Deterministic stats engine + dashboard
All of §5.4. No LLM yet.

> **Use it personally for two weeks before starting Phase 4.** This reveals which metrics
> actually correlate with how typing *feels*, before prose gets built on top of them.

### Phase 4 — LLM report
Metric profile → Claude → structured findings. Prompt versioned in `reports`.

### Phase 5 — Prescriptions
Drill generation, targeted sessions, outcome measurement, the §7 loop.

**Resist jumping to Phase 4.** The LLM layer is the fun part and the shallow part; it is
only as good as the statistics underneath it.

---

## 10. Design principles

The tool must not be boring, or it goes unused and collects no data. Engagement is a
*functional* requirement here, not decoration. See `docs/DESIGN.md` for the full design
language.

Non-negotiables:

- **The test screen is sacred.** No chrome, no distraction, nothing animated in the
  periphery while typing. All personality lives in the results, dashboard, and reports.
- **The results screen is the reward.** This is where motion, colour, and delight belong.
- **Findings must show their evidence.** Every claim carries its number and its `n`.
  "Right pinky 2.1× slower (n=340)" not "your pinky needs work."
- **Progress must be visible over long horizons.** The core emotional payload is *"I am
  measurably better than I was a month ago."*
