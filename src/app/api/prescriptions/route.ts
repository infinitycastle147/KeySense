/**
 * List / create prescriptions — the closed loop's entry point
 * (docs/ARCHITECTURE.md §7, docs/phases/PHASE-5.md §2).
 *
 * POST mints a new prescription from one Finding on an existing report. The
 * baseline is extracted from that report's persisted `input_profile` — the
 * exact CompactProfile the model was shown — so the number a prescription
 * chases is provably the same number the diagnosis was based on.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/db/supabase/server";
import { listPrescriptions, insertPrescription } from "@/lib/prescriptions/store";
import { createPrescription, InsufficientBaselineError } from "@/lib/prescriptions/create";
import { extractFromCompactProfile } from "@/lib/prescriptions/baseline";
import { selectControlTargets } from "@/lib/prescriptions/control";
import type { CompactProfile } from "@/lib/ai/profile-input";
import type { Finding } from "@/lib/types";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { prescriptions, error } = await listPrescriptions(supabase);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ prescriptions });
}

type CreateBody = { reportId: string; findingId: string };

function isCreateBody(x: unknown): x is CreateBody {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Record<string, unknown>).reportId === "string" &&
    typeof (x as Record<string, unknown>).findingId === "string"
  );
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (!isCreateBody(body)) {
    return NextResponse.json({ error: "expected { reportId, findingId }" }, { status: 400 });
  }

  const { data: report, error: reportError } = await supabase
    .from("reports")
    .select("id, findings, input_profile")
    .eq("id", body.reportId)
    .single();

  if (reportError || !report) {
    return NextResponse.json({ error: "report not found" }, { status: 404 });
  }

  const findings = report.findings as Finding[];
  const finding = findings.find((f) => f.id === body.findingId);
  if (!finding) {
    return NextResponse.json({ error: "finding not found on that report" }, { status: 404 });
  }

  const compact = report.input_profile as CompactProfile;
  const baseline = extractFromCompactProfile(compact, finding.targetType, finding.targets);

  // The hold-out is drawn from the same profile, in the same moment, by the
  // same extractor as the treated baseline. Measuring it later, or from a
  // different window, would leave the two sides incomparable and make `lift`
  // meaningless. It is never returned to the client and never drilled.
  const controlTargets = selectControlTargets(compact, finding.targetType, finding.targets);
  const control =
    controlTargets.length > 0
      ? {
          targets: controlTargets,
          baseline: extractFromCompactProfile(compact, finding.targetType, controlTargets),
        }
      : undefined;

  let prescription;
  try {
    prescription = createPrescription({
      reportId: report.id as string,
      targetType: finding.targetType,
      targets: finding.targets,
      baseline,
      control,
    });
  } catch (err) {
    if (err instanceof InsufficientBaselineError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  const { prescription: saved, error: saveError } = await insertPrescription(
    supabase,
    user.id,
    prescription,
  );
  if (saveError || !saved) {
    return NextResponse.json({ error: saveError ?? "failed to save prescription" }, { status: 500 });
  }

  return NextResponse.json({ prescription: saved }, { status: 201 });
}
