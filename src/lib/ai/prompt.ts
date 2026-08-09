/**
 * Prompt construction. Pure — no I/O, no SDK — so it can be unit tested and
 * diffed across PROMPT_VERSION bumps.
 *
 * The system prompt's job is narrow: the statistics are already computed, so
 * the model interprets and prioritises. Everything here exists to stop it doing
 * arithmetic (docs/ARCHITECTURE.md §5.1).
 */

import type { CompactProfile } from "./profile-input";
import type { PrescriptionReportContext } from "@/lib/prescriptions/report-context";

export const SYSTEM_PROMPT = `You are the diagnostic engine for KeySense, a typing trainer. You read a pre-computed statistical profile of one person's typing and write a short clinical report.

## The rule that matters most

Use ONLY the numbers provided in the profile. Never compute, estimate, average, convert, or infer a figure. If a number you want is not in the profile, do not use it — write the finding around a number that is there, or write a different finding. A single invented statistic destroys the credibility of the entire report.

Every number you cite must appear verbatim in the profile you were given.

## Opening with the previous cycle

If a "previous prescription cycle" block appears below, open \`summary\` by
reporting its outcome BEFORE presenting new findings — this is the closed
loop that makes KeySense diagnostic rather than a one-off readout (see
docs/ARCHITECTURE.md §7). Cite only the baseline, outcome, and verdict given
in that block; never restate it in different numbers. If no such block
appears, this is either the user's first report or nothing has completed
since the last one — do not invent a "last cycle" in that case.

## What to write

Return 2 to 4 findings, most severe first. Prefer specificity over coverage: one precise, actionable finding beats three vague ones.

For each finding:
- Cite the metric and its sample size (n) in the evidence array.
- Say what the weakness is and, where the data supports it, what is likely causing it.
- Set targets to the specific bigrams, keys, or fingers the drills should focus on.

Weakness lives in transitions, not individual keys — per-bigram data is usually the most diagnostic. Same-finger bigrams and transpositions are worth calling out specifically when present.

## Voice

Clinical, direct, unsentimental. You are a diagnostician reporting findings, not a coach.

Write "Right pinky is 2.1x slower than your median (n=340)", never "your pinky needs some work!". No encouragement, no exclamation marks, no praise. Compare only against this person's own baseline — you have no population data and must not imply any.

Do not hedge with "might" or "possibly" when the data is clear, and do not overstate when it is thin.`;

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Renders the "previous prescription cycle" block PHASE-5.md §4 asks for.
 * Deliberately plain prose, not JSON — this block is framing for `summary`,
 * not a source of citable evidence numbers the way `compact` is (see
 * src/lib/ai/parse.ts: `validateReport` only checks `finding.evidence`, never
 * `summary`, so nothing here needs to be registered with
 * `collectAllowedNumbers`).
 */
function renderPrescriptionContext(context: PrescriptionReportContext): string {
  const lines: string[] = [];

  if (context.lastCompleted) {
    const c = context.lastCompleted;
    lines.push(
      "Previous prescription cycle (open the summary with this, before new findings):",
      `- Target: ${c.targetType} [${c.targets.join(", ")}]`,
      `- Completed ${c.drillsCompleted} drill sessions, finished ${c.completedAt}`,
      `- Error rate: ${pct(c.baselineErrorRate)} -> ${pct(c.outcomeErrorRate)}`,
      `- Verdict: ${c.verdict}`,
    );
  }

  if (context.active.length > 0) {
    lines.push(
      "",
      "Currently active prescriptions (already being drilled — do not re-prescribe the same target unless the evidence below shows a DIFFERENT weakness):",
      ...context.active.map(
        (a) => `- ${a.targetType} [${a.targets.join(", ")}]: ${a.drillsDone}/${a.drillsTarget} drills done`,
      ),
    );
  }

  return lines.join("\n");
}

/** The user turn: the profile as JSON, plus the framing for this window and
 *  (when present) the previous prescription cycle's result. */
export function buildUserMessage(
  compact: CompactProfile,
  prescriptionContext?: PrescriptionReportContext,
): string {
  const parts = [
    `Typing profile for the window ${compact.windowStart} to ${compact.windowEnd}, covering ${compact.testCount} tests.`,
  ];

  if (prescriptionContext && (prescriptionContext.lastCompleted || prescriptionContext.active.length > 0)) {
    parts.push("", renderPrescriptionContext(prescriptionContext));
  }

  parts.push("", "Every number you may cite in a finding's evidence is in this object:", "", JSON.stringify(compact, null, 2));

  return parts.join("\n");
}
