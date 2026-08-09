# KeySense — Design Language

> Engagement is a **functional** requirement. A boring tool goes unused, an unused tool
> collects no data, and without data there is no diagnosis. Delight is load-bearing here.

---

## 1. The concept: clinical instrument

Two facts about this product decide its entire visual identity:

1. **Typing is a time series.** Inter-key intervals literally form a waveform. Steady
   rhythm is a smooth wave; hesitation is a flatline; an error is a spike.
2. **The product is a diagnosis.** The brief was explicit: *"like a biological diagnose."*

Where rhythm meets medicine, there is one artifact: **the cardiograph.**

KeySense is styled as a clinical instrument that reads your typing the way an ECG reads a
heart. This is not decoration laid over a typing app — it is the honest visual form of what
the data actually is.

### The two modes are two instrument states

Not "light mode and dark mode." Two real states of a real machine:

| Mode | Reference | Use |
| --- | --- | --- |
| **Monitor** (default) | live instrument display, backlit | typing at night, the default |
| **Paper** | ECG chart printout, salmon grid on newsprint | daylight, reading reports |

This reframing is why the theme toggle is worth building well rather than treating as a
checkbox.

---

## 2. Palette

Six named values. Every colour in the product derives from these.

### Monitor (dark)

| Token | Hex | Role |
| --- | --- | --- |
| `bezel` | `#0F1418` | page background — blue-leaning near-black, never pure `#000` |
| `chassis` | `#171E24` | raised surfaces, cards, strips |
| `grid` | `#222D35` | hairlines, chart gridlines, dividers |
| `trace` | `#FFB627` | **the signature** — sodium amber, the waveform, primary accent |
| `flag` | `#E5484D` | errors, regressions, incorrect characters |
| `vital` | `#57C7A8` | resolved findings, improvement, correct-and-fast |

### Paper (light)

| Token | Hex | Role |
| --- | --- | --- |
| `bezel` | `#FFF7F3` | ECG chart paper — warm off-white |
| `chassis` | `#FFFFFF` | raised surfaces |
| `grid` | `#F2C9BC` | the salmon ECG grid — genuinely distinctive, use it visibly |
| `trace` | `#C2410C` | darkened amber for contrast on paper |
| `flag` | `#C62A2F` | |
| `vital` | `#0F766E` | |

**Amber is spent only on the trace and on primary actions.** If amber appears in three
places on one screen, two of them are wrong.

Deliberately avoided: cream + high-contrast serif + terracotta, and near-black + acid
green. Both are current AI-design defaults that appear regardless of subject.

---

## 3. Typography

Three roles, three families, all from the technical/instrument world.

| Role | Family | Use |
| --- | --- | --- |
| **Display** | **Martian Mono** | large numerals, WPM figures, section headings. Wide and technical. Used sparingly — it is loud. |
| **UI / body** | **Instrument Sans** | all interface text, report prose, labels |
| **Typing surface** | **JetBrains Mono** | the test text itself, and only that |

The typing surface font is the single most important type decision in the product — it is
what the user stares at for hours. JetBrains Mono is chosen for disambiguated `l/1/I` and
`0/O` and for holding legibility at speed. It must be user-configurable, but this is the
default.

### Scale

Type scale is a 1.25 ratio, but the **test text is exempt** — it sits at `2rem`/`32px`
minimum and is independently user-scalable.

```
display-xl   4.5rem   Martian Mono   500   -0.04em   // the WPM number on results
display-lg   2.5rem   Martian Mono   500   -0.03em
heading      1.25rem  Instrument Sans 600  -0.01em
body         0.9375rem Instrument Sans 400   0
label       0.75rem   Martian Mono   400   0.08em  uppercase
```

The `label` role — small, wide-tracked mono, uppercase — is the connective tissue of the
instrument look. Use it for units, axis labels, and evidence tags.

---

## 4. Structure: strips, not cards

An ECG readout is a **horizontal strip**. The dashboard follows the artifact:

