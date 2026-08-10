import { describe, expect, it } from "vitest";
import { classifyChar, computeCharClassStats } from "./charclass";
import { charEvent } from "./test-utils";
import type { KeyEvent } from "@/lib/types";

/** One char event per keystroke, `gap` ms apart. */
function typed(
  pairs: { expected: string; key?: string; shift?: boolean }[],
  gap = 150,
): KeyEvent[] {
  return pairs.map((p, i) =>
    charEvent({
      t: i * gap,
      expected: p.expected,
      key: p.key ?? p.expected,
      mods: p.shift ? ["shift"] : [],
    }),
  );
}

describe("classifyChar", () => {
  it("separates the classes ARCHITECTURE §5.4 asks for", () => {
    expect(classifyChar("a")).toBe("lowercase");
    expect(classifyChar("A")).toBe("capital");
    expect(classifyChar("7")).toBe("digit");
    expect(classifyChar(";")).toBe("punctuation");
    expect(classifyChar(" ")).toBe("space");
  });

  it("has no class for an empty expected character", () => {
    expect(classifyChar("")).toBeUndefined();
  });

  it("judges a capital by the character produced, not by whether shift was held", () => {
    // Caps lock produces a capital without shift; shift with no letter produces
    // no capital. The character is the ground truth.
    expect(classifyChar("A")).toBe("capital");
    expect(classifyChar("a")).toBe("lowercase");
  });
});

describe("computeCharClassStats", () => {
  it("surfaces a capital-letter weakness that aggregate accuracy hides", () => {
    // 20 clean lowercase, 4 capitals of which 3 are wrong. Overall accuracy is
    // 87.5% — unremarkable. The capital class is at 75% error.
    const events = typed([
      ...Array.from({ length: 20 }, () => ({ expected: "a" })),
      { expected: "A", key: "a", shift: true },
      { expected: "B", key: "b", shift: true },
      { expected: "C", key: "c", shift: true },
      { expected: "D", shift: true },
    ]);

    const stats = computeCharClassStats(events);
    const capital = stats.classes.find((c) => c.charClass === "capital")!;
    const lower = stats.classes.find((c) => c.charClass === "lowercase")!;

    expect(capital.n).toBe(4);
    expect(capital.errorRate).toBe(0.75);
    expect(lower.errorRate).toBe(0);
  });

  it("isolates the shift chord from the letters it produces", () => {
    const events = typed([
      { expected: "a" },
      { expected: "b" },
      { expected: "A", key: "a", shift: true },
      { expected: "B", key: "b", shift: true },
    ]);
    const stats = computeCharClassStats(events);
    expect(stats.shiftedErrorRate.value).toBe(1);
    expect(stats.unshiftedErrorRate.value).toBe(0);
    expect(stats.shiftedErrorRate.n).toBe(2);
  });

  it("reports latency relative to lowercase, not in bare milliseconds", () => {
    const events: KeyEvent[] = [
      charEvent({ t: 0, expected: "a", key: "a" }),
      charEvent({ t: 100, expected: "a", key: "a" }),
      charEvent({ t: 200, expected: "a", key: "a" }),
      charEvent({ t: 500, expected: ";", key: ";" }),
    ];
    const stats = computeCharClassStats(events);
    const punctuation = stats.classes.find((c) => c.charClass === "punctuation")!;
    expect(punctuation.relativeToLowercase).toBeCloseTo(3, 5);
  });

  it("reports 0, not 1, when a class has no latency baseline to compare against", () => {
    // 1 would claim "exactly as fast as lowercase" — a measurement, where the
    // truth is the absence of one.
    const stats = computeCharClassStats(typed([{ expected: "7" }]));
    const digit = stats.classes.find((c) => c.charClass === "digit")!;
    expect(digit.relativeToLowercase).toBe(0);
  });

  it("carries a Wilson interval on every class rate", () => {
    const stats = computeCharClassStats(typed([{ expected: "A", key: "a" }]));
    const capital = stats.classes.find((c) => c.charClass === "capital")!;
    expect(capital.errorRateCI.high).toBeGreaterThan(capital.errorRateCI.low);
  });

  it("returns every class, even empty ones, for a stable shape", () => {
    const stats = computeCharClassStats([]);
    expect(stats.classes).toHaveLength(5);
    expect(stats.classes.every((c) => c.n === 0)).toBe(true);
  });
});
