"use client";

/**
 * Dashboard data pipeline: reads the local test history, runs every Part-A
 * metric over the window, and pools it into a `MetricProfile` — the same
 * pure functions the LLM narration will consume in Phase 4/5. This is a
 * client component because the source of truth right now is IndexedDB
 * (`src/lib/db/local.ts`), which only exists in the browser.
 *
 * Structure follows docs/DESIGN.md §4: stacked horizontal strips on a shared
 * time axis, not a card grid.
 */

import { useEffect, useMemo, useState } from "react";
import { getAllTests } from "@/lib/db/local";
import { parseLayout, type LayoutIndex, type LayoutJson } from "@/lib/analysis/layout";
import { computeTestAnalysis, buildMetricProfile, type TestAnalysis } from "@/lib/analysis/profile";
import { MIN_FINDING_N, median } from "@/lib/analysis/stats";
import type { CompletedTest, Finger, MetricProfile } from "@/lib/types";
import { Strip } from "@/components/dashboard/Strip";
import { KeyHeatmap } from "@/components/dashboard/KeyHeatmap";
import { BigramTable } from "@/components/dashboard/BigramTable";
import { Skeleton } from "@/components/ui/skeleton";

/** Findings only emerge pooled across ~20-50 tests (docs/ARCHITECTURE.md §5.2). */
const WINDOW_SIZE = 50;

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tests: CompletedTest[]; layouts: Map<string, LayoutJson> };

function formatFingerLabel(finger: Finger): string {
  if (finger === "thumb") return "thumb";
  const [side, part] = finger.split("-");
  return `${side === "l" ? "left" : "right"} ${part}`;
}

/** Robust, non-parametric trend: median of the second half of the window
 *  against the median of the first half. Reuses `median` from stats.ts
 *  rather than a raw mean, per the "never a raw mean" rule. */
function recentVsEarlierDelta(series: (number | null | undefined)[]): number | null {
  const valid = series.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (valid.length < 6) return null;
  const mid = Math.floor(valid.length / 2);
  return median(valid.slice(mid)) - median(valid.slice(0, mid));
}

function daySpan(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));
}

