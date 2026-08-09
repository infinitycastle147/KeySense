/**
 * Deterministic drill synthesis — docs/ARCHITECTURE.md §6, PHASE-5.md §1.
 *
 * PRIMARY mechanism (LLM generation in ./llm.ts is secondary): given weak
 * patterns, filter a real dictionary for words containing them, weight by
 * frequency (the shipped word lists are `orderedByFrequency`), assemble a
 * list. Instant, free, deterministic, real English.
 *
 * The over-targeting trap: drilling only weaknesses regresses general speed
 * and makes practice miserable. `config.targetRatio` is enforced HERE, in
 * code — never left to a UI setting a user could forget to set. See
 * src/lib/prescriptions/create.ts, which mints every DrillConfig with the
 * default ratio and never lets a caller override it.
 */

import type { DrillConfig } from "@/lib/types";

/** Default share of words that must contain a target pattern. The remainder
 *  is general vocabulary. */
export const DEFAULT_TARGET_RATIO = 0.7;

function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : DEFAULT_TARGET_RATIO;
}

/**
 * `patterns.length === 0` means "every word in this pool already qualifies"
 * — the case for a purpose-built corpus (english_doubleletter.json etc.),
 * where the whole file IS the target class rather than a substring to search
 * for. See src/lib/drills/targets.ts.
 */
function matchesAnyPattern(word: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const lower = word.toLowerCase();
  return patterns.some((p) => p.length > 0 && lower.includes(p.toLowerCase()));
}

/**
 * Rank-weighted sample WITH replacement: earlier entries (assumed more
 * frequent, per `orderedByFrequency`) are more likely to be drawn, but
 * replacement means a small filtered pool can still fill a long drill
 * without crashing or padding with duplicates of only one or two words.
 */
function weightedSample(pool: string[], count: number, rng: () => number): string[] {
  if (pool.length === 0 || count <= 0) return [];
  const weights = pool.map((_, i) => 1 / (i + 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let target = rng() * totalWeight;
    let idx = pool.length - 1;
    for (let j = 0; j < weights.length; j++) {
      target -= weights[j];
      if (target <= 0) {
        idx = j;
        break;
      }
    }
    out.push(pool[idx]);
  }
  return out;
}

/** Fisher-Yates. This is what keeps targeted words from clustering — the
 *  targeted and general pools are concatenated, then shuffled as one. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type GenerateDrillOptions = {
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
  /** Pool for the general (non-targeted) share. Defaults to `wordlist` — the
   *  common case, where targeted and general words share one dictionary. A
   *  distinct pool matters for corpus-backed drills (targetType "class"),
   *  where `wordlist` IS the specialised corpus and the general share should
   *  come from ordinary vocabulary instead — see src/lib/drills/loader.ts. */
  generalWordlist?: string[];
};

/**
 * Assembles a drill word list of `config.wordCount` words.
 *
 * `targets` are substring patterns (bigrams like "th", single keys like "j")
 * to search `wordlist` for. An empty `targets` array means every word in
 * `wordlist` already qualifies (purpose-built corpus case).
 *
 * `config.targetRatio` share of the output is guaranteed to match a pattern
 * (exactly, by construction — not merely "on average"); the rest is general
 * vocabulary, drawn from the same `wordlist` unless `options.generalWordlist`
 * is given. The two pools are shuffled together so targeted words are not
 * clustered at the front or back of the drill.
 */
export function generateDrill(
  targets: string[],
  config: DrillConfig,
  wordlist: string[],
  options: GenerateDrillOptions = {},
): string[] {
  const rng = options.rng ?? Math.random;
  const wordCount = Math.max(0, Math.floor(config.wordCount));
  if (wordCount === 0 || wordlist.length === 0) return [];

  const ratio = clampRatio(config.targetRatio);
  const targetCount = Math.round(wordCount * ratio);
  const generalCount = wordCount - targetCount;

  const generalPool = options.generalWordlist ?? wordlist;
  const targetPool = wordlist.filter((w) => matchesAnyPattern(w, targets));
  // Never crash or under-fill: if nothing in `wordlist` matches, fall back to
  // the general pool for the targeted slots too rather than returning fewer
  // words than asked for.
  const effectiveTargetPool = targetPool.length > 0 ? targetPool : generalPool;

  const targetWords = weightedSample(effectiveTargetPool, targetCount, rng);
  const generalWords = weightedSample(generalPool, generalCount, rng);

  return shuffle([...targetWords, ...generalWords], rng);
}
