"use client";

/**
 * A single word. This is the component the invariant in CLAUDE.md #3 is about:
 * on every keystroke, only the active Word's snapshot changes, so only the
 * active Word re-renders — every other Word bails out of useSyncExternalStore's
 * Object.is comparison before React touches its DOM.
 *
 * Deliberately subscribes to two *primitive* selectors (a string, a boolean)
 * rather than one object selector — an object literal would be a new reference
 * every call and defeat the Object.is bailout that makes this cheap.
 */

import { memo, useSyncExternalStore, type ReactNode } from "react";
import type { EngineHandle } from "@/lib/engine/engine";
import { Caret } from "./Caret";

type WordProps = {
  engine: EngineHandle;
  word: string;
  idx: number;
};

function useWordTyped(engine: EngineHandle, idx: number): string {
  return useSyncExternalStore(
    engine.subscribe,
    () => engine.getWordTyped(idx),
    () => ""
  );
}

function useIsActiveWord(engine: EngineHandle, idx: number): boolean {
  return useSyncExternalStore(
    engine.subscribe,
    () => engine.getWordIdx() === idx,
    () => idx === 0
  );
}

function WordImpl({ engine, word, idx }: WordProps) {
  const typed = useWordTyped(engine, idx);
  const isActive = useIsActiveWord(engine, idx);

  const length = Math.max(word.length, typed.length);
  const chars: ReactNode[] = [];

  for (let i = 0; i < length; i++) {
    if (isActive && i === typed.length) {
      chars.push(<Caret key="caret" />);
    }

    const expectedChar = i < word.length ? word[i] : null;
    const typedChar = i < typed.length ? typed[i] : null;

    let className = "text-type-untyped";
    let display = expectedChar ?? "";
    if (typedChar !== null) {
      if (expectedChar === null) {
        className = "text-flag"; // extra — typed past the word's end
        display = typedChar;
      } else if (typedChar === expectedChar) {
        className = "text-type-correct";
      } else {
        className = "text-type-incorrect";
      }
    }

    chars.push(
      <span key={i} className={className}>
        {display}
      </span>
    );
  }

  // Caret sits after the last character when the word is fully (or over-) typed.
  if (isActive && typed.length === length) {
    chars.push(<Caret key="caret" />);
  }

  return (
    <span
      className="inline-flex whitespace-pre"
      data-word-idx={idx}
      data-active={isActive || undefined}
    >
      {chars}
    </span>
  );
}

export const Word = memo(WordImpl);
