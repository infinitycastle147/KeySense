# Phase 5 — Prescriptions and the closed loop

**Goal:** the feature that makes KeySense a diagnostic tool rather than a fortune cookie —
it commits to a claim, prescribes a treatment, and then checks whether the treatment
worked.

**Depends on:** Phase 3 (`MetricProfile`), Phase 4 (`Finding[]`).

---

## Scope

### 1. Drill synthesis — `src/lib/drills/generate.ts`

**Deterministic first.** Given weak bigrams, filter the dictionary in
`/data/languages/` for real words containing them, weight by frequency (the lists are
`orderedByFrequency`), and assemble a word list. Instant, free, deterministic, real
English — it beats an LLM for ~90% of cases.

```ts
generateDrill(targets: string[], config: DrillConfig, wordlist: string[]): string[]
```

### The over-targeting trap

Drilling only weaknesses regresses general speed and makes practice miserable.

**Enforce `DrillConfig.targetRatio` in the generator** — default **0.7** targeted / 0.3
general, shuffled so targeted words are not clustered. This is a code-level guarantee, not
a user setting to remember. Unit test that the ratio holds.

Purpose-built corpora already in `public/data/languages/`:
`english_doubleletter.json`, `english_contractions.json`,
`english_commonly_misspelled.json`.

**LLM generation is secondary** — natural sentences emphasising target patterns, used only
when deterministic selection yields awkward word salad. Same `TODO(ai-key):` treatment as
Phase 4: build it, stub the call, flag the fixture.

### 2. Prescription lifecycle — `src/lib/prescriptions/`

```
Finding → createPrescription()   // baseline captured HERE, never later
        → drill sessions run, drills_done increments
        → drillsDone >= drillsTarget → evaluate()
        → outcome measured over post-prescription tests only
        → verdict: resolved | improved | no-change | regressed
```

**The baseline is captured at creation and never updated.** A baseline measured after the
fact is not a baseline — this is the one thing that cannot be retrofitted.

`evaluate()` must compare like with like: the same metric, the same minimum-n gate
(`MIN_FINDING_N`), and only tests recorded *after* `createdAt`. Verdict thresholds should
be explicit constants, not magic numbers inline.

### 3. Drill mode

- `TestMode: "drill"` already exists in `types.ts`
- `tests.source = "prescribed"`, `tests.prescription_id` set
- Entry point on the dashboard: "Start prescribed drill"
- On completion, increment `drills_done`; when the target is met, run `evaluate()`

### 4. The report loop — the payoff

Every report opens with the previous cycle's outcome:

> *Last cycle I flagged your right pinky. You completed 6 targeted sessions. Error rate
> dropped 8.4% → 3.1%. **Resolved.** New finding: …*

Extend the Phase 4 prompt input with resolved/active prescriptions so the model can open
this way. Bump `PROMPT_VERSION`.

This also gives honest feedback on whether the analysis is any good: if prescriptions
routinely produce `no-change`, the diagnosis logic is wrong.

### 5. Progress over time — `src/app/progress/page.tsx`

The long-horizon emotional payload: *"I am measurably better than I was a month ago."*

- WPM / accuracy over weeks and months, as strips
- Prescription history with verdicts
- Resolved-weakness timeline — which specific weaknesses were fixed, and when

---

## Out of scope

Changing analysis maths (Phase 3 owns it) or the engine.

## Acceptance

- [ ] Drills generate real words containing target patterns
- [ ] `targetRatio` enforced in code, with a test
- [ ] Baseline written at creation, never mutated — with a test
- [ ] `evaluate()` uses only post-prescription tests and respects `MIN_FINDING_N`
- [ ] Drill tests recorded with `source="prescribed"` and the correct `prescription_id`
- [ ] Progress page renders long-horizon trends
- [ ] `npm run typecheck && npm run lint && npm test && npm run build` all clean
