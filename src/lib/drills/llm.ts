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
 * Same treatment as Phase 4 (src/lib/ai/client.ts): there is no
 * ANTHROPIC_API_KEY yet, so the live branch is written but never exercised.
 * Callers with no key get a clearly-flagged fixture instead of a fabricated
 * "real" drill.
 *
 * This module carries the `server-only` guard (API key isolation —
 * CLAUDE.md invariant 5), which means it cannot be unit tested directly in
 * the jsdom test environment — same as src/lib/ai/client.ts, which is
 * exercised only through the route handler, never a unit test. The pure
 * "is the pool weak enough to bother" decision lives in ./pool.ts instead,
 * specifically so it CAN be unit tested.
 *
 * TODO(ai-key): `grep -rn "TODO(ai-key)"` lists the full activation checklist.
 */

import Anthropic from "@anthropic-ai/sdk";
import { isLiveAIEnabled } from "@/lib/ai/client";
import { REPORT_MODEL } from "@/lib/ai/model";

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

  // TODO(ai-key): unverified — this branch has never executed. Before
  // trusting it: set ANTHROPIC_API_KEY in .env.local, run it once, confirm
  // the sentences actually lean on the targets and read naturally (not word
  // salad — the whole reason this mechanism exists), and sanity-check the
  // returned line count against `count`.
  const client = new Anthropic();
  const response = await client.messages.create({
    model: REPORT_MODEL,
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Write ${count} short sentences (8-14 words each) that naturally emphasise: ${targets.join(", ")}.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const sentences =
    textBlock && textBlock.type === "text"
      ? textBlock.text
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  return { source: "live", sentences };
}
