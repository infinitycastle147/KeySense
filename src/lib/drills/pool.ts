/**
 * Pure helper for deciding when the deterministic word pool (generate.ts) is
 * too thin to make a good drill, and the secondary LLM sentence mechanism
 * (llm.ts) is worth reaching for instead. Split out from llm.ts so it can be
 * unit tested without pulling in the `server-only` guard (see llm.ts's
 * header — that module is deliberately untested directly, matching
 * src/lib/ai/client.ts's precedent).
 */

/** Below this many real dictionary words matching the target pattern(s),
 *  deterministic selection is too repetitive to be a good drill. */
export const WEAK_POOL_THRESHOLD = 4;

export function isPoolWeak(matchingWordCount: number): boolean {
  return matchingWordCount < WEAK_POOL_THRESHOLD;
}
