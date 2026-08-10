/**
 * Error taxonomy (substitution / insertion / omission / transposition) and
 * the intended->typed confusion matrix. Per docs/ARCHITECTURE.md §5.4,
 * transpositions specifically indicate hand-alternation timing problems and
 * are detected by looking for `ab` typed as `ba` across adjacent events.
 *
 * Classification judgement calls (KeyEvent gives us `key`, `expected`, `ok`,
 * `kind` — no explicit error-class field, so this module defines the mapping):
 *
 *   - transposition: two adjacent "char" events where event[i].expected ==
 *     event[i+1].key AND event[i].key == event[i+1].expected — the two
 *     characters were typed in swapped order. Detected first, in a single
 *     forward pass, and both events are consumed so they are never also
 *     double-counted as substitutions below.
 *   - insertion: `expected === ""` — a character was produced where none was
 *     called for (typed past the end of the expected input).
 *   - omission: characters skipped by committing a word early. These have no
 *     keydown of their own, so they are NOT events — they are carried as
 *     `KeyEvent.missed` on the space that advanced past the incomplete word,
 *     and counted separately from the per-event classification below. (The
 *     `key === ""` sentinel this module originally assumed is never emitted by
 *     the engine; relying on it left `omission` permanently zero.)
 *   - substitution: everything else with `!ok` — a real (non-empty) wrong
 *     character was produced for a real (non-empty) expected character.
 *
 * Substitution/insertion/transposition partition the `!ok` "char" events with
 * no overlap. Omissions are additive on top, since they represent characters
 * that were never typed at all.
 */

import type { KeyEvent, ErrorTaxonomy, ConfusionMatrix, ErrorClass } from "@/lib/types";
import { alignWord, findTranspositions, type AlignOp } from "./align";
import type { LayoutIndex } from "./layout";

function emptyTaxonomy(): ErrorTaxonomy {
  return { substitution: 0, insertion: 0, omission: 0, transposition: 0 };
}

/**
 * Replays the event stream to recover what was actually left in each word.
 *
 * Mirrors the engine's own state transitions exactly (src/lib/engine/engine.ts):
 * a "char" event appends, "backspace" removes one character, "word-delete"
 * clears the word. The space that commits a word is a "char" event too, but it
 * belongs to the boundary rather than to the word's content, so it is not
 * appended — matching `handleSpace`, which pushes the event without touching
 * `typed[wordIdx]`.
 *
 * Words never reached are left undefined rather than empty: "not attempted"
 * and "attempted and left blank" are different facts, and only the second is
 * an omission.
 */
function replayTypedWords(events: KeyEvent[], wordCount: number): (string | undefined)[] {
  const typed: (string | undefined)[] = new Array(wordCount).fill(undefined);

  for (const event of events) {
    const idx = event.wordIdx;
    if (idx < 0 || idx >= wordCount) continue;

    if (event.kind === "char") {
      if (event.key === " ") {
        // Commits the word. Mark it attempted even if nothing was typed into
        // it — a word skipped with a bare space is a full omission.
        typed[idx] = typed[idx] ?? "";
        continue;
      }
      typed[idx] = (typed[idx] ?? "") + event.key;
    } else if (event.kind === "backspace") {
      typed[idx] = (typed[idx] ?? "").slice(0, -1);
    } else {
      typed[idx] = "";
    }
  }

  return typed;
}

/** The per-word alignments backing both aligned metrics below. */
function alignAttemptedWords(events: KeyEvent[], words: string[]): AlignOp[][] {
  const typed = replayTypedWords(events, words.length);
  const scripts: AlignOp[][] = [];

  for (let i = 0; i < words.length; i++) {
    const got = typed[i];
    if (got === undefined) continue; // never reached — neither typed nor skipped
    scripts.push(alignWord(words[i] ?? "", got));
  }

  return scripts;
}

