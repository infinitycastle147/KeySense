/**
 * The typing engine — a framework-free capture + state machine.
 *
 * This file must never import React. It is the sensor at the bottom of the whole
 * product (docs/ARCHITECTURE.md §3): every downstream metric, diagnosis, and
 * prescription is only as good as what gets captured here, so this is unit
 * tested in isolation from any rendering concerns.
 *
 * Two rules that break silently if violated (see .claude/skills/typing-engine):
 *   1. Timing comes from `event.timeStamp`, never `performance.now()` inside
 *      `handleKeyDown`. `finish()` is the one exception — test *duration* isn't a
 *      per-keystroke latency measurement, so `performance.now()` there is fine
 *      and shares the same clock base as `event.timeStamp`.
 *   2. No React state here at all — this module only holds refs-equivalent
 *      plain closures and a minimal pub/sub for `useSyncExternalStore`.
 */

import type {
  CompletedTest,
  KeyEvent,
  KeyEventKind,
  TestConfig,
  TestSource,
} from "@/lib/types";
import { computeResult } from "./stats";

export type EngineStatus = "waiting" | "running" | "finished";

/** Snapshot of engine state for rendering. Cheap to build; only rebuilt when
 *  something actually changed (see `notify` below). */
export type EngineState = {
  status: EngineStatus;
  words: string[];
  typed: string[];
  wordIdx: number;
  charIdx: number;
};

export type EngineOptions = {
  id?: string;
  deviceId?: string;
  appVersion?: string;
  source?: TestSource;
  prescriptionId?: string | null;
};

export type EngineHandle = {
  handleKeyDown: (e: KeyboardEvent) => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  /** Full snapshot — cheap, but prefer the per-field selectors below inside
   *  components that subscribe via useSyncExternalStore, so unrelated re-renders
   *  don't cascade (see src/components/test). */
  getState: () => EngineState;
  getEvents: () => KeyEvent[];
  getWords: () => string[];
  getStatus: () => EngineStatus;
  getWordIdx: () => number;
  getCharIdx: () => number;
  getWordTyped: (idx: number) => string;
  /** True once every word has been advanced past — the signal that "words" /
   *  "quote" mode should call `finish()`. "time" mode ends on its own timer and
   *  never needs this. */
  isDone: () => boolean;
  subscribe: (listener: () => void) => () => void;
  finish: (endTimeStamp?: number) => CompletedTest;
};

function modsFrom(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.shiftKey) mods.push("shift");
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  return mods;
}

