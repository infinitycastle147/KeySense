# KeySense

A typing trainer that diagnoses *why* you're slow, prescribes targeted practice, and
measures whether the prescription worked.

Monkeytype tells you that you type at 84 WPM. KeySense tells you that your right pinky is
2.1× slower than your median, that `ol` and `ju` are costing you four words per minute,
and then builds the drills to fix it — and checks next week whether they did.

## How it works

1. **Capture** — every keystroke is recorded with what was expected, what was typed, and
   when, down to the millisecond.
2. **Diagnose** — a deterministic statistics engine finds real weaknesses (per-bigram
   latency, error taxonomy, finger attribution, fatigue curves), then an LLM narrates them
   into a short report. The model never computes a number; it only interprets the ones the
   engine produced.
3. **Prescribe** — drills are synthesised targeting those specific weaknesses.
4. **Verify** — the baseline is captured at prescription time, so the next report opens
   with whether the last one actually worked.

## Docs

| Document | Contents |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Data model, analysis pipeline, the stats/LLM split, build phases |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Visual language — the clinical-instrument concept, palette, typography |
| [`CLAUDE.md`](CLAUDE.md) | Working rules and invariants |

## Getting started

```bash
npm install
npm run dev
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind v4 · shadcn/ui v4 (Base UI) · Supabase ·
OpenRouter

## Status

All five phases in `docs/ARCHITECTURE.md` §9 are implemented: typing engine and keystroke
capture, offline sync and auth, the statistics engine and dashboard, the diagnosis
pipeline, and prescriptions with outcome tracking.

The model call itself is **written but never executed** — there is no `OPENROUTER_API_KEY`
yet. Without one the app is fully functional and reports return a fixture, clearly badged
in the UI. `grep -rn "TODO(ai-key)"` lists what to verify when a key is added.

## Licence

[GPL-3.0](LICENSE). The word lists, quotes, and keyboard layouts in `public/data/` are
redistributed from [monkeytype](https://github.com/monkeytypegame/monkeytype) under
GPL-3.0 — see [`public/data/ATTRIBUTION.md`](public/data/ATTRIBUTION.md). No monkeytype
source code is used; the engine, analysis, and UI are original.
