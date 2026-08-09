import { describe, expect, it } from "vitest";
import { computeCorrections } from "./corrections";
import { charEvent, deleteEvent } from "./test-utils";
import { MIN_FINDING_N } from "./stats";

describe("computeCorrections", () => {
  it("returns all-zero, non-reportable result for empty input", () => {
    const result = computeCorrections([]);
    expect(result).toEqual({
      backspaceCount: 0,
      charAttemptCount: 0,
      backspaceRate: 0,
      meanCharsToNotice: { value: 0, n: 0, reportable: false },
    });
  });

  it("single sample with no errors: no NaN, nothing to notice", () => {
    const result = computeCorrections([charEvent({ t: 0, expected: "a", key: "a" })]);
    expect(result.charAttemptCount).toBe(1);
    expect(result.backspaceRate).toBe(0);
    expect(result.meanCharsToNotice).toEqual({ value: 0, n: 0, reportable: false });
    expect(Number.isNaN(result.backspaceRate)).toBe(false);
  });

  it("perfect input (zero errors, several backspace-free chars): no NaN", () => {
    const events = Array.from({ length: 40 }, (_, i) => charEvent({ t: i * 100, expected: "a", key: "a" }));
    const result = computeCorrections(events);
    expect(result.backspaceCount).toBe(0);
    expect(result.backspaceRate).toBe(0);
    expect(result.meanCharsToNotice.reportable).toBe(false);
    expect(Number.isNaN(result.meanCharsToNotice.value)).toBe(false);
  });

  it("n below MIN_FINDING_N: a handful of corrected errors is not reportable", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "x" }),
      deleteEvent({ t: 100, kind: "backspace" }),
      charEvent({ t: 200, expected: "a", key: "a" }),
    ];
    const result = computeCorrections(events);
    expect(result.meanCharsToNotice.n).toBe(1);
    expect(result.meanCharsToNotice.n).toBeLessThan(MIN_FINDING_N);
    expect(result.meanCharsToNotice.reportable).toBe(false);
  });

  it("timing gaps (even ones > OUTLIER_MS) do not affect this index-based metric", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "x" }),
      deleteEvent({ t: 999999, kind: "backspace" }), // huge gap, irrelevant here
      charEvent({ t: 1000000, expected: "a", key: "a" }),
    ];
    const result = computeCorrections(events);
    expect(result.meanCharsToNotice).toEqual({ value: 1, n: 1, reportable: false });
  });

  it("immediate correction scores charsToNotice = 1", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "x" }),
      deleteEvent({ t: 50, kind: "backspace" }),
    ];
    const result = computeCorrections(events);
    expect(result.meanCharsToNotice.value).toBe(1);
  });

  it("a delayed correction scores a larger charsToNotice", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "x" }), // error, position 1
      charEvent({ t: 100, expected: "b", key: "b" }), // position 2
      charEvent({ t: 200, expected: "c", key: "c" }), // position 3
      deleteEvent({ t: 300, kind: "backspace" }),
    ];
    const result = computeCorrections(events);
    expect(result.meanCharsToNotice.value).toBe(3);
  });

  it("an uncorrected error (no later deletion) is excluded from the notice distribution", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "x" }),
      charEvent({ t: 100, expected: "b", key: "b" }),
    ];
    const result = computeCorrections(events);
    expect(result.meanCharsToNotice.n).toBe(0);
  });

  it("computes backspaceRate from backspace and word-delete counts over char attempts", () => {
    const events = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 100, expected: "b", key: "x" }),
      deleteEvent({ t: 200, kind: "backspace" }),
      charEvent({ t: 300, expected: "b", key: "b" }),
      deleteEvent({ t: 400, kind: "word-delete" }),
    ];
    const result = computeCorrections(events);
    expect(result.charAttemptCount).toBe(3);
    expect(result.backspaceCount).toBe(2);
    expect(result.backspaceRate).toBeCloseTo(2 / 3);
  });
});
