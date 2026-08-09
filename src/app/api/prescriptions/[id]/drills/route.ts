/**
 * Records one completed drill session against a prescription
 * (docs/phases/PHASE-5.md §3): increments `drills_done`, and once the target
 * is met, runs `evaluate()` and closes the prescription out.
 *
 * The outcome window is the user's OVERALL typing after `createdAt` — not
 * just the drill sessions themselves. See src/lib/prescriptions/evaluate.ts
 * for why: measuring "did the drilled pattern get better" only inside
 * sessions specifically drilling that pattern would be circular.
 */

import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@/lib/db/supabase/server";
import { computeTestAnalysis } from "@/lib/analysis/profile";
import { parseLayout, type LayoutJson } from "@/lib/analysis/layout";
import { getPrescription, incrementDrillsDone, completePrescription } from "@/lib/prescriptions/store";
import { evaluate } from "@/lib/prescriptions/evaluate";
import type { CompletedTest, KeyEvent } from "@/lib/types";

const layoutCache = new Map<string, LayoutJson>();

async function loadLayout(name: string): Promise<LayoutJson> {
  const cached = layoutCache.get(name);
  if (cached) return cached;
  const file = path.join(process.cwd(), "public", "data", "layouts", `${name}.json`);
  const json = JSON.parse(await readFile(file, "utf8")) as LayoutJson;
  layoutCache.set(name, json);
  return json;
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { prescription, error: fetchError } = await getPrescription(supabase, id);
  if (fetchError || !prescription) {
    return NextResponse.json({ error: "prescription not found" }, { status: 404 });
  }
  if (prescription.status !== "active") {
    return NextResponse.json({ error: `prescription is ${prescription.status}, not active` }, { status: 409 });
  }

  const drillsDone = prescription.drillsDone + 1;
  const { prescription: incremented, error: incError } = await incrementDrillsDone(
    supabase,
    id,
    drillsDone,
  );
  if (incError || !incremented) {
    return NextResponse.json({ error: incError ?? "failed to record drill" }, { status: 500 });
  }

  if (drillsDone < incremented.drillsTarget) {
    return NextResponse.json({ prescription: incremented, evaluated: false });
  }

  // Target met — evaluate against everything typed since createdAt.
  const { data: tests, error: testsError } = await supabase
    .from("tests")
    .select("*")
    .gt("ended_at", incremented.createdAt)
    .order("ended_at", { ascending: true });

  if (testsError) return NextResponse.json({ error: testsError.message }, { status: 500 });

  const { data: eventRows, error: eventsError } = await supabase
    .from("test_events")
    .select("test_id, events")
    .in("test_id", (tests ?? []).map((t) => t.id as string));

  if (eventsError) return NextResponse.json({ error: eventsError.message }, { status: 500 });

  const eventsByTest = new Map<string, KeyEvent[]>(
    (eventRows ?? []).map((r) => [r.test_id as string, r.events as KeyEvent[]]),
  );

  const analyses = [];
  for (const row of tests ?? []) {
    const events = eventsByTest.get(row.id as string);
    if (!events) continue;
    const test: CompletedTest = {
      id: row.id as string,
      startedAt: row.started_at as string,
      endedAt: row.ended_at as string,
      durationMs: row.duration_ms as number,
      config: {
        mode: row.mode,
        modeSetting: row.mode_setting ?? "",
        language: row.language as string,
        layout: row.layout as string,
        punctuation: Boolean(row.punctuation),
        numbers: Boolean(row.numbers),
      },
      result: {
        wpm: Number(row.wpm),
        rawWpm: Number(row.raw_wpm),
        accuracy: Number(row.accuracy),
        consistency: Number(row.consistency ?? 0),
        charsCorrect: row.chars_correct as number,
        charsIncorrect: row.chars_incorrect as number,
        charsExtra: row.chars_extra as number,
        charsMissed: row.chars_missed as number,
      },
      events,
      source: row.source,
      prescriptionId: (row.prescription_id as string | null) ?? null,
      deviceId: (row.device_id as string | null) ?? "",
      appVersion: (row.app_version as string | null) ?? "",
      syncedAt: null,
    };
    const layout = parseLayout(await loadLayout(test.config.layout));
    analyses.push(computeTestAnalysis(test, layout));
  }

  const result = evaluate(incremented, analyses);

  if (!result.ok) {
    // Drills done, but not enough subsequent typing yet to say anything
    // honest — stays active until there's enough signal. Re-running this
    // route (e.g. after the next freeplay test) will try again.
    return NextResponse.json({
      prescription: incremented,
      evaluated: false,
      reason: "insufficient-n",
      n: result.n,
    });
  }

  const { prescription: completed, error: completeError } = await completePrescription(
    supabase,
    id,
    result.outcome,
    result.verdict,
    new Date().toISOString(),
  );
  if (completeError || !completed) {
    return NextResponse.json({ error: completeError ?? "failed to complete prescription" }, { status: 500 });
  }

  return NextResponse.json({ prescription: completed, evaluated: true, verdict: result.verdict });
}
