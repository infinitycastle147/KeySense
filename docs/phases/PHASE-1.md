# Phase 1 — Typing engine + event capture

**Goal:** a typing test that is genuinely pleasant to use, and that records every keystroke
with full context.

**Depends on:** nothing. `src/lib/types.ts` is already fixed — treat it as a contract and
do not change it.

> This phase captures the complete event stream even though **nothing reads it until
> Phase 3**. That is deliberate. Data cannot be collected retroactively; by the time the
> analysis engine exists, months of history should already be waiting for it.

---

## Scope

### 1. Word source — `src/lib/engine/wordsource.ts`

- Load word lists from `/data/languages/<name>.json` (already in `public/`). Shape:
  `{ name, noLazyMode, orderedByFrequency, words: string[] }`.
- Fetch lazily and cache in memory. **Never bundle** — `english_25k.json` is 380 KB.
- `generateWords(count, opts)` — random sample, honouring `punctuation` and `numbers`
  flags from `TestConfig`.
- Quotes load from `/data/quotes/english.json`.

### 2. The engine — `src/lib/engine/engine.ts`

A framework-free class or closure. **No React imports in this file** — it must be unit
testable in isolation.

```ts
createEngine(config: TestConfig, words: string[]): {
  handleKeyDown(e): void;
  getState(): EngineState;   // for render
  getEvents(): KeyEvent[];
  finish(): CompletedTest;
}
```

Must handle, each with a test:

- **Correct / incorrect** character entry
- **Backspace** and **ctrl/opt+backspace** (word delete) → `kind: "word-delete"`
- **Extra characters** — typing past a word's end (`charsExtra`)
- **Missed characters** — space pressed early (`charsMissed`)
- **Space** — recorded as a char event *and* advances `wordIdx`
- **`e.repeat`** — held keys must be **excluded**, not recorded
- **IME composition** — ignore events between `compositionstart` and `compositionend`
- Rapid input ordering preserved

### 3. Timing — the rule that breaks silently

```ts
// correct
handleKeyDown(e) { events.push({ t: e.timeStamp - startTs, ... }); }
// wrong — measures when JS ran, not when the key was pressed
handleKeyDown()  { events.push({ t: performance.now() - startTs, ... }); }
```

`startTs` is the `event.timeStamp` of the **first** keystroke, so `t` is always relative to
real typing start. No test will catch a violation here — get it right by construction.

### 4. Stats — `src/lib/engine/stats.ts`

Fixed definitions. Do not drift; historical comparability depends on them.

```
wpm         = (correctChars / 5) / minutes
rawWpm      = (allTypedChars / 5) / minutes
accuracy    = correctKeystrokes / totalKeystrokes   // keystrokes, not final chars
consistency = 100 - (coefficient of variation of per-second wpm)
```

`accuracy` counts corrected mistakes as mistakes — that is the point.

### 5. React integration — `src/components/test/`

- `TypingTest.tsx` (`"use client"`) — owns the engine in a `useRef`.
- **Never call `setState` per keystroke for the whole word list.** Only the active word and
  caret re-render. Use a subscription/`useSyncExternalStore` or a version counter that only
  the active word subscribes to.
- Events append to a ref array. Persist **once, on completion**.
- Budget: **< 16ms** keydown → caret paint.

Components: `WordList.tsx`, `Word.tsx` (memoised), `Caret.tsx`, `TestConfigBar.tsx`,
`TestTimer.tsx`.

### 6. Test screen UI — `src/app/page.tsx`

Per `docs/DESIGN.md §7`, **the test screen is sacred**:

- No chrome, nav, or header while a test runs
- Nothing animated in the periphery
- Colour only from `--type-untyped` / `--type-correct` / `--type-incorrect` / `--trace` caret
- Config bar fades out on first keystroke, returns on completion
- Font: `var(--font-type)`, minimum 2rem

Keyboard: `tab`+`enter` restarts, `esc` opens config. A typing tool that needs the mouse is
a contradiction.

### 7. Results screen — `src/components/results/ResultsScreen.tsx`

Headline stats in `--font-display`. **Leave a placeholder `<div>` for the trace
visualisation** — Phase 3 builds it. Do not build charts here.

### 8. Local persistence — `src/lib/db/local.ts`

Use `idb` (installed). Store `CompletedTest` keyed by `id`, with a `syncedAt: null` index
so Phase 2 can find unsynced rows. **Write once on completion, never mid-test.**

---

## Out of scope

Sync, auth, analysis, charts, dashboard, AI. Do not create files under
`src/lib/analysis/`, `src/lib/drills/`, or `src/app/api/` — other agents own those.

## Acceptance

- [ ] A 60s test is completable end to end and feels responsive
- [ ] `getEvents()` returns one well-formed `KeyEvent` per keystroke, `t` from `event.timeStamp`
- [ ] Completed test persists to IndexedDB and survives reload
- [ ] Unit tests: backspace, word-delete, extra, missed, repeat-key, space, WPM/accuracy maths
- [ ] `npm run typecheck && npm run lint && npm test && npm run build` all clean
