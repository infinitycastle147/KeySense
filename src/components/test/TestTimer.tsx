"use client";

/**
 * Progress readout above the test — remaining seconds for "time" mode, word
 * count for "words"/"quote". Driven by plain React state ticking at 1Hz from
 * TypingTest, not by the engine's per-keystroke subscription — this is display
 * bookkeeping, not capture, so it is exempt from the re-render budget that
 * governs the word list.
 */

type TestTimerProps = {
  mode: "time" | "words" | "quote" | "zen" | "drill";
  remainingSeconds: number | null;
  wordProgress: { current: number; total: number } | null;
};

export function TestTimer({ mode, remainingSeconds, wordProgress }: TestTimerProps) {
  const content =
    mode === "time" && remainingSeconds !== null
      ? String(Math.max(0, Math.ceil(remainingSeconds)))
      : wordProgress
        ? `${wordProgress.current}/${wordProgress.total}`
        : null;

  return (
    <div className="h-10 font-[family-name:var(--font-display)] text-2xl text-trace tabular-nums">
      {content ?? " "}
    </div>
  );
}
