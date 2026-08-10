import { describe, expect, it } from "vitest";
import { alignWord, findTranspositions } from "./align";

function summarise(expected: string, typed: string): string[] {
  return alignWord(expected, typed).map((op) => {
    if (op.kind === "match") return `=${op.expected}`;
    if (op.kind === "substitution") return `${op.expected}->${op.typed}`;
    if (op.kind === "insertion") return `+${op.typed}`;
    return `-${op.expected}`;
  });
}

describe("alignWord", () => {
  it("reports a dropped character as one omission, not a cascade of substitutions", () => {
    // The defect this module exists for: positionally, `helo` vs `hello`
    // reads as a substitution l->o plus a missed character, inventing a
    // confusion the typist never had.
    //
    // Asserted as counts, not as an exact script: `hello` has two adjacent
    // `l`s, so which one carries the gap is genuinely ambiguous and equally
    // cheap either way. Pinning the arbitrary choice would test the traceback's
    // tie-break rather than the classification.
    const ops = alignWord("hello", "helo");
    expect(ops.filter((o) => o.kind === "omission").map((o) => o.expected)).toEqual(["l"]);
    expect(ops.filter((o) => o.kind === "substitution")).toHaveLength(0);
    expect(ops.filter((o) => o.kind === "insertion")).toHaveLength(0);
    expect(ops.filter((o) => o.kind === "match")).toHaveLength(4);
  });

  it("does not cascade through the rest of a long word", () => {
    const ops = alignWord("keyboard", "kyboard"); // dropped the 'e'
    expect(ops.filter((o) => o.kind === "substitution")).toHaveLength(0);
    expect(ops.filter((o) => o.kind === "omission")).toHaveLength(1);
  });

  it("reports a doubled character as one insertion", () => {
    const ops = alignWord("hello", "helllo");
    expect(ops.filter((o) => o.kind === "insertion").map((o) => o.typed)).toEqual(["l"]);
    expect(ops.filter((o) => o.kind === "substitution")).toHaveLength(0);
    expect(ops.filter((o) => o.kind === "omission")).toHaveLength(0);
  });

  it("reports a genuine wrong key as a substitution", () => {
    expect(summarise("cat", "cst")).toEqual(["=c", "a->s", "=t"]);
  });

  it("prefers a substitution over an insert/delete pair", () => {
    // Unit costs make substitution (1) cheaper than a gap pair (2). Typing the
    // wrong key is far more common than dropping one and adding another.
    const ops = alignWord("cat", "cot");
    expect(ops.map((o) => o.kind)).toEqual(["match", "substitution", "match"]);
  });

  it("aligns against an empty typed string as all omissions", () => {
    expect(summarise("cat", "")).toEqual(["-c", "-a", "-t"]);
  });

  it("aligns against an empty expected string as all insertions", () => {
    expect(summarise("", "cat")).toEqual(["+c", "+a", "+t"]);
  });

  it("returns nothing for two empty strings", () => {
    expect(alignWord("", "")).toEqual([]);
  });

  it("handles a perfect match with no edits", () => {
    expect(alignWord("perfect", "perfect").every((o) => o.kind === "match")).toBe(true);
  });

  it("carries indices back into both source strings", () => {
    const ops = alignWord("cat", "cst");
    const sub = ops.find((o) => o.kind === "substitution");
    expect(sub).toMatchObject({ expectedIdx: 1, typedIdx: 1, expected: "a", typed: "s" });
  });

  it("is deterministic across repeated runs on an ambiguous pair", () => {
    const first = summarise("abab", "baba");
    for (let i = 0; i < 5; i++) expect(summarise("abab", "baba")).toEqual(first);
  });
});

describe("findTranspositions", () => {
  it("finds a swapped pair", () => {
    const ops = alignWord("the", "hte");
    expect(findTranspositions(ops)).toEqual([0]);
  });

  it("consumes a pair so its second half cannot start another", () => {
    const ops = alignWord("abab", "baba");
    const found = findTranspositions(ops);
    // Adjacent indices must never both appear.
    for (let i = 1; i < found.length; i++) {
      expect(found[i] - found[i - 1]).toBeGreaterThan(1);
    }
  });

  it("does not treat two unrelated substitutions as a transposition", () => {
    const ops = alignWord("cat", "dog");
    expect(findTranspositions(ops)).toEqual([]);
  });

  it("ignores a doubled character typed twice as itself", () => {
    const ops = alignWord("aa", "aa");
    expect(findTranspositions(ops)).toEqual([]);
  });
});
