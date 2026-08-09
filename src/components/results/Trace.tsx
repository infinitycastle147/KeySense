"use client";

/**
 * The cardiograph replay — the signature element (docs/DESIGN.md §5).
 *
 * The test replays as a waveform drawn left to right at the speed it was
 * actually typed. Inter-key intervals become the shape:
 *   - steady rhythm  -> even peaks
 *   - hesitation     -> a flat run (long gap, low amplitude)
 *   - an error       -> a `--flag`-coloured spike
 *   - a correction   -> the flag spike doubles back below the baseline
 *
 * Inline SVG, no chart library. Draw-on is implemented with stroke-dasharray
 * per docs/DESIGN.md §5's implementation note, timed in real milliseconds so
 * each segment's on-screen duration matches how long that stretch of typing
 * actually took — a `transitionDelay`/`transitionDuration` in `ms` derived
 * straight from `KeyEvent.t` needs no separate animation clock.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyEvent } from "@/lib/types";
import { OUTLIER_MS } from "@/lib/analysis/stats";
import { cn } from "@/lib/utils";

type TraceProps = {
  events: KeyEvent[];
  durationMs: number;
  className?: string;
};

const VIEW_W = 1000;
const VIEW_H = 160;
const MID_Y = VIEW_H / 2;

const MAX_AMP = 46;
const MIN_AMP = 6;
const ERROR_AMP = 68;
const CORRECTION_AMP = 54;

/** A keystroke this fast reads as a confident, tall peak. */
const FAST_MS = 80;
/** At and beyond this gap the line has already gone flat — reuses the same
 *  "not typing" cutoff the stats layer discards latency samples past, so the
 *  visual definition of a stall matches the numeric one. */
const HESITATION_MS = OUTLIER_MS;

const MIN_HALF_WIDTH = 2;
const MAX_HALF_WIDTH = 26;
/** Bounds how many "normal" keystrokes get their own peak, so an unbounded
 *  zen-mode test doesn't emit thousands of path segments. Errors and
 *  corrections — the signal — are never decimated. */
const MAX_NORMAL_POINTS = 600;
/** Floor so a same-millisecond event still gets a visible draw-on step. */
const MIN_SEGMENT_MS = 30;

type TraceColor = "trace" | "flag";
type PathPoint = { x: number; y: number };
type Segment = { color: TraceColor; points: PathPoint[]; startT: number; endT: number };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Fast interval -> tall peak. Slow interval (up to the hesitation cutoff)
 *  -> the peak flattens toward the baseline, reading as a flat run. */
function normalAmplitude(intervalMs: number): number {
  const t = clamp((intervalMs - FAST_MS) / (HESITATION_MS - FAST_MS), 0, 1);
  return MAX_AMP - t * (MAX_AMP - MIN_AMP);
}

