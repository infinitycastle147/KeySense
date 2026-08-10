import { describe, expect, it } from "vitest";
import { classifyBigramShape, computeGeometry } from "./geometry";
import { charEvent, loadLayoutIndex } from "./test-utils";
import type { KeyEvent } from "@/lib/types";

const qwerty = loadLayoutIndex("qwerty");

function shape(a: string, b: string) {
  return classifyBigramShape(qwerty, a, b);
}

/** Types a string, one char event per keystroke, 150ms apart. */
function typed(text: string, wrong?: Set<number>): KeyEvent[] {
  return text.split("").map((ch, i) =>
    charEvent({
      t: i * 150,
      expected: ch,
      key: wrong?.has(i) ? "@" : ch,
      prev: i > 0 ? text[i - 1] : null,
    }),
  );
}

describe("classifyBigramShape", () => {
  it("calls opposite hands an alternation", () => {
    expect(shape("f", "j")).toBe("alternation");
  });

  it("calls the same finger twice a same-finger bigram", () => {
    expect(shape("e", "d")).toBe("same-finger");
  });

  it("calls a two-row same-hand jump on different fingers a scissor", () => {
    expect(shape("q", "c")).toBe("scissor");
  });

  it("calls an index-column reach a lateral stretch", () => {
    // 't' is the left index's inner column, 'w' is the ring finger's home.
    // (`r`->`t` would NOT qualify: both are the left index, so it is a
    // same-finger bigram, and that sharper category wins.)
    expect(shape("w", "t")).toBe("lateral-stretch");
    expect(shape("r", "t")).toBe("same-finger");
  });

  it("calls an ordinary same-hand move nothing sharper than same-hand", () => {
    expect(shape("a", "d")).toBe("same-hand");
  });

  it("refuses to classify a transition involving the space bar", () => {
    // The thumb belongs to neither hand; counting it would make every word
    // boundary read as an alternation.
    expect(shape("a", " ")).toBeUndefined();
    expect(shape(" ", "a")).toBeUndefined();
  });

  it("returns undefined for characters absent from the layout", () => {
    expect(shape("é", "a")).toBeUndefined();
  });
});

describe("computeGeometry", () => {
  it("measures a high alternation rate for hand-swapping text", () => {
    const stats = computeGeometry(typed("fjfjfjfjfj"), qwerty);
    expect(stats.alternationRate.value).toBe(1);
    expect(stats.medianSameHandRun).toBe(1);
  });

  it("measures long same-hand runs for one-handed text", () => {
    const stats = computeGeometry(typed("qwerasdf"), qwerty);
    expect(stats.alternationRate.value).toBe(0);
    expect(stats.longestSameHandRun).toBe(8);
  });

  it("counts errors and latency per shape", () => {
    const stats = computeGeometry(typed("fjfjfj", new Set([1, 3])), qwerty);
    const alternation = stats.shapes.find((s) => s.shape === "alternation")!;
    expect(alternation.n).toBe(5);
    expect(alternation.errors).toBe(2);
    expect(alternation.latencyP50).toBe(150);
  });

  it("detects a redirect when the hand reverses direction mid-run", () => {
    // 's' (col 1) -> 'f' (col 3) -> 'a' (col 0): inward, then back outward.
    const stats = computeGeometry(typed("sfa"), qwerty);
    expect(stats.redirectRate.n).toBe(1);
    expect(stats.redirectRate.value).toBe(1);
  });

  it("does not call a steady one-direction run a redirect", () => {
    const stats = computeGeometry(typed("asd"), qwerty);
    expect(stats.redirectRate.value).toBe(0);
  });

  it("ignores a triple that crosses hands", () => {
    expect(computeGeometry(typed("asj"), qwerty).redirectRate.n).toBe(0);
  });

  it("carries sample sizes and gates on MIN_FINDING_N", () => {
    const stats = computeGeometry(typed("fjfj"), qwerty);
    expect(stats.alternationRate.n).toBe(3);
    expect(stats.alternationRate.reportable).toBe(false);
  });

  it("returns a well-formed all-zero result for an empty stream", () => {
    const stats = computeGeometry([], qwerty);
    expect(stats.alternationRate.value).toBe(0);
    expect(stats.shapes).toHaveLength(5);
    expect(stats.shapes.every((s) => s.n === 0)).toBe(true);
  });
});
