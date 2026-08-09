---
name: typing-engine
description: Work on the KeySense typing test engine — keystroke capture, input handling, caret, word rendering, WPM/accuracy computation, or test modes. Use when touching anything in src/lib/engine/ or the test screen UI, or when typing feels laggy or events look wrong. Covers the timing-fidelity and render-performance rules that all downstream data depends on.
---

# Working on the typing engine

The engine is a **sensor**. Everything the product does downstream is only as good as the
data captured here, and capture bugs are usually invisible — the app feels fine while the
data is quietly wrong.

## The two rules that break silently

### 1. Timing comes from `event.timeStamp`

```ts
// correct — stamped by the browser when the input occurred
function onKeyDown(e: KeyboardEvent) {
  events.current.push({ t: e.timeStamp - startTs.current, ... });
}

// wrong — measures when React got around to running your handler
function onKeyDown() {
  events.current.push({ t: performance.now() - startTs.current, ... });
}
```

`performance.now()` inside the handler includes main-thread jank, React scheduling, and
GC pauses. It corrupts every latency metric downstream, and **no test will catch it** —
the numbers look plausible, just wrong. Get it right by construction.

### 2. Never re-render the word list per keystroke

```ts
// wrong — re-renders every word on every keystroke
const [typed, setTyped] = useState<string[]>([]);

// correct — state in a ref, only the active word subscribes
const typed = useRef<string[]>([]);
```

Only the **active word** and the **caret** may re-render on input. Events append to a
plain array in a ref and are persisted to IndexedDB **once, on completion** — never
mid-test.

Budget: **< 16ms** keydown → caret paint. If a change touches the input path, profile it
with the React DevTools flamegraph before and after. Do not assume.

## Event shape

```ts
type KeyEvent = {
  t: number;            // ms from test start, from event.timeStamp
  key: string;          // character actually produced
  expected: string;     // character that should have been produced
  ok: boolean;
  wordIdx: number;
  charIdx: number;
  prev: string | null;  // preceding expected char — bigram context
  mods: string[];
  kind: "char" | "backspace" | "word-delete";
};
```

Do **not** store hand/finger/row — those are derived at analysis time from
`public/data/layouts/*.json` using the test's `layout` field. Storing them bakes in a
layout assumption and bloats the archive.

## Edge cases that must be handled

The reference clone at `frontend/src/ts/test/` in monkeytype is worth reading for these —
they are where naive implementations break:

- **Backspace** vs. **ctrl/opt+backspace** (word delete) — both emit events, different `kind`
- **Extra characters** — typing past the end of a word
- **Missed characters** — advancing to the next word early with space
- **Space handling** — is space a character, a word boundary, or both? (Both. It is
  recorded as a char event *and* advances `wordIdx`.)
- **IME composition** — `compositionstart`/`compositionend`; do not record intermediate
  composition state as keystrokes
- **Dead keys** — accents on international layouts
- **Rapid input ordering** — two keydowns before a render; the ref-based approach must
  preserve order
- **Repeat keys** — `e.repeat` held-key events must not be recorded as real keystrokes

## WPM definition

Fix these and do not drift — historical comparisons depend on stability:

- `wpm = (correctChars / 5) / minutes`
- `rawWpm = (allTypedChars / 5) / minutes`
- `accuracy = correctChars / totalKeystrokes` (keystrokes, not final characters — this
  counts corrected mistakes as mistakes, which is the point)
- `consistency` = coefficient of variation of per-second WPM, expressed as a percentage

## Test screen UI rules

From `docs/DESIGN.md §7` — the test screen is sacred:

- No chrome, no nav, no ambient motion while a test runs
- No colour beyond text state: untyped / correct / incorrect / caret
- Settings fade out on first keystroke, return on completion

## Checklist

- [ ] Timing from `event.timeStamp`
- [ ] No React state updates per keystroke outside the active word
- [ ] Events appended to a ref, persisted once on completion
- [ ] `e.repeat` events excluded
- [ ] Backspace / word-delete / extra / missed characters covered by tests
- [ ] Input latency profiled if the input path changed
- [ ] `npm run typecheck && npm test` clean
