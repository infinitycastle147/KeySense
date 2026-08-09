/**
 * Generates a rolling diagnosis over the user's recent tests.
 *
 * Deliberately on-demand rather than per-test: a single 30-second test contains
 * one to three occurrences of any given bigram, which is noise. Findings only
 * become honest across a window (docs/ARCHITECTURE.md §5.2).
 */

import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@/lib/db/supabase/server";
import { computeTestAnalysis, buildMetricProfile } from "@/lib/analysis/profile";
import { parseLayout, type LayoutJson } from "@/lib/analysis/layout";
import { MIN_FINDING_N } from "@/lib/analysis/stats";
import { buildCompactProfile } from "@/lib/ai/profile-input";
import { generateReport, HallucinationError } from "@/lib/ai/client";
import { MIN_TESTS_FOR_REPORT } from "@/lib/ai/model";
import type { CompletedTest, KeyEvent } from "@/lib/types";

const WINDOW_SIZE = 50;

const layoutCache = new Map<string, LayoutJson>();

async function loadLayout(name: string): Promise<LayoutJson> {
  const cached = layoutCache.get(name);
  if (cached) return cached;
  const file = path.join(process.cwd(), "public", "data", "layouts", `${name}.json`);
  const json = JSON.parse(await readFile(file, "utf8")) as LayoutJson;
  layoutCache.set(name, json);
  return json;
}

export async function POST() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const { data: tests, error: testsError } = await supabase
    .from("tests")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(WINDOW_SIZE);

  if (testsError) {
    return NextResponse.json({ error: testsError.message }, { status: 500 });
  }

  // An honest refusal beats a fabricated diagnosis. Findings computed from a
  // handful of tests would look identical to real ones.
  if (!tests || tests.length < MIN_TESTS_FOR_REPORT) {
    return NextResponse.json(
      {
        error: "not enough data yet",
        detail: `Diagnosis needs at least ${MIN_TESTS_FOR_REPORT} tests; you have ${tests?.length ?? 0}. Findings drawn from fewer would be noise reported as signal.`,
        testsNeeded: MIN_TESTS_FOR_REPORT - (tests?.length ?? 0),
      },
      { status: 422 },
    );
  }

  const { data: eventRows, error: eventsError } = await supabase
    .from("test_events")
    .select("test_id, events")
    .in(
      "test_id",
      tests.map((t) => t.id),
    );

  if (eventsError) {
    return NextResponse.json({ error: eventsError.message }, { status: 500 });
  }

  const eventsByTest = new Map<string, KeyEvent[]>(
    (eventRows ?? []).map((r) => [r.test_id as string, r.events as KeyEvent[]]),
  );

  const analyses = [];
  for (const row of tests) {
    const events = eventsByTest.get(row.id as string);
    if (!events) continue; // events not yet synced — skip rather than guess

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

  if (analyses.length === 0) {
    return NextResponse.json(
      { error: "no test events available for this window" },
      { status: 422 },
    );
  }

  const profile = buildMetricProfile(analyses);
  const compact = buildCompactProfile(profile, MIN_FINDING_N);

  try {
    const generated = await generateReport(compact);

    const { data: saved, error: saveError } = await supabase
      .from("reports")
      .insert({
        user_id: user.id,
        window_start: profile.windowStart,
        window_end: profile.windowEnd,
        findings: generated.report.findings,
        prose: generated.report.summary,
        model: generated.model,
        prompt_version: generated.promptVersion,
        // The exact numbers the model was given. Without this a finding cannot
        // be audited after the fact.
        input_profile: compact,
      })
      .select()
      .single();

    if (saveError) {
      return NextResponse.json({ error: saveError.message }, { status: 500 });
    }

    return NextResponse.json({
      id: saved.id,
      source: generated.source,
      summary: generated.report.summary,
      findings: generated.report.findings,
      model: generated.model,
      promptVersion: generated.promptVersion,
      windowStart: profile.windowStart,
      windowEnd: profile.windowEnd,
      testCount: profile.testCount,
    });
  } catch (err) {
    if (err instanceof HallucinationError) {
      // Surfaced, never silently swapped for a fixture — a live call that
      // invents numbers is a real failure and must be visible.
      return NextResponse.json(
        { error: "model cited figures absent from the profile", detail: err.details },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "report generation failed" },
      { status: 500 },
    );
  }
}
