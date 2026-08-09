import { describe, expect, it } from "vitest";
import { createEngine } from "./engine";
import type { TestConfig } from "@/lib/types";

const config: TestConfig = {
  mode: "words",
  modeSetting: "3",
  language: "english",
  layout: "qwerty",
  punctuation: false,
  numbers: false,
};

/** Builds a minimal fake KeyboardEvent — engine.ts only reads these fields. */
function key(
  k: string,
  overrides: Partial<{
    timeStamp: number;
    repeat: boolean;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
  }> = {}
): KeyboardEvent {
  return {
    key: k,
    timeStamp: overrides.timeStamp ?? 0,
    repeat: overrides.repeat ?? false,
    shiftKey: overrides.shiftKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    altKey: overrides.altKey ?? false,
    metaKey: overrides.metaKey ?? false,
    isComposing: overrides.isComposing ?? false,
  } as unknown as KeyboardEvent;
}

describe("engine — correct/incorrect char entry", () => {
  it("records ok:true for a matching character and ok:false for a mismatch", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    engine.handleKeyDown(key("c", { timeStamp: 100 }));
    engine.handleKeyDown(key("a", { timeStamp: 150 }));
    engine.handleKeyDown(key("x", { timeStamp: 200 })); // wrong — expected "t"

    const events = engine.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      key: "c",
      expected: "c",
      ok: true,
      kind: "char",
      wordIdx: 0,
      charIdx: 0,
      t: 0,
      prev: null,
    });
    expect(events[1]).toMatchObject({ ok: true, t: 50, prev: "c" });
    expect(events[2]).toMatchObject({ key: "x", expected: "t", ok: false, t: 100 });
    expect(engine.getState().typed).toEqual(["cax", ""]);
  });

  it("derives t from event.timeStamp relative to the first keystroke, never a wall clock read inside the handler", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("c", { timeStamp: 5000 }));
    engine.handleKeyDown(key("a", { timeStamp: 5321 }));
    const events = engine.getEvents();
    expect(events[0].t).toBe(0);
    expect(events[1].t).toBe(321);
  });
});

describe("engine — backspace", () => {
  it("removes the last typed character and records a backspace event", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("c", { timeStamp: 0 }));
    engine.handleKeyDown(key("a", { timeStamp: 10 }));
    engine.handleKeyDown(key("Backspace", { timeStamp: 20 }));

    expect(engine.getState().typed).toEqual(["c"]);
    const events = engine.getEvents();
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      kind: "backspace",
      key: "a",
      expected: "a",
      ok: true,
      charIdx: 1,
    });
  });

  it("steps back into the previous word without deleting from it", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    for (const c of "cat") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key(" ")); // commit "cat", advance to "dog"
    expect(engine.getState().wordIdx).toBe(1);

    engine.handleKeyDown(key("Backspace")); // nothing typed in "dog" yet
    const state = engine.getState();
    expect(state.wordIdx).toBe(0);
    // The caret moves to the end of "cat"; the correctly-typed 't' survives.
    // Returning to a word you left early should not cost you a character.
    expect(state.typed[0]).toBe("cat");
  });

  it("deletes only once the caret is inside the previous word", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    for (const c of "cat") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key(" "));
    engine.handleKeyDown(key("Backspace")); // step back only
    engine.handleKeyDown(key("Backspace")); // now delete
    expect(engine.getState().typed[0]).toBe("ca");
  });

  it("emits no event for a step-back, which deletes nothing", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    for (const c of "cat") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key(" "));
    const before = engine.getEvents().length;
    engine.handleKeyDown(key("Backspace"));
    // §3.1: one event per keydown that produces or deletes a character.
    expect(engine.getEvents().length).toBe(before);
  });

  // Regression: backspacing out of a skipped word used to move `wordIdx`
  // internally and then return false, so the caller skipped notify(). The
  // caret froze on screen while the engine's cursor had already moved, and the
  // next backspace appeared to jump two words at once.
  it("moves the caret one word at a time back through a skipped word", () => {
    const engine = createEngine(config, ["cat", "dog", "run"]);
    for (const c of "cat") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key(" ")); // -> "dog"
    engine.handleKeyDown(key(" ")); // skip "dog" entirely -> "run"
    expect(engine.getState().wordIdx).toBe(2);

    expect(engine.handleKeyDown(key("Backspace"))).not.toBe(false);
    expect(engine.getState().wordIdx).toBe(1); // lands on the skipped word

    engine.handleKeyDown(key("Backspace"));
    expect(engine.getState().wordIdx).toBe(0); // then onto "cat", not past it
    expect(engine.getState().typed[0]).toBe("cat");
  });

  it("notifies subscribers when a step-back moves the caret", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    for (const c of "cat") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key(" "));

    let notifications = 0;
    const unsubscribe = engine.subscribe(() => {
      notifications += 1;
    });
    engine.handleKeyDown(key("Backspace"));
    unsubscribe();

    // Without this the UI never learns the caret moved — the reported symptom.
    expect(notifications).toBeGreaterThan(0);
  });

  it("is a no-op at the very start of the test", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("Backspace", { timeStamp: 0 }));
    expect(engine.getEvents()).toHaveLength(0);
    expect(engine.getState().typed).toEqual([""]);
  });
});

