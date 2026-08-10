@AGENTS.md

# KeySense

A typing trainer that diagnoses *why* you're slow, prescribes targeted drills, and
measures whether the prescription worked.

Read `docs/ARCHITECTURE.md` before making structural changes and `docs/DESIGN.md` before
building UI. This file is the short version — those are authoritative.

**Single-user personal project.** Optimise for correctness of the data pipeline and for
the app being pleasant enough to use daily. Do not build multi-tenancy, billing, admin
surfaces, or scale infrastructure.

---

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · shadcn/ui v4 · Supabase
(Postgres) · IndexedDB · OpenRouter.

Two things that differ from what you likely remember:

- **Next.js 16 has breaking changes from your training data.** Read the relevant guide in
  `node_modules/next/dist/docs/` before writing routing, caching, or server-component code.
- **Middleware is now called Proxy.** The file is `src/proxy.ts` exporting `proxy()`. A
  `middleware.ts` is silently ignored — it will not error, it just never runs.
- **shadcn v4 uses Base UI, not Radix.** Components come from `@base-ui/react`. Don't
  write Radix imports or Radix-specific props.
- Tailwind v4 has **no `tailwind.config.*`** — theming lives in `src/app/globals.css`.

## Supabase clients

Three clients, in `src/lib/db/supabase/`. Picking the wrong one is a security bug:

| Client | Key | Use |
| --- | --- | --- |
| `client.ts` | publishable | browser components |
| `server.ts` | publishable + cookies | **default** for server components and route handlers — RLS applies |
| `admin.ts` | secret | **bypasses RLS.** Only for cron rollups and backfills that run without a user session |

`admin.ts` imports `server-only`, so importing it from a client component is a build
error rather than a data breach. When using it, you must filter by `user_id` yourself —
nothing else will.

Add components with `npx shadcn@latest add <name>`. Never hand-write a component that
shadcn already ships.

---

## Non-negotiable invariants

These come from `docs/ARCHITECTURE.md`. Breaking one silently corrupts the product's
entire purpose.

### 1. The raw event log is immutable

`test_events` is append-only. Never `UPDATE` it. Every metric is a derived view that can
be recomputed from raw events — so derived tables carry `analysis_version`, and improving
an algorithm means bumping that version and recomputing, never editing history.

### 2. Timing comes from `event.timeStamp`

```ts
// correct — stamped by the browser at input time
onKeyDown={(e) => record(e.timeStamp, ...)}

// wrong — measures when your JS ran, polluted by main-thread jank
onKeyDown={() => record(performance.now(), ...)}
```

This silently corrupts every latency metric downstream. There is no test that will catch
it. Get it right by construction.

### 3. Never re-render the word list on a keystroke

Typing state lives in refs/reducers. Only the active word and caret re-render. Events
append to a plain array in a ref and are persisted **once, on test completion** — never
mid-test.

Budget: **< 16ms** keydown to caret paint. If a change touches the input path, measure it.

### 4. Statistics must be robust and gated

- **Medians, MAD, trimmed means.** Never raw means — latency distributions have brutal
  outliers.
- **Discard inter-key intervals > 1000ms** as "not typing."
- **No finding below n ≥ 30.** Use Wilson score intervals for error rates.
- **Baseline against the user's own history**, never population norms.

### 5. The LLM narrates; it never calculates

- Never send raw keystroke events to the model — only the compact pre-computed profile.
- The system prompt must instruct: *use only the numbers provided; never compute or invent
  a figure.*
- Every report row persists `model`, `prompt_version`, and `input_profile` for audit.
- **The model provider API key never reaches the client.** All model calls go through route
  handlers.

### 6. Prescriptions capture their baseline at creation time — and a control

A baseline measured after the fact is not a baseline. `prescriptions.baseline` is written
when the prescription is created, and is never updated.

The same applies to `prescriptions.control.baseline`. The control is the untreated hold-out
set that makes the verdict a difference-in-differences rather than a pre/post reading — see
ARCHITECTURE §7.1. Without it, targets selected as extremes improve on re-measurement
whether or not the drills worked, and every verdict is an artifact. **Never drill, display,
or otherwise touch `control.targets`**; the moment they receive treatment they stop being a
control and the correction silently inverts.

### 7. Offline sync stays conflict-free

Client-generated UUIDs, append-only rows, idempotent upserts. Do not introduce mutable
per-test state that two devices could both edit — it would turn a trivial sync into a
conflict-resolution problem.

---

## Design rules

Full language in `docs/DESIGN.md`. The three that get violated most:

- **The test screen is sacred.** No chrome, no ambient motion, no colour beyond text
  state, while a test is running. All personality lives in results/dashboard/reports.
- **Amber (`trace`) is spent on the waveform and primary actions only.** Three amber
  things on one screen means two are wrong.
- **Every claim shows its evidence.** `n=340`, `2.1×`, `p50 211ms`. A finding without a
  number and a sample size is not shippable.

Voice: clinical and direct. "Right pinky 2.1× slower than your median (n=340)", never
"your pinky needs some work!"

---

## Code conventions

- **Server Components by default.** `"use client"` only where interaction demands it —
  which for the typing surface is genuinely necessary, and for the dashboard mostly is not.
- **Pure functions for all analysis.** Everything in `src/lib/analysis/` takes data and
  returns data — no I/O, no React, no Supabase. This is what makes it testable and
  recomputable.
- **Types live next to the data they describe.** Shared shapes in `src/lib/types.ts`.
- **No `any`.** No non-null `!` on values that can genuinely be null.
- Prefer `type` over `interface`. Named exports over default, except Next.js page/layout
  files which must default-export.
- Keep comments for *why*, not *what*. The invariants above are worth commenting at their
  enforcement points.

## Testing

Vitest. The analysis layer is pure, so it is the part that must be tested:

- Every metric in `src/lib/analysis/` gets unit tests with hand-built event fixtures.
- Test the **outlier and small-n paths specifically** — a metric that looks right on clean
  data and produces nonsense on a 3-sample bigram is the exact failure mode this product
  cannot afford.
- The typing engine gets tests for backspace, ctrl+backspace, extra characters, missed
  characters, and rapid-input ordering.

Run `npm run typecheck && npm run lint && npm test` before declaring work complete.

## Repo layout

```
src/
├── app/                    # routes; API handlers under app/api/
├── components/ui/          # shadcn — generated, avoid hand-editing
├── components/             # KeySense components
├── lib/
│   ├── engine/             # typing engine + event capture
│   ├── analysis/           # pure stats functions — no I/O
│   ├── drills/             # deterministic drill synthesis
│   ├── db/                 # IndexedDB + Supabase clients
│   └── types.ts
public/data/                # word lists, quotes, layouts (GPL-3.0, see ATTRIBUTION.md)
supabase/migrations/        # SQL, applied in order
docs/                       # ARCHITECTURE.md, DESIGN.md
```

## Licensing

**GPL-3.0**, because `public/data/` is redistributed from monkeytype. Keep
`public/data/ATTRIBUTION.md` accurate if you add data files. No monkeytype *source code*
is used — the engine, analysis, and UI are original.