function pathData(points: PathPoint[]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  return `M ${first.x.toFixed(2)} ${first.y.toFixed(2)} ` + rest.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

function buildSegments(events: KeyEvent[], durationMs: number): Segment[] {
  if (events.length === 0 || durationMs <= 0) return [];

  const normalTotal = events.filter((e) => e.kind === "char" && e.ok).length;
  const stride = normalTotal > MAX_NORMAL_POINTS ? Math.ceil(normalTotal / MAX_NORMAL_POINTS) : 1;
  const scaleX = (t: number) => clamp((t / durationMs) * VIEW_W, 0, VIEW_W);

  const segments: Segment[] = [];
  let current: Segment = { color: "trace", points: [{ x: 0, y: MID_Y }], startT: 0, endT: 0 };
  let prevX = 0;
  let prevT = 0;
  let normalIndex = 0;

  function extend(color: TraceColor, points: PathPoint[], t: number) {
    if (current.color !== color) {
      const join = current.points[current.points.length - 1];
      segments.push(current);
      current = { color, points: [join], startT: t, endT: t };
    }
    current.points.push(...points);
    current.endT = t;
  }

  for (const e of events) {
    const isError = e.kind === "char" && !e.ok;
    const isCorrection = e.kind !== "char";
    const isNormal = e.kind === "char" && e.ok;

    if (isNormal) {
      normalIndex += 1;
      if (stride > 1 && normalIndex % stride !== 0) {
        prevT = e.t;
        continue;
      }
    }

    const x = scaleX(e.t);
    const halfWidth = clamp((x - prevX) / 2, MIN_HALF_WIDTH, MAX_HALF_WIDTH);

    let color: TraceColor;
    let amp: number;
    let sign: 1 | -1;

    if (isError) {
      color = "flag";
      amp = ERROR_AMP;
      sign = 1;
    } else if (isCorrection) {
      // "the spike doubles back" — a correction dips the line below the
      // baseline, mirroring the error spike it is fixing.
      color = "flag";
      amp = CORRECTION_AMP;
      sign = -1;
    } else {
      color = "trace";
      amp = normalAmplitude(e.t - prevT);
      sign = 1;
    }

    extend(
      color,
      [
        { x: x - halfWidth, y: MID_Y },
        { x, y: MID_Y - sign * amp },
        { x: x + halfWidth, y: MID_Y },
      ],
      e.t
    );

    prevX = x;
    prevT = e.t;
  }

  segments.push(current);
  return segments.filter((s) => s.points.length > 1);
}

export function Trace({ events, durationMs, className }: TraceProps) {
  const segments = useMemo(() => buildSegments(events, durationMs), [events, durationMs]);
  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const [lengths, setLengths] = useState<number[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [skipped, setSkipped] = useState(false);
  // Lazy initializer reads the media query for the first paint directly —
  // the effect below only *subscribes* to later changes, so it never needs
  // to call setState synchronously on mount itself.
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Measure each segment's real geometric length once it's mounted — the
  // stroke-dasharray draw-on technique needs the exact path length to hide,
  // and that length only exists once the <path> has actually painted. There
  // is no render-time substitute for reading committed DOM geometry.
  useLayoutEffect(() => {
    if (segments.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting derived measurement state when there's nothing to measure
      setLengths(null);
      return;
    }
    setLengths(pathRefs.current.slice(0, segments.length).map((el) => el?.getTotalLength() ?? 0));
  }, [segments]);

  // Flip to "playing" one frame after the hidden (dashoffset = length) state
  // has painted, so the browser has something to transition from — the
  // classic two-step stroke-dasharray draw-on technique.
  useEffect(() => {
    if (!lengths || reducedMotion || skipped) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- must reset to the hidden state before scheduling the visible one on the next frame
    setPlaying(false);
    const id = requestAnimationFrame(() => setPlaying(true));
    return () => cancelAnimationFrame(id);
  }, [lengths, reducedMotion, skipped]);

  const done = reducedMotion || skipped || !lengths;
  const charEvents = events.filter((e) => e.kind === "char");
  const errorCount = charEvents.filter((e) => !e.ok).length;
  const statusLabel = done ? (reducedMotion ? "reduced motion — full trace" : "trace complete") : "click to skip";

  function skip() {
    setSkipped(true);
  }

  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      <button
        type="button"
        onClick={skip}
        disabled={done}
        aria-label={done ? "Typing rhythm trace, complete" : "Typing rhythm trace, playing — press to skip to the completed trace"}
        className="block w-full cursor-pointer rounded-md bg-chassis ring-1 ring-grid transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-trace disabled:cursor-default"
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="h-40 w-full"
          role="img"
          aria-hidden="true"
        >
          <line x1={0} y1={MID_Y} x2={VIEW_W} y2={MID_Y} stroke="var(--grid)" strokeWidth={1} />
          {segments.map((seg, i) => {
            const length = lengths?.[i] ?? 0;
            const dashOffset = done ? 0 : playing ? 0 : length;
            const durationMsForSeg = Math.max(seg.endT - seg.startT, MIN_SEGMENT_MS);
            return (
              <path
                key={i}
                ref={(el) => {
                  pathRefs.current[i] = el;
                }}
                d={pathData(seg.points)}
                fill="none"
                stroke={seg.color === "flag" ? "var(--flag)" : "var(--trace)"}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={
                  done
                    ? { strokeDasharray: length, strokeDashoffset: 0, transition: "none" }
                    : {
                        strokeDasharray: length,
                        strokeDashoffset: dashOffset,
                        transition: playing
                          ? `stroke-dashoffset ${durationMsForSeg}ms linear ${seg.startT}ms`
                          : "none",
                      }
                }
              />
            );
          })}
        </svg>
      </button>
      <div className="label-type flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-muted-foreground">
        <span>
          n={charEvents.length} keystrokes · {errorCount} error{errorCount === 1 ? "" : "s"}
        </span>
        <span>{events.length === 0 ? "no keystrokes recorded" : statusLabel}</span>
      </div>
    </div>
  );
}
