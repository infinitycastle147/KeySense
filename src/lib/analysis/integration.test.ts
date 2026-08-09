/**
 * End-to-end: the real engine's events fed into the real analysis.
 *
 * Phase 1 and Phase 3A were built in parallel against `types.ts`, which fixes
 * the *shape* of a KeyEvent but not its *semantics*. That gap let the analysis
 * layer assume a `key === ""` omission sentinel the engine never emitted,
 * leaving `ErrorTaxonomy.omission` permanently zero — a plausible-looking
 * number that was simply always wrong.
 *
 * Shape agreement is not semantic agreement. These tests drive the actual
 * engine so the two layers are checked against each other rather than against
 * hand-written fixtures that encode the same assumption twice.
 */

import { describe, it, expect } from "vitest";
import { createEngine } from "@/lib/engine/engine";
import { computeErrorTaxonomy, computeConfusionMatrix } from "@/lib/analysis/errors";
import type { TestConfig } from "@/lib/types";

const config: TestConfig = {
  mode: "words",
  modeSetting: "3",
  language: "english",
  layout: "qwerty",
  punctuation: false,
  numbers: false,
};

/** Types a string into an engine, one keydown per character. */
function type(engine: ReturnType<typeof createEngine>, text: string, startAt = 0) {
  let t = startAt;
  for (const ch of text) {
    t += 100;
    engine.handleKeyDown({
      key: ch,
      timeStamp: t,
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: () => {},
    } as unknown as KeyboardEvent);
  }
  return t;
}

describe("engine -> analysis integration", () => {
  it("counts a skipped character as an omission", () => {
    const engine = createEngine(config, ["cat", "dog", "run"]);
    // "ca" then space commits "cat" one character short.
    type(engine, "ca dog run");

    const taxonomy = computeErrorTaxonomy(engine.getEvents());
    expect(taxonomy.omission).toBe(1);
  });

  it("counts a wrong character as a substitution, not an omission", () => {
    const engine = createEngine(config, ["cat", "dog", "run"]);
    type(engine, "cxt dog run");

    const taxonomy = computeErrorTaxonomy(engine.getEvents());
    expect(taxonomy.substitution).toBe(1);
    expect(taxonomy.omission).toBe(0);
  });

  it("counts typing past a word's end as an insertion", () => {
    const engine = createEngine(config, ["cat", "dog", "run"]);
    type(engine, "cats dog run");

    const taxonomy = computeErrorTaxonomy(engine.getEvents());
    expect(taxonomy.insertion).toBe(1);
  });

  it("records no errors for a clean run", () => {
    const engine = createEngine(config, ["cat", "dog", "run"]);
    type(engine, "cat dog run");

    expect(computeErrorTaxonomy(engine.getEvents())).toEqual({
      substitution: 0,
      insertion: 0,
      omission: 0,
      transposition: 0,
    });
  });

  it("builds a confusion matrix from real engine output", () => {
    const engine = createEngine(config, ["cat", "dog", "run"]);
    type(engine, "cxt dog run");

    const matrix = computeConfusionMatrix(engine.getEvents());
    expect(matrix["a"]?.["x"]).toBe(1);
  });

  it("derives every event timestamp from event.timeStamp", () => {
    const engine = createEngine(config, ["cat", "dog", "run"]);
    type(engine, "cat", 5000);

    const events = engine.getEvents();
    // First keystroke is t=0; the rest are offsets from it, not wall-clock.
    expect(events[0].t).toBe(0);
    expect(events[1].t).toBe(100);
    expect(events[2].t).toBe(200);
  });
});