/** Indices (into `events`) already classified, keyed by index -> class. */
function classifyEvents(events: KeyEvent[]): Map<number, ErrorClass> {
  const classification = new Map<number, ErrorClass>();

  // Pass 1: transpositions consume two adjacent indices at once.
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i];
    const b = events[i + 1];
    if (a.kind !== "char" || b.kind !== "char") continue;
    if (a.ok || b.ok) continue;
    if (classification.has(i) || classification.has(i + 1)) continue;

    const isSwap =
      a.expected !== b.expected &&
      a.expected === b.key &&
      a.key === b.expected &&
      a.key !== "" &&
      b.key !== "";

    if (isSwap) {
      classification.set(i, "transposition");
      classification.set(i + 1, "transposition");
      i += 1; // don't let the second event of this pair start another pair
    }
  }

  // Pass 2: everything else that's !ok and unclassified.
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== "char" || e.ok || classification.has(i)) continue;

    if (e.expected === "") {
      classification.set(i, "insertion");
    } else {
      classification.set(i, "substitution");
    }
  }

  return classification;
}

/** Empty input, or input with zero errors, returns all-zero counts. */
export function computeErrorTaxonomy(events: KeyEvent[]): ErrorTaxonomy {
  const taxonomy = emptyTaxonomy();
  const classification = classifyEvents(events);
  for (const errorClass of classification.values()) {
    taxonomy[errorClass] += 1;
  }
  // Omissions are carried on the committing event rather than being events
  // themselves — see the module header.
  for (const event of events) {
    if (event.kind === "char" && event.missed) {
      taxonomy.omission += event.missed;
    }
  }
  return taxonomy;
}

/**
 * intended -> typed -> count. Only populated for error classes where both
 * sides are meaningful characters (substitution and transposition) —
 * insertions have no "intended" character and omissions have no "typed"
 * character, so they're excluded rather than polluting the matrix with ""
 * keys.
 */
export function computeConfusionMatrix(events: KeyEvent[]): ConfusionMatrix {
  const matrix: ConfusionMatrix = {};
  const classification = classifyEvents(events);

  for (const [index, errorClass] of classification) {
    if (errorClass !== "substitution" && errorClass !== "transposition") continue;
    const event = events[index];
    if (event.expected === "" || event.key === "") continue;

    const row = matrix[event.expected] ?? {};
    row[event.key] = (row[event.key] ?? 0) + 1;
    matrix[event.expected] = row;
  }

  return matrix;
}

// ---------------------------------------------------------------------------
// Alignment-based classification (preferred when `words` is archived)
// ---------------------------------------------------------------------------

/**
 * Error taxonomy computed from sequence alignment rather than position.
 *
 * This is the correct reading of the same data. The positional version above
 * charges a dropped character to whatever happened to land in its place, and
 * then charges every following character in the word as well; alignment
 * recognises the gap and stops the cascade. For `hello` typed as `helo`:
 * positional says one substitution (l->o) plus one missed character, alignment
 * says one omission — and only the second is true.
 *
 * Mid-word omissions become countable here for the first time. The positional
 * path can only see omissions that the engine explicitly recorded on a
 * word-committing space (`KeyEvent.missed`), because a character that is never
 * typed produces no keydown of its own; alignment infers them from the gap.
 *
 * Measured on the *final* content of each word, so a mistake that was
 * backspaced and fixed is not counted here. That is deliberate and is the one
 * respect in which this is narrower than the positional version: a corrected
 * keystroke's true intent cannot be recovered from the log (the same cascade
 * problem applies to the abandoned attempt), so it is left out rather than
 * guessed at. Keystroke-level mistakes, corrected or not, remain fully counted
 * by `computeAccuracy` in src/lib/engine/stats.ts, which is where that
 * question belongs.
 */
export function computeErrorTaxonomyAligned(
  events: KeyEvent[],
  words: string[],
): ErrorTaxonomy {
  const taxonomy = emptyTaxonomy();

  for (const ops of alignAttemptedWords(events, words)) {
    const transposed = new Set<number>();
    for (const start of findTranspositions(ops)) {
      transposed.add(start);
      transposed.add(start + 1);
      taxonomy.transposition += 1;
    }

    for (let i = 0; i < ops.length; i++) {
      if (transposed.has(i)) continue;
      const op = ops[i];
      if (op.kind === "substitution") taxonomy.substitution += 1;
      else if (op.kind === "insertion") taxonomy.insertion += 1;
      else if (op.kind === "omission") taxonomy.omission += 1;
    }
  }

  return taxonomy;
}

