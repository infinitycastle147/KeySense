import "server-only";

/**
 * SECONDARY drill mechanism — docs/ARCHITECTURE.md §6: "LLM generation for
 * natural-sentence drills that emphasise target patterns while staying
 * readable. Used when deterministic selection produces awkward word salad."
 *
 * Deterministic synthesis (./generate.ts) is primary and must work with no
 * model at all. This module only matters when the filtered word pool is too
 * thin to make a good drill — see `isPoolWeak`.
 *
 * Same treatment as Phase 4 (src/lib/ai/client.ts): callers with no
 * GEMINI_API_KEY get a clearly-flagged fixture instead of a fabricated "real"
 * drill.
 *
 * This module carries the `server-only` guard (API key isolation —
 * CLAUDE.md invariant 5), which means it cannot be unit tested directly in
 * the jsdom test environment — same as src/lib/ai/client.ts, which is
 * exercised only through the route handler, never a unit test. The pure
 * "is the pool weak enough to bother" decision lives in ./pool.ts instead,
 * specifically so it CAN be unit tested.
 */

import { GoogleGenAI } from "@google/genai";
import { isLiveAIEnabled } from "@/lib/ai/client";
import { DRILL_MODEL } from "@/lib/ai/model";

export type DrillSentenceSource = "live" | "fixture";

export type GeneratedDrillSentences = {
  source: DrillSentenceSource;
  sentences: string[];
};

function fixtureSentences(targets: string[]): string[] {
  const joined = targets.slice(0, 3).join(", ") || "the target pattern";
  return [
    `Sample sentence emphasising ${joined} — no API key configured, this is a placeholder, not a real drill.`,
    `The quick typist practises ${joined} on purpose, again and again, until it feels ordinary.`,
  ];
}

const SYSTEM_PROMPT =
  "You write short natural English sentences for a typing drill. Each sentence should use the given letter patterns more often than chance would predict, while still reading as normal, grammatical English — never word salad. Return one sentence per line and nothing else: no numbering, no preamble.";

/**
 * Generates `count` short sentences that lean on `targets` more than chance
 * would. With no live key, returns a labelled fixture built from the targets
 * themselves (not hardcoded text) so the UI still has something real to
 * render during development.
 */
export async function generateDrillSentences(
  targets: string[],
  count = 5,
): Promise<GeneratedDrillSentences> {
  if (!isLiveAIEnabled()) {
    return { source: "fixture", sentences: fixtureSentences(targets) };
  }

  // Verified live 2026-08-10 against gemini-3-flash-preview: 5 of 5 sentences
  // hit all three targets and read as natural English rather than word salad,
  // which is the only reason this mechanism exists.
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const response = await client.models.generateContent({
    model: DRILL_MODEL,
    contents: `Write ${count} short sentences (8-14 words each) that naturally emphasise: ${targets.join(", ")}.`,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      // Generous next to ~5 short sentences because thinking tokens come out of
      // the same budget; a truncated last line would otherwise reach the caller
      // as a real drill sentence.
      maxOutputTokens: 4000,
    },
  });

  const content = response.text;
  const sentences =
    typeof content === "string"
      ? content
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  // On truncation the final line is a fragment. Drilling on half a sentence is
  // worse than drilling on one fewer, and unlike the report path there is no
  // schema to make the damage visible — so drop it rather than throw.
  if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    sentences.pop();
  }

  return { source: "live", sentences };
}
