/**
 * Resolves a Prescription's abstract target (bigram / key / finger / sfb /
 * class) into concrete inputs for `generateDrill`: substring patterns to
 * search a dictionary for, or — for "class" — a purpose-built corpus file to
 * draw from wholesale.
 *
 * docs/ARCHITECTURE.md §6: "english_doubleletter.json, english_contractions
 * .json, and english_commonly_misspelled.json are pre-built drill corpora
 * for specific weakness classes." A `class`-type Finding's `targets` are
 * therefore read as corpus names, not substrings — there is no single
 * character pattern that means "commonly misspelled."
 */

import type { Finger, PrescriptionTargetType } from "@/lib/types";
import type { LayoutIndex } from "@/lib/analysis/layout";

/** Probed when resolving a `finger` target. Covers the practical range for
 *  drill words — dictionary words don't contain punctuation-only characters. */
const PROBE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/** Maps a recognised `class` target name to its purpose-built corpus
 *  basename (matches files in public/data/languages/). */
const CLASS_CORPUS: Record<string, string> = {
  doubleletter: "english_doubleletter",
  "double-letter": "english_doubleletter",
  "double_letter": "english_doubleletter",
  contractions: "english_contractions",
  misspelled: "english_commonly_misspelled",
  "commonly-misspelled": "english_commonly_misspelled",
  "commonly_misspelled": "english_commonly_misspelled",
};

/** Fallback general-vocabulary corpus for anything that isn't a `class`
 *  target, or a `class` target this build doesn't recognise yet. */
export const DEFAULT_CORPUS = "english_5k";

/**
 * Which corpus file `generateDrill`'s `wordlist` argument should be loaded
 * from. Only `class` targets pick something other than the default general
 * corpus — bigram/key/finger/sfb drills all draw from ordinary vocabulary,
 * filtered by pattern.
 */
export function resolveCorpus(targetType: PrescriptionTargetType, targets: string[]): string {
  if (targetType !== "class") return DEFAULT_CORPUS;
  for (const t of targets) {
    const hit = CLASS_CORPUS[t.toLowerCase()];
    if (hit) return hit;
  }
  return DEFAULT_CORPUS; // unrecognised class name — degrade to general practice rather than fail
}

/**
 * Substring patterns for `generateDrill`.
 *
 * - bigram / sfb / key: targets are already literal patterns.
 * - finger: expanded to every character that maps to that finger under the
 *   given layout (requires `layout`; returns [] without one — the caller
 *   should treat that as "cannot resolve yet", not "no weakness").
 * - class: always [] — the whole corpus from `resolveCorpus` IS the target,
 *   there is nothing to filter by substring.
 */
export function resolveTargetPatterns(
  targetType: PrescriptionTargetType,
  targets: string[],
  layout?: LayoutIndex,
): string[] {
  if (targetType === "bigram" || targetType === "sfb" || targetType === "key") {
    return targets.map((t) => t.toLowerCase());
  }

  if (targetType === "finger") {
    if (!layout) return [];
    const wanted = new Set(targets as Finger[]);
    const chars: string[] = [];
    for (const ch of PROBE_CHARS) {
      const key = layout.charToKey(ch);
      const finger = key ? layout.keyToFinger(key) : undefined;
      if (finger && wanted.has(finger)) chars.push(ch);
    }
    return chars;
  }

  return []; // class — see resolveCorpus
}
