import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  recordKeydownLatency,
  getLatencyReport,
  resetLatencyProbe,
  setLatencyProbeEnabled,
  isLatencyProbeEnabled,
  LATENCY_BUDGET_MS,
} from "./latency-probe";

/** Drives rAF synchronously with a controllable frame time. */
function stubRaf(frameTimeFor: (call: number) => number) {
  let call = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(frameTimeFor(call++));
    return call;
  });
}

beforeEach(() => {
  resetLatencyProbe();
  setLatencyProbeEnabled(false);
  vi.unstubAllGlobals();
});

describe("latency probe", () => {
  it("is off by default, and costs nothing when off", () => {
    // A probe on the input path that allocates or schedules work is the latency
    // it was written to detect.
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);

    expect(isLatencyProbeEnabled()).toBe(false);
    recordKeydownLatency(1000);
    expect(raf).not.toHaveBeenCalled();
    expect(getLatencyReport().n).toBe(0);
  });

  it("measures keydown to the start of the next paint", () => {
    setLatencyProbeEnabled(true);
    stubRaf(() => 1008); // frame begins 8ms after the keydown
    recordKeydownLatency(1000);

    const report = getLatencyReport();
    expect(report.n).toBe(1);
    expect(report.p50).toBeCloseTo(8, 5);
  });

  it("passes the invariant when every keystroke makes its frame", () => {
    setLatencyProbeEnabled(true);
    stubRaf(() => 1010);
    for (let i = 0; i < 100; i++) recordKeydownLatency(1000);

    const report = getLatencyReport();
    expect(report.withinBudget).toBe(true);
    expect(report.overBudgetRate).toBe(0);
  });

  it("fails the invariant when the tail misses the budget", () => {
    // A good median with a bad tail still feels broken: a typist notices the
    // stutters, not the average.
    setLatencyProbeEnabled(true);
    stubRaf((call) => (call % 5 === 0 ? 1050 : 1005));
    for (let i = 0; i < 100; i++) recordKeydownLatency(1000);

    const report = getLatencyReport();
    expect(report.p50).toBeLessThan(LATENCY_BUDGET_MS);
    expect(report.withinBudget).toBe(false);
    expect(report.worst).toBeGreaterThan(LATENCY_BUDGET_MS);
  });

  it("tolerates a single dropped frame rather than crying regression", () => {
    setLatencyProbeEnabled(true);
    stubRaf((call) => (call === 0 ? 1090 : 1005));
    for (let i = 0; i < 200; i++) recordKeydownLatency(1000);

    expect(getLatencyReport().withinBudget).toBe(true);
  });

  it("discards a negative or non-finite measurement", () => {
    setLatencyProbeEnabled(true);
    stubRaf(() => 900); // frame time before the keydown — clock nonsense
    recordKeydownLatency(1000);
    expect(getLatencyReport().n).toBe(0);
  });

  it("does not grow without bound during a long session", () => {
    setLatencyProbeEnabled(true);
    stubRaf(() => 1005);
    for (let i = 0; i < 5000; i++) recordKeydownLatency(1000);
    expect(getLatencyReport().n).toBeLessThanOrEqual(512);
  });

  it("reports a clean slate when nothing has been measured", () => {
    expect(getLatencyReport()).toMatchObject({ n: 0, withinBudget: true });
  });

  it("survives an environment with no requestAnimationFrame", () => {
    setLatencyProbeEnabled(true);
    vi.stubGlobal("requestAnimationFrame", undefined);
    expect(() => recordKeydownLatency(1000)).not.toThrow();
  });
});
