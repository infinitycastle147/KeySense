/**
 * A strip's mini waveform (docs/DESIGN.md §4) — one metric over time on the
 * shared time axis the dashboard reads correlations across. Inline SVG, no
 * chart library, in the same spirit as `Trace.tsx` but static (no draw-on:
 * per docs/DESIGN.md §6 the dashboard's only motion is the staggered fade-in
 * on load, not a second animated waveform competing with the results-screen
 * trace).
 */

type SparklineProps = {
  /** Chronological. `null`/`undefined` marks a test with no data for this
   *  metric (e.g. a finger that never appeared) — skipped, not zeroed. */
  values: (number | null | undefined)[];
  className?: string;
};

const VIEW_W = 300;
const VIEW_H = 40;
const PAD_Y = 4;

export function Sparkline({ values, className }: SparklineProps) {
  const points: { x: number; y: number }[] = [];
  const valid = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => typeof p.v === "number" && Number.isFinite(p.v));

  if (valid.length === 0) {
    return (
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" className={className} aria-hidden="true">
        <line x1={0} y1={VIEW_H / 2} x2={VIEW_W} y2={VIEW_H / 2} stroke="var(--grid)" strokeWidth={1.5} strokeDasharray="3 3" />
      </svg>
    );
  }

  const min = Math.min(...valid.map((p) => p.v));
  const max = Math.max(...valid.map((p) => p.v));
  const range = max - min || 1;
  const lastIndex = values.length - 1 || 1;

  for (const { v, i } of valid) {
    const x = (i / lastIndex) * VIEW_W;
    const y = VIEW_H - PAD_Y - ((v - min) / range) * (VIEW_H - PAD_Y * 2);
    points.push({ x, y });
  }

  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" className={className} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--trace)" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      {points.length === 1 && <circle cx={points[0].x} cy={points[0].y} r={2} fill="var(--trace)" />}
    </svg>
  );
}
