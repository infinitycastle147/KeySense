import { describe, expect, it } from "vitest";
import { resolveCorpus, resolveTargetPatterns, DEFAULT_CORPUS } from "./targets";
import { loadLayoutIndex } from "@/lib/analysis/test-utils";

const qwerty = loadLayoutIndex("qwerty");

describe("resolveTargetPatterns", () => {
  it("passes bigram targets through as lowercase patterns", () => {
    expect(resolveTargetPatterns("bigram", ["TH", "Er"])).toEqual(["th", "er"]);
  });

  it("passes sfb targets through unchanged (still bigram strings)", () => {
    expect(resolveTargetPatterns("sfb", ["ol", "ju"])).toEqual(["ol", "ju"]);
  });

  it("passes key targets through as lowercase patterns", () => {
    expect(resolveTargetPatterns("key", ["J", "q"])).toEqual(["j", "q"]);
  });

  it("expands a finger target to the characters mapped to it", () => {
    const chars = resolveTargetPatterns("finger", ["l-index"], qwerty);
    expect(chars.length).toBeGreaterThan(0);
    // 'f' is the universal left-index home key on a qwerty ANSI layout.
    expect(chars).toContain("f");
    // Right-pinky home keys should never be assigned to the left index.
    expect(chars).not.toContain(";");
  });

  it("returns [] for a finger target with no layout supplied", () => {
    expect(resolveTargetPatterns("finger", ["l-index"])).toEqual([]);
  });

  it("returns [] for a class target — the corpus itself is the filter", () => {
    expect(resolveTargetPatterns("class", ["doubleletter"])).toEqual([]);
  });
});

describe("resolveCorpus", () => {
  it("maps recognised class targets to their purpose-built corpus", () => {
    expect(resolveCorpus("class", ["doubleletter"])).toBe("english_doubleletter");
    expect(resolveCorpus("class", ["contractions"])).toBe("english_contractions");
    expect(resolveCorpus("class", ["misspelled"])).toBe("english_commonly_misspelled");
  });

  it("falls back to the default corpus for an unrecognised class name", () => {
    expect(resolveCorpus("class", ["some-future-class"])).toBe(DEFAULT_CORPUS);
  });

  it("always returns the default corpus for non-class target types", () => {
    expect(resolveCorpus("bigram", ["th"])).toBe(DEFAULT_CORPUS);
    expect(resolveCorpus("finger", ["l-index"])).toBe(DEFAULT_CORPUS);
    expect(resolveCorpus("key", ["j"])).toBe(DEFAULT_CORPUS);
    expect(resolveCorpus("sfb", ["ol"])).toBe(DEFAULT_CORPUS);
  });
});
