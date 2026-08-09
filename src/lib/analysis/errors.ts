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

function emptyTaxonomy(): ErrorTaxonomy {
  return { substitution: 0, insertion: 0, omission: 0, transposition: 0 };
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
