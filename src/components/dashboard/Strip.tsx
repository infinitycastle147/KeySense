/**
 * One dashboard row — docs/DESIGN.md §4: stacked horizontal strips on a
 * shared time axis, not a card grid. Label, sparkline, current value, delta
 * arrow, evidence tag. Every claim ships its `n`.
 */

import { Sparkline } from "@/components/dashboard/Sparkline";
import { cn } from "@/lib/utils";

export type StripProps = {
  label: string;
  /** e.g. "30d" or "last 42 tests" — the shared axis this strip covers. */
  rangeLabel: string;
  series: (number | null | undefined)[];
  current: number | null;
  unit?: string;
  decimals?: number;
  /** Change over the window; null when there isn't enough history to say. */
  delta: number | null;
  n: number;
  reportable: boolean;
  /** Which direction of `delta` reads as improvement. */
  goodDirection: "up" | "down";
  className?: string;
};

function formatNumber(v: number, decimals: number): string {
  return v.toFixed(decimals);
}

function DeltaArrow({ delta, goodDirection, decimals }: { delta: number; goodDirection: "up" | "down"; decimals: number }) {
  const EPSILON = 10 ** -(decimals + 1);
  if (Math.abs(delta) < EPSILON) {
    return <span className="label-type text-muted-foreground">no change</span>;
  }
  const rose = delta > 0;
  const improved = goodDirection === "up" ? rose : !rose;
  const arrow = rose ? "▲" : "▼";
  return (
    <span className={cn("label-type", improved ? "text-vital" : "text-flag")}>
      {arrow} {formatNumber(Math.abs(delta), decimals)}
    </span>
  );
}

export function Strip({
  label,
  rangeLabel,
  series,
  current,
  unit = "",
  decimals = 0,
  delta,
  n,
  reportable,
  goodDirection,
  className,
}: StripProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-b border-grid py-5 sm:flex-row sm:items-center sm:gap-6 last:border-b-0",
        className
      )}
    >
      <div className="flex w-full flex-col gap-0.5 sm:w-44 sm:shrink-0">
        <span className="label-type text-foreground">{label}</span>
        <span className="label-type text-muted-foreground/70">{rangeLabel}</span>
      </div>

      <div className="h-10 min-w-0 flex-1">
        <Sparkline values={series} className="h-full w-full" />
      </div>

      <div className="flex items-baseline justify-between gap-3 sm:w-36 sm:shrink-0 sm:flex-col sm:items-end sm:justify-center sm:gap-1">
        <span className="font-[family-name:var(--font-display)] text-2xl leading-none tabular-nums">
          {current === null ? "—" : formatNumber(current, decimals)}
          {current !== null && unit && <span className="ml-1 text-sm text-muted-foreground">{unit}</span>}
        </span>
        {delta !== null ? (
          <DeltaArrow delta={delta} goodDirection={goodDirection} decimals={decimals} />
        ) : (
          <span className="label-type text-muted-foreground/70">n/a</span>
        )}
      </div>

      <div className="label-type shrink-0 text-muted-foreground sm:w-28 sm:text-right">
        n={n}
        {!reportable && <span className="text-flag"> · below n=30</span>}
      </div>
    </div>
  );
}
