"use client";

/**
 * The full word list. Renders once per test (mount) plus once per word boundary
 * (space) — never per keystroke. `words` and `engine` are stable references for
 * the lifetime of a test, so memo keeps this from re-rendering even if a parent
 * re-renders for unrelated reasons (e.g. the timer ticking).
 *
 * The per-keystroke work all happens inside each `Word` (see Word.tsx) via its
 * own useSyncExternalStore subscription — this component does not subscribe to
 * the engine at all.
 */

import { memo } from "react";
import type { EngineHandle } from "@/lib/engine/engine";
import { Word } from "./Word";

type WordListProps = {
  engine: EngineHandle;
  words: string[];
};

function WordListImpl({ engine, words }: WordListProps) {
  return (
    <div
      className="flex flex-wrap gap-x-3 gap-y-2 font-[family-name:var(--font-type)] text-[2rem] leading-relaxed"
      data-testid="word-list"
    >
      {words.map((word, idx) => (
        <Word key={idx} engine={engine} word={word} idx={idx} />
      ))}
    </div>
  );
}

export const WordList = memo(WordListImpl);
