/**
 * What a weakness actually costs, in words per minute.
 *
 * The README's headline claim — "`ol` and `ju` are costing you four words per
 * minute" — was computed nowhere. Targets were ranked by error rate, which is
 * not impact: a 9% error rate on a bigram that appears twice a session matters
 * less than a 40ms excess on one that appears two hundred times. Ranking by
 * rate sends the typist to practise the wrong thing.
 *
 * ## The model
 *
 * Each bigram has a median latency. The typist has demonstrated, on their
 * fastest transitions, that they are physically capable of something quicker —
 * call that the **floor**. The excess above the floor, multiplied by how often
 * the transition actually occurs, is time lost:
 *
 *     lostMs(b) = max(0, latency(b) - floor) * n(b)
 *
 * Converting that to WPM is then arithmetic rather than judgement. If the
 * window contains `chars` characters typed in `activeMs` of real typing, then
 * removing `lostMs` gives the speed the typist would have had without that
 * weakness, and the difference is the cost.
 *
 * ## Why the floor is a personal percentile
 *
 * Not a population norm — docs/ARCHITECTURE.md §5.3 forbids those, and rightly:
 * "you are slower than average" is not actionable. Not the personal median
 * either, since by construction half of all transitions beat it and the sum of
 * "excess above median" would count only half the distribution.
 *
 * The floor is a low percentile of this typist's own bigram latencies: the
 * speed they *demonstrably* hit on their best transitions, so the excess is a
 * gap they have already proven they can close.
 *
 * Pure. See timeloss.test.ts.
 */

import type { BigramStat } from "@/lib/types";
import { percentile } from "./stats";

/** The percentile of a typist's own bigram latencies taken as the achievable
 *  floor. Low enough to represent real fluency, not so low that a handful of
 *  lucky transitions define an unreachable target. */
export const FLOOR_PERCENTILE = 15;

const CHARS_PER_WORD = 5;

export type TimeLoss = {
  bigram: string;
  n: number;
  latencyP50: number;
  /** ms above the personal floor, per occurrence. */
  excessMs: number;
  /** Total ms lost to this bigram across the window. */
  lostMs: number;
  /** WPM the typist would gain if this bigram came down to their floor. The
   *  number the README promises and the right key to rank targets by. */
  wpmCost: number;
};

export type TimeLossModel = {
  /** The achievable latency, in ms, derived from this typist's own data. */
  floorMs: number;
  /** Total characters the window's transitions account for. */
  chars: number;
  /** Total time spent on those transitions, ms. */
  activeMs: number;
  /** Current speed implied by chars/activeMs — the baseline the costs are
   *  differences from. */
  baselineWpm: number;
  losses: TimeLoss[];
};

/**
 * Builds the time-loss model over a window's pooled bigram statistics.
 *
 * `activeMs` is reconstructed from the bigrams themselves (sum of n * latency)
 * rather than taken from wall-clock duration. That keeps the arithmetic
 * self-consistent: the costs are differences against exactly the time the same
 * rows account for, so they sum correctly rather than being fractions of a
 * duration that also included pauses, corrections, and thinking.
 */
export function buildTimeLossModel(bigrams: BigramStat[], minN = 1): TimeLossModel {
  const eligible = bigrams.filter((b) => b.n >= minN && b.latencyP50 > 0);

  if (eligible.length === 0) {
    return { floorMs: 0, chars: 0, activeMs: 0, baselineWpm: 0, losses: [] };
  }

  // n-weighted: a bigram typed 400 times should have 400 times the influence
  // on what counts as this typist's achievable speed as one typed once.
  const weighted: number[] = [];
  for (const b of eligible) {
    for (let i = 0; i < b.n; i++) weighted.push(b.latencyP50);
  }
  const floorMs = percentile(weighted, FLOOR_PERCENTILE);

  const chars = eligible.reduce((sum, b) => sum + b.n, 0);
  const activeMs = eligible.reduce((sum, b) => sum + b.n * b.latencyP50, 0);
  const minutes = activeMs / 60000;
  const baselineWpm = minutes > 0 ? chars / CHARS_PER_WORD / minutes : 0;

  const losses: TimeLoss[] = eligible.map((b) => {
    const excessMs = Math.max(0, b.latencyP50 - floorMs);
    const lostMs = excessMs * b.n;
    const improvedMs = activeMs - lostMs;
    const improvedWpm =
      improvedMs > 0 ? chars / CHARS_PER_WORD / (improvedMs / 60000) : baselineWpm;

    return {
      bigram: b.bigram,
      n: b.n,
      latencyP50: b.latencyP50,
      excessMs,
      lostMs,
      wpmCost: improvedWpm - baselineWpm,
    };
  });

  return {
    floorMs,
    chars,
    activeMs,
    baselineWpm,
    losses: losses.sort((a, b) => b.wpmCost - a.wpmCost),
  };
}

/**
 * Total WPM recoverable from a set of bigrams, computed jointly.
 *
 * Not the sum of their individual `wpmCost` values. WPM is chars over time, so
 * gains *compound*: each millisecond saved is worth more once other
 * milliseconds have already gone, and the joint gain therefore exceeds the
 * naive sum. Fixing two bigrams that each cost 3 WPM alone is worth rather
 * more than 6 together.
 *
 * Reporting the sum would understate a multi-target prescription, and reporting
 * it as if it were exact would be wrong in the safe-looking direction — which
 * is the kind of error that survives review. This computes the single
 * counterfactual where every named bigram comes down to the floor at once.
 */
export function combinedWpmCost(model: TimeLossModel, bigrams: string[]): number {
  const wanted = new Set(bigrams.map((b) => b.toLowerCase()));
  const lostMs = model.losses
    .filter((l) => wanted.has(l.bigram.toLowerCase()))
    .reduce((sum, l) => sum + l.lostMs, 0);

  const improvedMs = model.activeMs - lostMs;
  if (improvedMs <= 0 || model.chars === 0) return 0;

  const improvedWpm = model.chars / CHARS_PER_WORD / (improvedMs / 60000);
  return improvedWpm - model.baselineWpm;
}