```
┌──────────────────────────────────────────────────────────────┐
│ WPM          ╱╲    ╱╲╱╲                             86  ▲4   │  ← strip
│ 30d          ──────────────────────────────────────  n=214   │
├──────────────────────────────────────────────────────────────┤
│ ACCURACY     ╲╱╲──╱╲                                96.2 ▼.3 │
│ 30d          ──────────────────────────────────────  n=214   │
├──────────────────────────────────────────────────────────────┤
│ RIGHT PINKY  ╱╲╱╲╱╲╱                                211ms ▲  │
│ 30d          ──────────────────────────────────────  n=340   │
└──────────────────────────────────────────────────────────────┘
```

Stacked lanes, each one metric over time, aligned to a shared time axis so the eye can
read correlations across rows. This deliberately rejects the default 3-column card grid.

### The evidence tag is the structural motif

Every claim carries its number and its sample size, in `label` type:

```
n=340    2.1×    p50 211ms    ▲ 4.2
```

This is not decoration — `ARCHITECTURE.md §5.3` requires findings to show their evidence,
and this is the visual form of that rule. Numbered markers (`01 / 02 / 03`) are **not**
used; nothing here is a sequence.

---

## 5. The signature: the trace

**The one thing KeySense is remembered by.**

On the results screen, the test replays as a cardiograph line drawn left to right — at the
actual speed it was typed. Inter-key intervals become the waveform:

- steady rhythm → even peaks
- hesitation → a flat run
- an error → a `flag`-coloured spike
- a correction → the spike doubles back

The user watches their own typing rhythm play back as a pulse. It is genuinely diagnostic
— stalls are visible instantly, in a way a WPM number can never show — and it is the
moment that makes the tool feel alive.

Implementation notes:
- Canvas or SVG path, drawn with `stroke-dasharray` animation.
- Replay is skippable — click to complete instantly. Never trap the user in an animation.
- Under `prefers-reduced-motion`, render the completed trace immediately, no draw-on.

---

## 6. Motion

Spend it in one place. The trace is that place.

| Surface | Motion |
| --- | --- |
| **Test screen** | **None.** Caret only. |
| Results | The trace draw-on. Numbers count up once. |
| Dashboard | Strips fade in staggered, 40ms apart, once on load |
| Reports | None — prose should be still and readable |

`prefers-reduced-motion` is respected everywhere, without exception.

---

## 7. The test screen is sacred

Rules that override everything else in this document:

- **No chrome.** No nav, no sidebar, no header while a test is running.
- **Nothing moves** in the periphery. No ambient animation, no progress bar pulse.
- **No colour** beyond the text states: untyped (`grid`), correct (foreground),
  incorrect (`flag`), current (`trace` caret).
- Settings fade out on first keystroke and return on completion.
- Input latency budget: **< 16ms** keydown to caret paint.

All personality lives in results, dashboard, and reports. The typing surface stays
monastic. This is the discipline that earns the boldness elsewhere.

---

## 8. Voice

The instrument reports; it does not cheerlead.

- **Findings state evidence, not encouragement.** "Right pinky 2.1× slower than your
  median (n=340)" — never "your pinky needs some work!"
- **Verdicts are clinical**: `resolved` · `improved` · `no change` · `regressed`.
- **Active voice, present tense.** An action keeps its name through the flow: the button
  says "Start drill," the toast says "Drill complete."
- **Empty states direct.** "No tests yet. Run a 60-second test to establish a baseline."
  Not "Nothing here yet!"
- **Errors explain and instruct.** "Sync failed — 3 tests are stored locally and will
  retry." Never apologise, never be vague.
- Sentence case everywhere except `label` type, which is uppercase.

The tone is a good diagnostician: direct, specific, unsentimental, and on your side
because it is telling you the truth.

---

## 9. Quality floor

Not features — the baseline, met without announcement:

- Responsive to 360px. The test screen works on mobile even though it is not the primary
  target.
- Visible keyboard focus on every interactive element, in `trace`.
- `prefers-reduced-motion` respected.
- Contrast meets WCAG AA in both modes — verify `trace` on `bezel` in Paper mode
  specifically, it is the risky pair.
- The app is keyboard-driven: `tab`+`enter` restarts, `esc` opens the command palette.
  A typing tool that requires the mouse is a contradiction.
