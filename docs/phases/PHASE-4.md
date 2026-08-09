# Phase 4 — AI diagnosis (built, but not live)

**Goal:** the full report pipeline, complete and tested, with the single network call to
Claude stubbed behind a flag.

**Depends on:** Phase 3's `MetricProfile`.

> ## The key constraint for this phase
>
> **There is no `ANTHROPIC_API_KEY` yet.** Build everything around the call so that adding
> the key later is a one-line change and nothing else.
>
> - Everything except the network call must be **pure and unit tested**: profile
>   compaction, prompt construction, response parsing, validation, persistence.
> - The live call sits behind `isLiveAIEnabled()` — a single check for the key.
> - Without a key, the route returns a **fixture response** from
>   `src/lib/ai/fixtures/`, clearly flagged in the payload as `source: "fixture"`.
> - Mark every place needing revisiting with **`TODO(ai-key):`** so `grep -rn "TODO(ai-key)"`
>   lists the entire activation checklist.
> - The UI must visibly indicate when a report is a fixture. Never let a fake diagnosis
>   look real.

---

## Scope

### 1. Profile compaction — `src/lib/ai/profile-input.ts`

`MetricProfile` → the compact object actually sent to the model.

- **Never send raw `KeyEvent`s.** Enforce this with a unit test asserting the serialised
  payload contains no event array and stays under ~2 KB.
- Top-N only (worst 20 bigrams, worst 10 keys, all 9 fingers).
- **Every number carries its `n`.** Drop anything where `reportable === false`.

### 2. Prompt — `src/lib/ai/prompt.ts`

Pure function: profile → messages. Export `PROMPT_VERSION` and bump it on any change —
`reports.prompt_version` is the audit trail.

The system prompt must state, unambiguously:

- Use **only** the numbers provided. Never compute, estimate, or invent a figure.
- Every finding must cite the metric and its `n`.
- Compare against the user's own baseline, never population norms.
- Return 2–4 findings, most severe first. Prefer specificity over coverage.
- Clinical register: direct, unsentimental. No encouragement, no exclamation marks.

Use structured tool-use / JSON output matching `Finding[]` from `types.ts`.

### 3. Client — `src/lib/ai/client.ts`

```ts
export function isLiveAIEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
```

- `import "server-only"` at the top — the key must never reach the browser.
- Model: **`claude-opus-5`**. Keep the id in one exported constant.
- `@anthropic-ai/sdk` is installed.
- `TODO(ai-key):` on the live branch, noting: set key in `.env.local`, verify a real call,
  check token usage, then remove the fixture fallback default.

### 4. Response validation — `src/lib/ai/parse.ts`

Parse and validate with `zod` (installed) against `Finding[]`. **Reject any finding whose
evidence numbers do not appear in the input profile** — this is the guard against
hallucinated statistics, and it is the most important test in this phase. Write it against
a deliberately-hallucinating fixture.

### 5. Route — `src/app/api/report/route.ts`

1. Auth via `server.ts` (RLS applies)
2. Load last 20–50 tests, build `MetricProfile`
3. Refuse with a clear message if `testCount` is too low — an honest "not enough data yet"
   beats a fabricated diagnosis
4. Call Claude *or* return the fixture
5. Persist to `reports`: `findings`, `prose`, `model`, `prompt_version`, `input_profile`
6. Return the report

### 6. Report UI — `src/app/reports/`

The diagnosis, in `docs/DESIGN.md` voice: findings with evidence tags, severity, and the
previous cycle's verdict when Phase 5 exists. Prose is still and readable — **no motion
here**. A clear badge when `source === "fixture"`.

### 7. Fixtures — `src/lib/ai/fixtures/`

At least: a realistic 3-finding report, a low-data refusal, and a hallucinated-numbers
response used to prove the validator rejects it.

---

## Out of scope

Drill generation and prescriptions (Phase 5). Do not modify `src/lib/analysis/`.

## Acceptance

- [ ] Everything but the network call is unit tested
- [ ] Test proves raw events never enter the payload
- [ ] Validator rejects hallucinated numbers — with a test
- [ ] App works fully with no `ANTHROPIC_API_KEY`, returning flagged fixtures
- [ ] `grep -rn "TODO(ai-key)"` returns a complete activation checklist
- [ ] `npm run typecheck && npm run lint && npm test && npm run build` all clean
