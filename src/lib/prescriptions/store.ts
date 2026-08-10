/**
 * Supabase I/O for prescriptions — the one place this module talks to the
 * `prescriptions` table (supabase/migrations/0001_init.sql). Row <-> domain
 * type mapping lives here so every route handler reads/writes the same
 * shape instead of re-deriving column names.
 *
 * Deliberately takes a `SupabaseClient` as a parameter rather than creating
 * its own — callers pick server.ts (RLS-scoped, the default) or admin.ts as
 * appropriate, matching the pattern in CLAUDE.md's Supabase clients table.
 * No `server-only` guard: unlike src/lib/ai/client.ts, nothing here touches
 * an API key — RLS is what protects this data, the same reasoning
 * db/supabase/client.ts documents for the publishable key.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Prescription,
  PrescriptionControl,
  PrescriptionTargetType,
  PrescriptionVerdict,
  TargetMeasurement,
  DrillConfig,
} from "@/lib/types";

type PrescriptionRow = {
  id: string;
  user_id: string;
  report_id: string | null;
  target_type: string;
  targets: string[];
  drill_config: DrillConfig;
  baseline: TargetMeasurement;
  outcome: TargetMeasurement | null;
  /** Absent or null for rows created before 0004_prescription_controls.sql —
   *  optional rather than nullable so a `select` predating the column still
   *  maps cleanly instead of failing to type-check against reality. */
  control?: PrescriptionControl | null;
  verdict: string | null;
  status: string;
  drills_target: number;
  drills_done: number;
  created_at: string;
  completed_at: string | null;
};

export function rowToPrescription(row: PrescriptionRow): Prescription {
  return {
    id: row.id,
    reportId: row.report_id,
    targetType: row.target_type as PrescriptionTargetType,
    targets: row.targets,
    drillConfig: row.drill_config,
    baseline: row.baseline,
    outcome: row.outcome,
    control: row.control ?? null,
    verdict: row.verdict as PrescriptionVerdict | null,
    status: row.status as Prescription["status"],
    drillsTarget: row.drills_target,
    drillsDone: row.drills_done,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** Insert payload for a freshly created prescription. `baseline` — and the
 *  `baseline` inside `control` — is written once, here, and no function in
 *  this module ever updates it again. See create.ts and CLAUDE.md invariant 6. */
export function prescriptionToInsertRow(userId: string, rx: Prescription) {
  return {
    id: rx.id,
    user_id: userId,
    report_id: rx.reportId,
    target_type: rx.targetType,
    targets: rx.targets,
    drill_config: rx.drillConfig,
    baseline: rx.baseline,
    control: rx.control,
    status: rx.status,
    drills_target: rx.drillsTarget,
    drills_done: rx.drillsDone,
    created_at: rx.createdAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase's generic client type without generated Database types
type AnySupabaseClient = SupabaseClient<any, any, any>;

export async function listPrescriptions(
  supabase: AnySupabaseClient,
): Promise<{ prescriptions: Prescription[]; error: string | null }> {
  const { data, error } = await supabase
    .from("prescriptions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return { prescriptions: [], error: error.message };
  return { prescriptions: (data as PrescriptionRow[]).map(rowToPrescription), error: null };
}

export async function insertPrescription(
  supabase: AnySupabaseClient,
  userId: string,
  rx: Prescription,
): Promise<{ prescription: Prescription | null; error: string | null }> {
  const { data, error } = await supabase
    .from("prescriptions")
    .insert(prescriptionToInsertRow(userId, rx))
    .select()
    .single();

  if (error) return { prescription: null, error: error.message };
  return { prescription: rowToPrescription(data as PrescriptionRow), error: null };
}

export async function getPrescription(
  supabase: AnySupabaseClient,
  id: string,
): Promise<{ prescription: Prescription | null; error: string | null }> {
  const { data, error } = await supabase.from("prescriptions").select("*").eq("id", id).single();
  if (error) return { prescription: null, error: error.message };
  return { prescription: rowToPrescription(data as PrescriptionRow), error: null };
}

/** Bumps `drills_done` by one. Never touches `baseline`. */
export async function incrementDrillsDone(
  supabase: AnySupabaseClient,
  id: string,
  drillsDone: number,
): Promise<{ prescription: Prescription | null; error: string | null }> {
  const { data, error } = await supabase
    .from("prescriptions")
    .update({ drills_done: drillsDone })
    .eq("id", id)
    .select()
    .single();

  if (error) return { prescription: null, error: error.message };
  return { prescription: rowToPrescription(data as PrescriptionRow), error: null };
}

/**
 * Attaches a measured outcome to an existing control without touching its
 * baseline. `control` is a single JSONB column, so writing it back means
 * rewriting the whole object — this is the one place that happens, and it
 * carries `control.baseline` through by reference precisely so no update path
 * can quietly re-derive it. Returns null unchanged when there is no control.
 */
export function withControlOutcome(
  control: PrescriptionControl | null,
  outcome: TargetMeasurement | null,
): PrescriptionControl | null {
  if (!control) return null;
  return { targets: control.targets, baseline: control.baseline, outcome };
}

/** Records the outcome of `evaluate()` and closes out the prescription.
 *  `baseline` is intentionally absent from this update — see CLAUDE.md
 *  invariant 6. `control` is written only via `withControlOutcome`, which
 *  preserves the control's own frozen baseline for the same reason. */
export async function completePrescription(
  supabase: AnySupabaseClient,
  id: string,
  outcome: TargetMeasurement,
  verdict: PrescriptionVerdict,
  completedAt: string,
  control?: PrescriptionControl | null,
): Promise<{ prescription: Prescription | null; error: string | null }> {
  const { data, error } = await supabase
    .from("prescriptions")
    .update({
      outcome,
      verdict,
      status: "completed",
      completed_at: completedAt,
      // Omitted entirely when undefined, so an uncontrolled completion path
      // cannot null out a control that is already stored.
      ...(control !== undefined ? { control } : {}),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return { prescription: null, error: error.message };
  return { prescription: rowToPrescription(data as PrescriptionRow), error: null };
}