export function createEngine(
  config: TestConfig,
  words: string[],
  opts: EngineOptions = {}
): EngineHandle {
  const events: KeyEvent[] = [];
  const typed: string[] = words.map(() => "");
  let wordIdx = 0;
  let status: EngineStatus = "waiting";
  let startTs: number | null = null; // event.timeStamp of the first real keystroke
  let startedAtIso: string | null = null;
  let composing = false;
  /** Bigram context: the expected char of the most recent forward-typed
   *  character. Not updated by corrections — see KeyEvent.prev docs. */
  let prevExpected: string | null = null;

  const listeners = new Set<() => void>();
  function notify() {
    for (const l of listeners) l();
  }

  function expectedAt(wIdx: number, cIdx: number): string {
    const w = words[wIdx] ?? "";
    return cIdx < w.length ? w[cIdx] : "";
  }

  function pushEvent(
    t: number,
    key: string,
    expected: string,
    ok: boolean,
    kind: KeyEventKind,
    atWordIdx: number,
    atCharIdx: number,
    mods: string[],
    missed?: number
  ) {
    events.push({
      t,
      key,
      expected,
      ok,
      wordIdx: atWordIdx,
      charIdx: atCharIdx,
      prev: prevExpected,
      mods,
      kind,
      ...(missed !== undefined && missed > 0 ? { missed } : {}),
    });
  }

  /** A normal printable character (letter, digit, punctuation, or space) typed
   *  at the current caret position. Returns true if state changed. */
  function handleChar(key: string, t: number, mods: string[]): boolean {
    const cIdx = typed[wordIdx]?.length ?? 0;
    const expected = expectedAt(wordIdx, cIdx);
    const ok = expected !== "" && key === expected;
    typed[wordIdx] = (typed[wordIdx] ?? "") + key;
    pushEvent(t, key, expected, ok, "char", wordIdx, cIdx, mods);
    if (expected !== "") prevExpected = expected; // extras don't advance bigram context
    return true;
  }

  /** Space: recorded as a char event *and* advances wordIdx — both, always
   *  (docs/ARCHITECTURE.md §3.1). Leading space on an empty first word is a
   *  no-op (nothing to commit, nowhere to go back from). */
  function handleSpace(t: number, mods: string[]): boolean {
    const cIdx = typed[wordIdx]?.length ?? 0;
    if (cIdx === 0 && wordIdx === 0) return false;
    const word = words[wordIdx] ?? "";
    const ok = cIdx === word.length;
    // Characters skipped by committing early. Recorded here rather than as
    // synthetic events, since an omission has no keydown of its own.
    const missed = Math.max(0, word.length - cIdx);
    pushEvent(t, " ", " ", ok, "char", wordIdx, cIdx, mods, missed);
    prevExpected = " ";
    wordIdx += 1;
    return true;
  }

  /** Single-character backspace. At the start of a word, steps back into the
   *  previous word (freedom-mode style correction) rather than doing nothing —
   *  monkeytype's reference behaviour, see docs/ARCHITECTURE.md §1. */
  function handleBackspace(t: number, mods: string[]): boolean {
    if ((typed[wordIdx]?.length ?? 0) === 0) {
      if (wordIdx === 0) return false;
      wordIdx -= 1;
    }
    const cIdx = typed[wordIdx].length;
    if (cIdx === 0) return false;
    const removedChar = typed[wordIdx][cIdx - 1];
    const expected = expectedAt(wordIdx, cIdx - 1);
    const wasOk = expected !== "" && removedChar === expected;
    typed[wordIdx] = typed[wordIdx].slice(0, -1);
    pushEvent(t, removedChar, expected, wasOk, "backspace", wordIdx, cIdx - 1, mods);
    return true;
  }

  /** ctrl/opt+backspace: deletes the rest of the current word in one keydown,
   *  or steps into the previous word and clears it if already empty. Recorded
   *  as a single "word-delete" event — one record per keydown (§3.1), not one
   *  per character removed. */
  function handleWordDelete(t: number, mods: string[]): boolean {
    if ((typed[wordIdx]?.length ?? 0) === 0) {
      if (wordIdx === 0) return false;
      wordIdx -= 1;
    }
    if (typed[wordIdx].length === 0) return false;
    typed[wordIdx] = "";
    pushEvent(t, "", "", false, "word-delete", wordIdx, 0, mods);
    return true;
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (composing || e.isComposing) return; // ignore mid-IME-composition events
    if (e.repeat) return; // held keys are excluded, not recorded — see PHASE-1.md
    if (status === "finished") return;

    const key = e.key;
    const isBackspace = key === "Backspace";
    const isSpace = key === " " || key === "Spacebar";
    const isPrintable = key.length === 1;

    if (!isBackspace && !isSpace && !isPrintable) return; // navigation/modifier/etc — not content

    if (status === "waiting") {
      status = "running";
      startTs = e.timeStamp; // t=0 reference — the ONLY place this is set
      startedAtIso = new Date().toISOString();
    }

    // Correct by construction: t always derives from e.timeStamp, never from a
    // clock read inside this handler.
    const t = e.timeStamp - (startTs ?? e.timeStamp);
    const mods = modsFrom(e);

    let changed: boolean;
    if (isBackspace && (e.ctrlKey || e.altKey || e.metaKey)) {
      changed = handleWordDelete(t, mods);
    } else if (isBackspace) {
      changed = handleBackspace(t, mods);
    } else if (isSpace) {
      changed = handleSpace(t, mods);
    } else {
      changed = handleChar(key, t, mods);
    }

    if (changed) notify();
  }

  function handleCompositionStart() {
    composing = true;
  }
  function handleCompositionEnd() {
    composing = false;
  }

  function getState(): EngineState {
    return {
      status,
      words,
      typed: typed.slice(),
      wordIdx,
      charIdx: typed[wordIdx]?.length ?? 0,
    };
  }

  function getEvents(): KeyEvent[] {
    return events.slice();
  }

  function isDone(): boolean {
    if (words.length === 0) return false;
    const lastIdx = words.length - 1;
    if (wordIdx < lastIdx) return false;
    if (wordIdx > lastIdx) return true;
    return (typed[lastIdx]?.length ?? 0) >= (words[lastIdx]?.length ?? 0);
  }

  function finish(endTimeStamp?: number): CompletedTest {
    status = "finished";
    const endedAtIso = new Date().toISOString();
    const now = endTimeStamp ?? performance.now();
    const durationMs = startTs === null ? 0 : Math.max(0, now - startTs);
    const result = computeResult(words, typed, events, durationMs);

    const test: CompletedTest = {
      id: opts.id ?? crypto.randomUUID(),
      startedAt: startedAtIso ?? endedAtIso,
      endedAt: endedAtIso,
      durationMs,
      config,
      result,
      events: events.slice(),
      source: opts.source ?? "freeplay",
      prescriptionId: opts.prescriptionId ?? null,
      deviceId: opts.deviceId ?? "unknown",
      appVersion: opts.appVersion ?? "0.1.0",
      syncedAt: null,
    };

    notify();
    return test;
  }

  return {
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd,
    getState,
    getEvents,
    getWords: () => words,
    getStatus: () => status,
    getWordIdx: () => wordIdx,
    getCharIdx: () => typed[wordIdx]?.length ?? 0,
    getWordTyped: (idx: number) => typed[idx] ?? "",
    isDone,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    finish,
  };
}
