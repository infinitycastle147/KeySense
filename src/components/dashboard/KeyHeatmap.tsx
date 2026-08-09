/**
 * Per-key latency/error heatmap over the physical layout (PHASE-3 §7).
 *
 * Two channels, kept inside the palette rules (docs/DESIGN.md §2 — amber is
 * spent on the trace and primary actions only, not decoration): a key's
 * *fill* darkens with how slow it is relative to the other keys shown (a
 * neutral chassis->foreground tint, the same `color-mix` technique already
 * used for hover states in `components/ui/button.tsx`), and its *ring* turns
 * `flag` only when its error rate is meaningfully elevated. Keys below
 * `MIN_FINDING_N` render as outline-only "no data" cells rather than a
 * fabricated colour — the same n>=30 gate the rest of the product uses.
 */

"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { KeyStat } from "@/lib/types";
import type { LayoutJson } from "@/lib/analysis/layout";
import { MIN_FINDING_N } from "@/lib/analysis/stats";
import { cn } from "@/lib/utils";

type KeyHeatmapProps = {
  keyStats: KeyStat[];
  layout: LayoutJson;
  className?: string;
};

const ROWS = ["row1", "row2", "row3", "row4"] as const;

function mergeVariants(a: KeyStat | undefined, b: KeyStat | undefined): KeyStat | undefined {
  if (!a) return b;
  if (!b) return a;
  const n = a.n + b.n;
  const errors = a.errors + b.errors;
  return {
    key: a.key,
    n,
    errors,
    errorRate: n > 0 ? errors / n : 0,
    errorRateCI: a.errorRateCI, // display-only merge; not re-derived for the pair
    latencyP50: n > 0 ? (a.latencyP50 * a.n + b.latencyP50 * b.n) / n : 0,
    latencyP90: n > 0 ? (a.latencyP90 * a.n + b.latencyP90 * b.n) / n : 0,
  };
}

export function KeyHeatmap({ keyStats, layout, className }: KeyHeatmapProps) {
  const byChar = new Map<string, KeyStat>();
  for (const ks of keyStats) byChar.set(ks.key, ks);

  const rows = ROWS.map((rowName) => layout.keys[rowName] ?? []);

  const resolved = rows.map((row) =>
    row.map((entry) => {
      const lower = entry[0];
      const upper = entry.length > 1 ? entry[1] : undefined;
      const rawStat = mergeVariants(byChar.get(lower), upper ? byChar.get(upper) : undefined);
      const stat = rawStat && rawStat.n >= MIN_FINDING_N ? rawStat : undefined;
      return { lower, stat, rawStat };
    })
  );

  const latencies = resolved.flat().filter((c) => c.stat).map((c) => c.stat!.latencyP50);
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const errorRates = resolved.flat().filter((c) => c.stat).map((c) => c.stat!.errorRate);
  const medianErrorRate = errorRates.length
    ? [...errorRates].sort((a, b) => a - b)[Math.floor(errorRates.length / 2)]
    : 0;

  function latencyRank(v: number): number {
    if (sortedLatencies.length <= 1) return 0.5;
    const idx = sortedLatencies.findIndex((x) => x >= v);
    return (idx < 0 ? sortedLatencies.length - 1 : idx) / (sortedLatencies.length - 1);
  }

  return (
    <TooltipProvider>
      <div className={cn("flex flex-col items-start gap-1.5", className)}>
        {resolved.map((row, ri) => (
          <div key={ROWS[ri]} className="flex gap-1.5" style={{ paddingLeft: `${ri * 0.75}rem` }}>
            {row.map(({ lower, stat, rawStat }) => {
              const elevated = stat ? stat.errorRate > medianErrorRate * 1.5 && stat.errorRate > 0.02 : false;
              const pct = stat ? Math.round(latencyRank(stat.latencyP50) * 55) : 0;
              const display = lower === " " ? "␣" : lower;
              const tooltipText = stat
                ? `${display} · p50 ${stat.latencyP50.toFixed(0)}ms · ${(stat.errorRate * 100).toFixed(1)}% err · n=${stat.n}`
                : `${display} · ${rawStat ? `n=${rawStat.n} (below n=30)` : "no data"}`;

              return (
                <Tooltip key={lower}>
                  <TooltipTrigger
                    aria-label={tooltipText}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-[3px] border-0 text-xs font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-trace",
                      stat ? "ring-1 ring-grid" : "text-muted-foreground/40 ring-1 ring-grid/60"
                    )}
                    style={
                      stat
                        ? {
                            backgroundColor: `color-mix(in oklch, var(--chassis), var(--foreground) ${pct}%)`,
                            boxShadow: elevated ? "inset 0 0 0 2px var(--flag)" : undefined,
                          }
                        : { backgroundColor: "var(--chassis)" }
                    }
                  >
                    {display}
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="label-type normal-case">{tooltipText}</span>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}
