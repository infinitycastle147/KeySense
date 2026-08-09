/**
 * Worst transitions, sortable, with confidence intervals shown (PHASE-3 §7).
 * Bigrams are "the highest-value metric" (docs/ARCHITECTURE.md §5.4) —
 * weakness lives in transitions, not individual keys. No table primitive is
 * installed in components/ui/, and adding one is outside this task's file
 * boundary, so this is a plain table styled to match the instrument look.
 */

"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { BigramStat } from "@/lib/types";
import { cn } from "@/lib/utils";

type BigramTableProps = {
  bigrams: BigramStat[];
  className?: string;
};

type SortKey = "errorRate" | "latencyP50" | "n";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "errorRate", label: "error rate" },
  { key: "latencyP50", label: "p50 latency" },
  { key: "n", label: "n" },
];

export function BigramTable({ bigrams, className }: BigramTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("errorRate");
  const [descending, setDescending] = useState(true);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setDescending((d) => !d);
    } else {
      setSortKey(key);
      setDescending(true);
    }
  }

  const sorted = [...bigrams].sort((a, b) => {
    const diff = a[sortKey] - b[sortKey];
    return descending ? -diff : diff;
  });

  if (sorted.length === 0) {
    return (
      <p className={cn("label-type text-muted-foreground", className)}>
        not enough data yet — bigrams need n≥30 across this window
      </p>
    );
  }

  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full min-w-[36rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-grid">
            <th className="label-type py-2 pr-3 font-normal text-muted-foreground">bigram</th>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className="label-type py-2 pr-3 font-normal text-muted-foreground"
                aria-sort={sortKey === col.key ? (descending ? "descending" : "ascending") : "none"}
              >
                <button
                  type="button"
                  onClick={() => toggleSort(col.key)}
                  className="inline-flex items-center gap-1 outline-none hover:text-foreground focus-visible:text-trace"
                >
                  {col.label}
                  {sortKey === col.key && <span aria-hidden="true">{descending ? "▼" : "▲"}</span>}
                </button>
              </th>
            ))}
            <th className="label-type py-2 pr-3 font-normal text-muted-foreground">same finger</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((b) => (
            <tr key={b.bigram} className="border-b border-grid/60 last:border-b-0">
              <td className="py-2 pr-3 font-[family-name:var(--font-type)] text-sm">{b.bigram}</td>
              <td className="py-2 pr-3 text-sm tabular-nums">
                {(b.errorRate * 100).toFixed(1)}%{" "}
                <span className="label-type text-muted-foreground">
                  ({(b.errorRateCI.low * 100).toFixed(1)}–{(b.errorRateCI.high * 100).toFixed(1)})
                </span>
              </td>
              <td className="py-2 pr-3 text-sm tabular-nums">{b.latencyP50.toFixed(0)}ms</td>
              <td className="py-2 pr-3 text-sm tabular-nums text-muted-foreground">n={b.n}</td>
              <td className="py-2 pr-3">
                {b.sameFinger && (
                  <Badge variant="outline" className="border-flag/50 text-flag">
                    SFB
                  </Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
