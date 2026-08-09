/**
 * Prescription lifecycle: creation.
 *
 * CLAUDE.md invariant 6 / docs/ARCHITECTURE.md §7: "A baseline measured after
 * the fact is not a baseline." `baseline` is captured HERE, frozen into the
 * returned object, and nothing else in this codebase writes to it again —
 * `evaluate.ts` only ever produces a separate `outcome` + `verdict`.
 */

import type { Prescription, PrescriptionTargetType, DrillConfig } from "@/lib/types";
import type { TargetStat } from "./baseline";
import { resolveCorpus } from "@/lib/drills/targets";
import { DEFAULT_TARGET_RATIO } from "@/lib/drills/generate";
import { DEFAULT_DRILLS_TARGET, DEFAULT_DRILL_WORD_COUNT } from "./constants";

export class InsufficientBaselineError extends Error {
  constructor(targetType: PrescriptionTargetType, targets: string[], n: number) {
    super(
      `Cannot prescribe for ${targetType} [${targets.join(", ")}]: only n=${n} observations, ` +
        `below MIN_FINDING_N. A baseline measured on noise is not a baseline.`,
    );
    this.name = "InsufficientBaselineError";
  }
}

export type CreatePrescriptionInput = {
  reportId: string | null;
  targetType: PrescriptionTargetType;
  targets: string[];
  /** Must be `reportable` (n >= MIN_FINDING_N) — see extractFromCompactProfile
   *  / extractFromAnalyses in ./baseline.ts. Anything else throws rather than
   *  silently prescribing against noise. */
  baseline: TargetStat;
  drillsTarget?: number;
  wordCount?: number;
  /** Testability hooks. Production callers omit both. */
  now?: () => string;
  id?: () => string;
};

function buildDrillConfig(
  targetType: PrescriptionTargetType,
  targets: string[],
  wordCount: number,
): DrillConfig {
  return {
    wordCount,
    // NEVER taken from caller input. The over-targeting trap (PHASE-5.md) is
    // closed by making this a code-level guarantee, not a setting that could
    // be forgotten, overridden, or exposed as a UI toggle.
    targetRatio: DEFAULT_TARGET_RATIO,
    corpus: resolveCorpus(targetType, targets),
  };
}

/**
 * Mints a new active Prescription from a Finding-derived target and its
 * already-extracted baseline. Pure and synchronous — no I/O, no Supabase —
 * so the one invariant that matters most here (baseline in, baseline out,
 * unchanged) is trivial to unit test. See create.test.ts.
 */
export function createPrescription(input: CreatePrescriptionInput): Prescription {
  if (!input.baseline.reportable) {
    throw new InsufficientBaselineError(input.targetType, input.targets, input.baseline.n);
  }

  const nowFn = input.now ?? (() => new Date().toISOString());
  const idFn = input.id ?? (() => crypto.randomUUID());

  // A fresh object, not a reference into `input.baseline` — later mutation of
  // the caller's object must never be able to reach back into the
  // prescription. See create.test.ts "immune to later mutation."
  const baseline = Object.freeze({
    errorRate: input.baseline.errorRate,
    latencyP50: input.baseline.latencyP50,
    n: input.baseline.n,
  });

  return {
    id: idFn(),
    reportId: input.reportId,
    targetType: input.targetType,
    targets: [...input.targets],
    drillConfig: buildDrillConfig(
      input.targetType,
      input.targets,
      input.wordCount ?? DEFAULT_DRILL_WORD_COUNT,
    ),
    baseline,
    outcome: null,
    verdict: null,
    status: "active",
    drillsTarget: input.drillsTarget ?? DEFAULT_DRILLS_TARGET,
    drillsDone: 0,
    createdAt: nowFn(),
    completedAt: null,
  };
}