/**
 * intended -> typed -> count, from alignment.
 *
 * Only substitutions and transpositions contribute, for the same reason as the
 * positional version: an insertion has no intended character and an omission
 * has no typed one. The difference is that the pairs here are real — a gap is
 * reported as a gap instead of being smeared across the rest of the word as
 * invented confusions.
 */
export function computeConfusionMatrixAligned(
  events: KeyEvent[],
  words: string[],
): ConfusionMatrix {
  const matrix: ConfusionMatrix = {};

  for (const ops of alignAttemptedWords(events, words)) {
    for (const op of ops) {
      if (op.kind !== "substitution") continue;
      if (op.expected === "" || op.typed === "") continue;
      const row = matrix[op.expected] ?? {};
      row[op.typed] = (row[op.typed] ?? 0) + 1;
      matrix[op.expected] = row;
    }
  }

  return matrix;
}

// ---------------------------------------------------------------------------
// Root-cause classification of confusions
// ---------------------------------------------------------------------------

/**
 * Why a substitution happened, as far as the keyboard can explain it.
 *
 * docs/ARCHITECTURE.md §5.4 promises that the confusion matrix "separates
 * adjacent-key slips from finger confusion from sequencing errors — different
 * root causes, different drills". The matrix only ever counted pairs; this is
 * the separation itself.
 *
 *   spatial-slip    the wrong key is physically next to the right one — the
 *                   finger went to roughly the right place and missed
 *   same-finger     one finger, two keys, wrong one chosen — not a miss but a
 *                   confusion about which key that finger owns
 *   row-jump        same finger group, two or more rows away — the hand
 *                   travelled to the wrong row entirely
 *   cross-hand      the wrong hand produced the character, which is a
 *                   sequencing failure rather than an aiming one
 *   unrelated       nothing about the geometry explains it
 *
 * The prescriptions differ: a spatial slip wants slower, more accurate
 * practice on that pair; a cross-hand confusion wants the *sequence* drilled,
 * because the typist is anticipating the wrong key entirely.
 */
export type ConfusionCause =
  | "spatial-slip"
  | "same-finger"
  | "row-jump"
  | "cross-hand"
  | "unrelated";

export type ClassifiedConfusion = {
  intended: string;
  typed: string;
  count: number;
  cause: ConfusionCause;
};

export function classifyConfusion(
  layout: LayoutIndex,
  intended: string,
  typed: string,
): ConfusionCause {
  const a = layout.charToKey(intended);
  const b = layout.charToKey(typed);
  if (!a || !b) return "unrelated";

  if (layout.isSameFinger(a, b)) return "same-finger";
  if (layout.areAdjacent(a, b)) return "spatial-slip";

  const fa = layout.keyToFinger(a);
  const fb = layout.keyToFinger(b);
  if (fa && fb && fa !== "thumb" && fb !== "thumb") {
    const sameHand = fa.startsWith("l-") === fb.startsWith("l-");
    if (!sameHand) return "cross-hand";

    const pa = layout.keyToPosition(a);
    const pb = layout.keyToPosition(b);
    if (pa && pb && Math.abs(pa.rowIndex - pb.rowIndex) >= 2) return "row-jump";
  }

  return "unrelated";
}

/**
 * Flattens a confusion matrix into ranked, cause-labelled rows.
 *
 * Ranked by count, so the caller can take the top N and know each one carries
 * an explanation rather than just a pair of characters.
 */
export function classifyConfusions(
  matrix: ConfusionMatrix,
  layout: LayoutIndex,
  topN = 10,
): ClassifiedConfusion[] {
  const rows: ClassifiedConfusion[] = [];
  for (const [intended, typedCounts] of Object.entries(matrix)) {
    for (const [typed, count] of Object.entries(typedCounts)) {
      rows.push({ intended, typed, count, cause: classifyConfusion(layout, intended, typed) });
    }
  }
  return rows.sort((a, b) => b.count - a.count).slice(0, topN);
}