describe("engine — ctrl/opt+backspace (word delete)", () => {
  it("clears the whole current word in a single event", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    engine.handleKeyDown(key("c"));
    engine.handleKeyDown(key("a"));
    engine.handleKeyDown(key("Backspace", { ctrlKey: true }));

    expect(engine.getState().typed).toEqual(["", ""]);
    const events = engine.getEvents();
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ kind: "word-delete" });
  });

  it("also accepts alt (opt) as the modifier", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("c"));
    engine.handleKeyDown(key("Backspace", { altKey: true }));
    expect(engine.getState().typed).toEqual([""]);
    expect(engine.getEvents().at(-1)?.kind).toBe("word-delete");
  });

  it("steps into and clears the previous word when the current word is already empty", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    for (const c of "cat") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key(" "));
    expect(engine.getState().wordIdx).toBe(1);

    engine.handleKeyDown(key("Backspace", { ctrlKey: true }));
    const state = engine.getState();
    expect(state.wordIdx).toBe(0);
    expect(state.typed[0]).toBe("");
  });

  it("produces one event per keydown, not one per character removed", () => {
    const engine = createEngine(config, ["typing"]);
    for (const c of "typ") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key("Backspace", { ctrlKey: true }));
    expect(engine.getEvents()).toHaveLength(4); // 3 chars + 1 word-delete
  });
});

describe("engine — extra characters", () => {
  it("records characters typed past a word's end as unmatched char events", () => {
    const engine = createEngine(config, ["cat"]);
    for (const c of "catdog") engine.handleKeyDown(key(c));

    const events = engine.getEvents();
    expect(events).toHaveLength(6);
    expect(events[3]).toMatchObject({ key: "d", expected: "", ok: false });
    expect(engine.getState().typed).toEqual(["catdog"]);

    const test = engine.finish(1000);
    expect(test.result.charsExtra).toBe(3);
    expect(test.result.charsCorrect).toBe(3);
    expect(test.result.charsIncorrect).toBe(0);
  });
});

describe("engine — missed characters", () => {
  it("counts remaining unattempted characters as missed when space commits an incomplete word", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    engine.handleKeyDown(key("c"));
    engine.handleKeyDown(key("a"));
    engine.handleKeyDown(key(" ")); // commit "ca" — "t" was never typed

    const test = engine.finish(500);
    expect(test.result.charsMissed).toBe(1);
    expect(test.result.charsCorrect).toBe(2);
  });

  it("does not count the final untouched word as missed — it was never attempted, not skipped", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    for (const c of "cat") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key(" "));
    // "dog" (word 1) is never typed at all.
    const test = engine.finish(500);
    expect(test.result.charsMissed).toBe(0);
  });
});

describe("engine — space handling", () => {
  it("records space as a char event and advances wordIdx", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    for (const c of "cat") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key(" ", { timeStamp: 40 }));

    const events = engine.getEvents();
    expect(events.at(-1)).toMatchObject({ key: " ", kind: "char", wordIdx: 0, ok: true });
    expect(engine.getState().wordIdx).toBe(1);
  });

  it("marks the space event ok:false when the word was committed incomplete", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    engine.handleKeyDown(key("c"));
    engine.handleKeyDown(key(" "));
    expect(engine.getEvents().at(-1)).toMatchObject({ ok: false });
  });

  it("ignores a leading space on an empty first word", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key(" "));
    expect(engine.getEvents()).toHaveLength(0);
    expect(engine.getState().wordIdx).toBe(0);
  });
});

