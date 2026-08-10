/**
 * Measuring the keydown-to-paint budget.
 *
 * CLAUDE.md invariant 3 and docs/ARCHITECTURE.md §3.2 both state the rule:
 * "Budget: < 16ms from keydown to caret paint. Measure it; don't assume it."
 * Nothing measured it. The one performance invariant the whole product rests on
 * — if typing feels laggy the tool goes unused and no data is collected — was
 * enforced by hope.
 *
 * ## How it measures
 *
 * `requestAnimationFrame` fires immediately before the browser paints, so the
 * time from the keydown's `timeStamp` to the start of that frame is the latency
 * the typist actually feels. Reading a clock at the end of the handler would
 * measure only how long the JavaScript took, missing exactly the part that goes
 * wrong: React re-rendering more of the word list than it should.
 *
 * ## How it avoids becoming the problem
 *
 * A probe on the input path that costs anything is self-defeating. So:
 *
 *   - **Off unless explicitly enabled.** No sampling, no allocation, no rAF in
 *     normal use — `record` returns immediately.
 *   - **Fixed-size ring buffer**, allocated once. No array growth, no GC
 *     pressure mid-test.
 *   - **No React, no state, no subscriptions.** Nothing here can trigger a
 *     render, which would make the probe alter the thing it measures.
 */

const CAPACITY = 512;

/** The budget from CLAUDE.md invariant 3, in milliseconds. One frame at 60Hz. */
export const LATENCY_BUDGET_MS = 16;

const samples = new Float64Array(CAPACITY);
let count = 0;
let cursor = 0;
let enabled = false;

/** Enables measurement. Off by default: the probe must cost nothing when it is
 *  not being used, or it becomes the latency it was written to detect. */
export function setLatencyProbeEnabled(on: boolean): void {
  enabled = on;
}

export function isLatencyProbeEnabled(): boolean {
  return enabled;
}

/**
 * Records one keystroke's latency. Call from the keydown handler, passing the
 * event's own `timeStamp` — not a clock read, for the same reason KeyEvent.t
 * uses `timeStamp` (docs/ARCHITECTURE.md §3.1).
 *
 * Returns immediately when disabled, which is the only path taken in normal
 * use.
 */
export function recordKeydownLatency(timeStamp: number): void {
  if (!enabled) return;
  if (typeof requestAnimationFrame !== "function") return;

  requestAnimationFrame((frameTime) => {
    // Both are on the same monotonic timeline, so this is the real
    // keydown-to-paint interval rather than a handler duration.
    const latency = frameTime - timeStamp;
    if (!Number.isFinite(latency) || latency < 0) return;

    samples[cursor] = latency;
    cursor = (cursor + 1) % CAPACITY;
    if (count < CAPACITY) count += 1;
  });
}

export type LatencyReport = {
  n: number;
  p50: number;
  p95: number;
  worst: number;
  /** Share of keystrokes that missed the frame budget. The number that decides
   *  whether the invariant holds — a good median with a bad tail still feels
   *  broken, because a typist notices the stutters, not the average. */
  overBudgetRate: number;
  withinBudget: boolean;
};

/** Fraction of samples allowed to exceed the budget before the invariant is
 *  considered violated. Not zero: one dropped frame during a GC pause is not a
 *  regression, and a threshold of zero would make the check useless noise. */
export const OVER_BUDGET_TOLERANCE = 0.01;

export function getLatencyReport(): LatencyReport {
  if (count === 0) {
    return { n: 0, p50: 0, p95: 0, worst: 0, overBudgetRate: 0, withinBudget: true };
  }

  const values = Array.from(samples.slice(0, count)).sort((a, b) => a - b);
  const at = (p: number) => values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))];
  const over = values.filter((v) => v > LATENCY_BUDGET_MS).length;
  const overBudgetRate = over / values.length;

  return {
    n: values.length,
    p50: at(50),
    p95: at(95),
    worst: values[values.length - 1],
    overBudgetRate,
    withinBudget: overBudgetRate <= OVER_BUDGET_TOLERANCE,
  };
}

export function resetLatencyProbe(): void {
  count = 0;
  cursor = 0;
}
