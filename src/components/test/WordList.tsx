"use client";

/**
 * The visible word window.
 *
 * The generated buffer is large — time mode sizes it for a fast typist on a
 * long timer, so it can run to hundreds of words. Rendering all of them filled
 * and overflowed the page (measured: 200 words, 25 lines, 1312px against a
 * 727px viewport). A typing test shows the line you are on plus what is coming;
 * everything else is clipped and scrolled past.
 *
 * Scrolling is a transform on the inner element, recomputed only when the
 * active word index changes — that is once per space, never per keystroke, so
 * CLAUDE.md invariant 3 still holds. The per-keystroke work stays inside each
 * `Word` (see Word.tsx) via its own useSyncExternalStore subscription.
 */

import { memo, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EngineHandle } from "@/lib/engine/engine";
import { Word } from "./Word";

type WordListProps = {
  engine: EngineHandle;
  words: string[];
};

/** How many lines of text are visible at once. */
const VISIBLE_LINES = 3;

/**
 * Line height in rem, stated once. Row pitch must equal this exactly, so the
 * container is a whole number of lines and a scrolled line lands flush rather
 * than half-clipped — which is why there is no row gap. Vertical breathing room
 * comes from the leading itself.
 */
const LINE_HEIGHT_REM = 3.25;

function WordListImpl({ engine, words }: WordListProps) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [offsetPx, setOffsetPx] = useState(0);

  const wordIdx = useSyncExternalStore(
    engine.subscribe,
    () => engine.getWordIdx(),
    () => 0
  );

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const active = inner.querySelector<HTMLElement>(`[data-word-idx="${wordIdx}"]`);
    if (!active) return;
    // offsetTop is measured against the inner element, so it already accounts
    // for wrapping — no need to know how many words fit on a line.
    setOffsetPx(active.offsetTop);
  }, [wordIdx, words]);

  return (
    <div
      className="overflow-hidden"
      style={{ height: `${VISIBLE_LINES * LINE_HEIGHT_REM}rem` }}
      data-testid="word-window"
    >
      <div
        ref={innerRef}
        className="flex flex-wrap gap-x-3 font-[family-name:var(--font-type)] text-[2rem]"
        style={{
          lineHeight: `${LINE_HEIGHT_REM}rem`,
          transform: `translateY(-${offsetPx}px)`,
        }}
        data-testid="word-list"
      >
        {words.map((word, idx) => (
          <Word key={idx} engine={engine} word={word} idx={idx} />
        ))}
      </div>
    </div>
  );
}

export const WordList = memo(WordListImpl);