describe("engine — e.repeat exclusion", () => {
  it("does not record or process held-key repeat events", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("c", { timeStamp: 0 }));
    engine.handleKeyDown(key("c", { timeStamp: 20, repeat: true }));
    engine.handleKeyDown(key("c", { timeStamp: 40, repeat: true }));

    expect(engine.getEvents()).toHaveLength(1);
    expect(engine.getState().typed).toEqual(["c"]);
  });

  it("excludes repeated backspace the same way", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("c"));
    engine.handleKeyDown(key("a"));
    engine.handleKeyDown(key("Backspace"));
    engine.handleKeyDown(key("Backspace", { repeat: true }));
    expect(engine.getState().typed).toEqual(["c"]);
  });
});

describe("engine — IME composition", () => {
  it("ignores keydowns between compositionstart and compositionend", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleCompositionStart();
    engine.handleKeyDown(key("a", { timeStamp: 0 })); // mid-composition — ignored
    engine.handleCompositionEnd();
    engine.handleKeyDown(key("c", { timeStamp: 10 })); // real keystroke after

    expect(engine.getEvents()).toHaveLength(1);
    expect(engine.getEvents()[0]).toMatchObject({ key: "c" });
  });

  it("also respects e.isComposing directly", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("a", { isComposing: true }));
    expect(engine.getEvents()).toHaveLength(0);
  });
});

describe("engine — rapid input ordering", () => {
  it("preserves event order for synchronous back-to-back keydowns", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("c", { timeStamp: 0 }));
    engine.handleKeyDown(key("a", { timeStamp: 1 }));
    engine.handleKeyDown(key("t", { timeStamp: 2 }));

    const events = engine.getEvents();
    expect(events.map((e) => e.key)).toEqual(["c", "a", "t"]);
    expect(events.map((e) => e.t)).toEqual([0, 1, 2]);
  });
});

describe("engine — non-content keys", () => {
  it("ignores Tab/Enter/Escape/arrow keys entirely", () => {
    const engine = createEngine(config, ["cat"]);
    for (const k of ["Tab", "Enter", "Escape", "ArrowLeft", "Shift", "Control"]) {
      engine.handleKeyDown(key(k));
    }
    expect(engine.getEvents()).toHaveLength(0);
    expect(engine.getState().status).toBe("waiting");
  });
});

describe("engine — bigram context (prev)", () => {
  it("is null for the first character and carries the preceding expected char thereafter", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("c"));
    engine.handleKeyDown(key("a"));
    engine.handleKeyDown(key("t"));
    const events = engine.getEvents();
    expect(events[0].prev).toBeNull();
    expect(events[1].prev).toBe("c");
    expect(events[2].prev).toBe("a");
  });
});

describe("engine — isDone / finish", () => {
  it("isDone becomes true once the last word is fully typed", () => {
    const engine = createEngine(config, ["cat", "dog"]);
    for (const c of "cat") engine.handleKeyDown(key(c));
    engine.handleKeyDown(key(" "));
    expect(engine.isDone()).toBe(false);
    for (const c of "dog") engine.handleKeyDown(key(c));
    expect(engine.isDone()).toBe(true);
  });

  it("finish() marks status finished and further keydowns are ignored", () => {
    const engine = createEngine(config, ["cat"]);
    engine.handleKeyDown(key("c", { timeStamp: 0 }));
    engine.finish(1000);
    expect(engine.getState().status).toBe("finished");
    engine.handleKeyDown(key("a", { timeStamp: 2000 }));
    expect(engine.getEvents()).toHaveLength(1); // the post-finish keydown was dropped
  });

  it("produces a well-formed CompletedTest", () => {
    const engine = createEngine(
      config,
      ["cat"],
      { id: "test-id", deviceId: "device-1", appVersion: "9.9.9", source: "freeplay" }
    );
    engine.handleKeyDown(key("c", { timeStamp: 0 }));
    engine.handleKeyDown(key("a", { timeStamp: 100 }));
    engine.handleKeyDown(key("t", { timeStamp: 200 }));
    const test = engine.finish(300);

    expect(test.id).toBe("test-id");
    expect(test.deviceId).toBe("device-1");
    expect(test.appVersion).toBe("9.9.9");
    expect(test.source).toBe("freeplay");
    expect(test.syncedAt).toBeNull();
    expect(test.durationMs).toBe(300);
    expect(test.events).toHaveLength(3);
    expect(test.result.charsCorrect).toBe(3);
  });
});
