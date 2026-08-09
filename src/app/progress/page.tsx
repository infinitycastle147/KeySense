/**
 * Progress — PHASE-5.md §5. Server component: fetches headline stats and
 * prescriptions directly (RLS-scoped, mirrors src/app/history/page.tsx),
 * then hands them to the client orchestrator for the interactive parts
 * (starting a drill). Proxy already redirects signed-out visitors to
 * /login; the check below is a defensive backstop, not the primary gate.
 */

import { redirect } from "next/navigation";
import { createClient } from "@/lib/db/supabase/server";
import { listPrescriptions } from "@/lib/prescriptions/store";
import { median } from "@/lib/analysis/stats";
import { ProgressClient, type WeeklySeries } from "@/components/prescriptions/ProgressClient";

export const dynamic = "force-dynamic";

type TestRow = { started_at: string; wpm: number; accuracy: number };

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Buckets tests into calendar weeks (relative to the earliest test) and
 *  takes the median wpm/accuracy per week — never a raw mean, matching every
 *  other trend in this codebase (docs/ARCHITECTURE.md §5.3). */
function bucketWeekly(rows: TestRow[]): WeeklySeries {
  if (rows.length === 0) {
    return {
      rangeLabel: "—",
      labels: [],
      wpm: [],
      accuracy: [],
      currentWpm: null,
      currentAccuracy: null,
      wpmDelta: null,
      accuracyDelta: null,
      testCount: 0,
    };
  }

  const sorted = [...rows].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const start = new Date(sorted[0].started_at).getTime();
  const end = new Date(sorted[sorted.length - 1].started_at).getTime();
  const weekCount = Math.max(1, Math.ceil((end - start) / MS_PER_WEEK) + 1);

  const buckets: { wpm: number[]; accuracy: number[] }[] = Array.from({ length: weekCount }, () => ({
    wpm: [],
    accuracy: [],
  }));

  for (const row of sorted) {
    const t = new Date(row.started_at).getTime();
    const idx = Math.min(weekCount - 1, Math.floor((t - start) / MS_PER_WEEK));
    buckets[idx].wpm.push(Number(row.wpm));
    buckets[idx].accuracy.push(Number(row.accuracy) * 100);
  }

  const wpmSeries = buckets.map((b) => (b.wpm.length > 0 ? median(b.wpm) : null));
  const accuracySeries = buckets.map((b) => (b.accuracy.length > 0 ? median(b.accuracy) : null));

  const currentWpm = wpmSeries[wpmSeries.length - 1];
  const currentAccuracy = accuracySeries[accuracySeries.length - 1];

  // Robust trend: second half vs first half of the window, same approach as
  // src/components/dashboard/DashboardClient.tsx's recentVsEarlierDelta.
  function halfDelta(series: (number | null)[]): number | null {
    const valid = series.filter((v): v is number => v !== null);
    if (valid.length < 4) return null;
    const mid = Math.floor(valid.length / 2);
    return median(valid.slice(mid)) - median(valid.slice(0, mid));
  }

  const days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));

  return {
    rangeLabel: `${days}d`,
    labels: buckets.map((_, i) => `w${i + 1}`),
    wpm: wpmSeries,
    accuracy: accuracySeries,
    currentWpm,
    currentAccuracy,
    wpmDelta: halfDelta(wpmSeries),
    accuracyDelta: halfDelta(accuracySeries),
    testCount: rows.length,
  };
}

export default async function ProgressPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: tests }, { prescriptions }] = await Promise.all([
    supabase.from("tests").select("started_at, wpm, accuracy").order("started_at", { ascending: true }),
    listPrescriptions(supabase),
  ]);

  const weekly = bucketWeekly((tests ?? []) as TestRow[]);

  return <ProgressClient initialPrescriptions={prescriptions} weekly={weekly} />;
}
