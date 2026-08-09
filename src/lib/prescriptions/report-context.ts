/**
 * Summarises a user's prescriptions into the small, pre-computed shape the
 * report prompt is allowed to open with — docs/ARCHITECTURE.md §7: "Every
 * report then opens with the previous cycle's result." Same rule as the rest
 * of the AI layer (§5.1): only numbers already computed elsewhere are handed
 * to the model, nothing it could confuse for an invitation to invent one.
 */

import type { Prescription, PrescriptionTargetType, PrescriptionVerdict } from "@/lib/types";

export type CompletedPrescriptionSummary = {
  targetType: PrescriptionTargetType;
  targets: string[];
  verdict: PrescriptionVerdict;
  baselineErrorRate: number;
  outcomeErrorRate: number;
  drillsCompleted: number;
  completedAt: string;
};

export type ActivePrescriptionSummary = {
  targetType: PrescriptionTargetType;
  targets: string[];
  drillsDone: number;
  drillsTarget: number;
};

export type PrescriptionReportContext = {
  /** The most recently completed cycle, if any — this is what the report
   *  opens with. Only one: PHASE-5.md's example narrates a single "last
   *  cycle," not a backlog of every prescription ever resolved. */
  lastCompleted: CompletedPrescriptionSummary | null;
  active: ActivePrescriptionSummary[];
};

function isCompleted(
  p: Prescription,
): p is Prescription & {
  outcome: NonNullable<Prescription["outcome"]>;
  verdict: PrescriptionVerdict;
  completedAt: string;
} {
  return p.status === "completed" && p.outcome !== null && p.verdict !== null && p.completedAt !== null;
}

export function buildPrescriptionReportContext(prescriptions: Prescription[]): PrescriptionReportContext {
  const completed = prescriptions
    .filter(isCompleted)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

  const mostRecent = completed[0];
  const lastCompleted: CompletedPrescriptionSummary | null = mostRecent
    ? {
        targetType: mostRecent.targetType,
        targets: mostRecent.targets,
        verdict: mostRecent.verdict,
        baselineErrorRate: mostRecent.baseline.errorRate,
        outcomeErrorRate: mostRecent.outcome.errorRate,
        drillsCompleted: mostRecent.drillsDone,
        completedAt: mostRecent.completedAt,
      }
    : null;

  const active: ActivePrescriptionSummary[] = prescriptions
    .filter((p) => p.status === "active")
    .map((p) => ({
      targetType: p.targetType,
      targets: p.targets,
      drillsDone: p.drillsDone,
      drillsTarget: p.drillsTarget,
    }));

  return { lastCompleted, active };
}