export function DashboardClient() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const tests = await getAllTests();
        const layoutNames = Array.from(new Set(tests.map((t) => t.config.layout))).filter(Boolean);
        // Always have a fallback grid to draw the heatmap against, even with no tests yet.
        if (!layoutNames.includes("qwerty")) layoutNames.push("qwerty");

        const entries = await Promise.all(
          layoutNames.map(async (name) => {
            const res = await fetch(`/data/layouts/${name}.json`);
            if (!res.ok) throw new Error(`Could not load layout "${name}" (${res.status})`);
            const json = (await res.json()) as LayoutJson;
            return [name, json] as const;
          })
        );

        if (cancelled) return;
        setState({ status: "ready", tests, layouts: new Map(entries) });
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Could not load test history.",
          });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const layoutIndexes = useMemo(() => {
    if (state.status !== "ready") return new Map<string, LayoutIndex>();
    const map = new Map<string, LayoutIndex>();
    for (const [name, json] of state.layouts) map.set(name, parseLayout(json));
    return map;
  }, [state]);

  const data = useMemo(() => {
    if (state.status !== "ready") return null;

    const sortedAsc = [...state.tests].sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    const currentTests = sortedAsc.slice(-WINDOW_SIZE);
    const priorTests = sortedAsc.slice(-WINDOW_SIZE * 2, -WINDOW_SIZE);

    function analyze(tests: CompletedTest[]): TestAnalysis[] {
      return tests.map((t) => {
        const layout = layoutIndexes.get(t.config.layout) ?? layoutIndexes.get("qwerty");
        // A test recorded under a layout we failed to fetch still contributes
        // its result/rhythm data; only layout-derived stats (fingers/SFBs)
        // come back empty for it rather than the whole test being dropped.
        return layout
          ? computeTestAnalysis(t, layout)
          : computeTestAnalysis(t, parseLayout({ keymapShowTopRow: false, type: "ansi", keys: {} }));
      });
    }

    const analyses = analyze(currentTests);
    const previousAnalyses = analyze(priorTests);

    const profile = buildMetricProfile(analyses, {
      topN: 60,
      previousWindow: previousAnalyses.length > 0 ? previousAnalyses : undefined,
    });

    const wpmSeries = analyses.map((a) => a.result.wpm);
    const accuracySeries = analyses.map((a) => a.result.accuracy * 100);

    const worstFinger = profile.fingers
      .filter((f) => f.n >= MIN_FINDING_N)
      .sort((a, b) => b.relativeLatency - a.relativeLatency)[0];
    const fingerSeries = worstFinger
      ? analyses.map((a) => {
          const fs = a.fingerStats.find((f) => f.finger === worstFinger.finger);
          return fs && fs.n > 0 ? fs.relativeLatency : null;
        })
      : [];

    const worstBigram = profile.bigramStats[0];
    const bigramSeries = worstBigram
      ? analyses.map((a) => {
          const bs = a.bigramStats.find((b) => b.bigram === worstBigram.bigram);
          return bs && bs.n > 0 ? bs.latencyP50 : null;
        })
      : [];

    const rangeLabel = analyses.length > 0 ? `${daySpan(profile.windowStart, profile.windowEnd)}d` : "—";
    const canonicalLayoutName = currentTests[currentTests.length - 1]?.config.layout ?? "qwerty";
    const canonicalLayoutJson = state.layouts.get(canonicalLayoutName) ?? state.layouts.get("qwerty");

    return {
      analyses,
      profile,
      wpmSeries,
      accuracySeries,
      worstFinger,
      fingerSeries,
      worstBigram,
      bigramSeries,
      rangeLabel,
      canonicalLayoutJson,
    };
  }, [state, layoutIndexes]);

  if (state.status === "loading") {
    return (
      <div className="flex w-full flex-col gap-3" aria-busy="true" aria-live="polite">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="text-sm text-flag">
        {state.message} — reload to retry.
      </p>
    );
  }

  if (state.tests.length === 0 || !data || data.analyses.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No tests yet. Run a 60-second test to establish a baseline.
      </p>
    );
  }

  const { profile, worstFinger, worstBigram, canonicalLayoutJson } = data;
  const hasTrend = previousExists(profile);

  const strips: {
    key: string;
    label: string;
    series: number[];
    current: number | null;
    delta: number | null;
    n: number;
    reportable: boolean;
    unit?: string;
    decimals: number;
    goodDirection: "up" | "down";
  }[] = [
    {
      key: "wpm",
      label: "wpm",
      series: data.wpmSeries,
      current: profile.overall.wpm.n > 0 ? profile.overall.wpm.value : null,
      delta: hasTrend ? profile.trend.wpmDelta : null,
      n: profile.overall.wpm.n,
      reportable: profile.overall.wpm.reportable,
      decimals: 0,
      goodDirection: "up",
    },
    {
      key: "accuracy",
      label: "accuracy",
      series: data.accuracySeries,
      current: profile.overall.accuracy.n > 0 ? profile.overall.accuracy.value * 100 : null,
      delta: hasTrend ? profile.trend.accuracyDelta * 100 : null,
      n: profile.overall.accuracy.n,
      reportable: profile.overall.accuracy.reportable,
      unit: "%",
      decimals: 1,
      goodDirection: "up",
    },
  ];

  return (
    <div className="flex w-full max-w-4xl flex-col gap-10">
      <header className="flex flex-col gap-1">
        <h1 className="font-[family-name:var(--font-display)] text-[2.5rem] leading-none">dashboard</h1>
        <p className="label-type text-muted-foreground">
          {profile.testCount} tests · {data.rangeLabel}
        </p>
      </header>

      <section aria-label="Trends over time" className="rounded-md bg-chassis px-4 ring-1 ring-grid">
        {strips.map((s, i) => (
          <div key={s.key} className="animate-in fade-in duration-300" style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}>
            <Strip
              label={s.label}
              rangeLabel={data.rangeLabel}
              series={s.series}
              current={s.current}
              delta={s.delta}
              n={s.n}
              reportable={s.reportable}
              unit={s.unit}
              decimals={s.decimals}
              goodDirection={s.goodDirection}
            />
          </div>
        ))}

        {worstFinger ? (
          <div
            className="animate-in fade-in duration-300"
            style={{ animationDelay: `${strips.length * 40}ms`, animationFillMode: "backwards" }}
          >
            <Strip
              label={formatFingerLabel(worstFinger.finger)}
              rangeLabel={data.rangeLabel}
              series={data.fingerSeries}
              current={worstFinger.relativeLatency}
              delta={recentVsEarlierDelta(data.fingerSeries)}
              n={worstFinger.n}
              reportable
              unit="×"
              decimals={2}
              goodDirection="down"
            />
          </div>
        ) : (
          <p className="label-type py-5 text-muted-foreground">
            no finger reaches n=30 in this window yet
          </p>
        )}

        {worstBigram ? (
          <div
            className="animate-in fade-in duration-300"
            style={{ animationDelay: `${(strips.length + 1) * 40}ms`, animationFillMode: "backwards" }}
          >
            <Strip
              label={`worst transition: ${worstBigram.bigram}`}
              rangeLabel={data.rangeLabel}
              series={data.bigramSeries}
              current={worstBigram.latencyP50}
              delta={recentVsEarlierDelta(data.bigramSeries)}
              n={worstBigram.n}
              reportable
              unit="ms"
              decimals={0}
              goodDirection="down"
            />
          </div>
        ) : (
          <p className="label-type py-5 text-muted-foreground">
            no bigram reaches n=30 in this window yet
          </p>
        )}
      </section>

      <section aria-label="Per-key latency and error rate" className="flex flex-col gap-3">
        <h2 className="label-type text-muted-foreground">per-key latency &amp; error rate</h2>
        {canonicalLayoutJson ? (
          <div className="w-full overflow-x-auto rounded-md bg-chassis p-4 ring-1 ring-grid">
            <KeyHeatmap keyStats={profile.keyStats} layout={canonicalLayoutJson} />
          </div>
        ) : (
          <p className="label-type text-muted-foreground">layout data unavailable</p>
        )}
      </section>

      <section aria-label="Worst transitions" className="flex flex-col gap-3">
        <h2 className="label-type text-muted-foreground">worst transitions</h2>
        <div className="rounded-md bg-chassis p-4 ring-1 ring-grid">
          <BigramTable bigrams={profile.bigramStats} />
        </div>
      </section>
    </div>
  );
}

/** `buildMetricProfile` zeroes `trend` when no previous window was supplied
 *  (early in a user's history there may not be one) — that zero is not a
 *  real "no change" delta, so the strip should show "n/a" instead. */
function previousExists(profile: MetricProfile): boolean {
  return profile.trend.comparedToDays !== 0 || profile.trend.wpmDelta !== 0 || profile.trend.accuracyDelta !== 0;
}
