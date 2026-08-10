"use client";

/**
 * Owns the engine and the test lifecycle. Per docs/DESIGN.md §7 the test
 * screen is sacred: no chrome while running, nothing animated but the caret,
 * colour only from the four typing-surface states.
 *
 * State that changes per keystroke never lives in useState here — it lives
 * inside the engine (see src/lib/engine/engine.ts), and this component reads
 * it via useSyncExternalStore selectors that return primitives, so a keystroke
 * only re-renders this component when a *boundary* is crossed (status flips,
 * word advances) — never on every character. See Word.tsx for where the
 * actual per-character re-render happens.
 *
 * The engine instance itself lives in useState, not useRef: it is created once
 * per test (on config load), never mutated per keystroke, so reading it during
 * render is normal React state, not a hot-path access — see engine.getState()
 * vs. the useSyncExternalStore selectors for what *is* hot-path.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createEngine, type EngineHandle, type EngineStatus } from "@/lib/engine/engine";
import { generateWords, getQuote } from "@/lib/engine/wordsource";
import { getDeviceId, saveTest } from "@/lib/db/local";
import type { CompletedTest, TestConfig } from "@/lib/types";
import { WordList } from "./WordList";
import { TestConfigBar } from "./TestConfigBar";
import { TestTimer } from "./TestTimer";
import { recordKeydownLatency } from "@/lib/engine/latency-probe";

const APP_VERSION = "0.1.0";

function parseModeSetting(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Words are fetched once up front — see PHASE-1.md §1. For "time"/"zen" the
 *  exact count needed isn't known ahead of time, so a generous buffer is
 *  generated; a very fast typist on a long timer could theoretically exhaust
 *  it (known Phase-1 limitation, noted in the handoff report). */
async function loadWordsForConfig(config: TestConfig): Promise<string[]> {
  if (config.mode === "quote") {
    const quote = await getQuote(config.language);
    return quote.words;
  }
  if (config.mode === "words" || config.mode === "drill") {
    const count = parseModeSetting(config.modeSetting, 25);
    return generateWords(count, config);
  }
  // time | zen
  const seconds = config.mode === "time" ? parseModeSetting(config.modeSetting, 30) : 120;
  const count = Math.max(80, Math.ceil((seconds / 60) * 320) + 40);
  return generateWords(count, config);
}

function useEngineStatus(engine: EngineHandle | null): EngineStatus {
  return useSyncExternalStore(
    useCallback((cb) => (engine ? engine.subscribe(cb) : () => {}), [engine]),
    () => engine?.getStatus() ?? "waiting",
    () => "waiting"
  );
}

function useEngineWordIdx(engine: EngineHandle | null): number {
  return useSyncExternalStore(
    useCallback((cb) => (engine ? engine.subscribe(cb) : () => {}), [engine]),
    () => engine?.getWordIdx() ?? 0,
    () => 0
  );
}

type TypingTestProps = {
  config: TestConfig;
  onConfigChange: (config: TestConfig) => void;
  onComplete: (test: CompletedTest) => void;
  onRestart: () => void;
};

export function TypingTest({
  config,
  onConfigChange,
  onComplete,
  onRestart,
}: TypingTestProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const runStartRef = useRef<number | null>(null);
  const completedRef = useRef(false);

  const [engine, setEngine] = useState<EngineHandle | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [configOverride, setConfigOverride] = useState(false);

  const status = useEngineStatus(engine);
  const wordIdx = useEngineWordIdx(engine);

  const complete = useCallback(
    (endTimeStamp?: number) => {
      if (!engine || completedRef.current) return;
      completedRef.current = true;
      const test = engine.finish(endTimeStamp);
      void saveTest(test).catch((err) => {
        console.error("Failed to persist test to IndexedDB:", err);
      });
      onComplete(test);
    },
    [engine, onComplete]
  );

  // Load words + create a fresh engine whenever the config changes (including
  // on restart, since the parent remounts this component with a new key). All
  // state updates happen inside the async continuation, not the effect body
  // itself, so this stays a single batched update rather than a synchronous
  // reset-then-load render cascade.
  useEffect(() => {
    let cancelled = false;
    completedRef.current = false;
    runStartRef.current = null;

    loadWordsForConfig(config)
      .then((loaded) => {
        if (cancelled) return;
        setEngine(
          createEngine(config, loaded, {
            deviceId: getDeviceId(),
            appVersion: APP_VERSION,
          })
        );
        setWords(loaded);
        setLoadError(null);
        setRemainingSeconds(
          config.mode === "time" ? parseModeSetting(config.modeSetting, 30) : null
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run on any config field
  }, [config.mode, config.modeSetting, config.language, config.punctuation, config.numbers]);

  // words/quote/drill modes end themselves once every word has been advanced
  // past; time/zen end via the timer / a manual stop instead.
  useEffect(() => {
    if (!engine || !words) return;
    if (config.mode === "time" || config.mode === "zen") return;
    return engine.subscribe(() => {
      if (engine.isDone()) complete();
    });
  }, [engine, words, config.mode, complete]);

  // Countdown for "time" mode.
  useEffect(() => {
    if (config.mode !== "time" || status !== "running") return;
    const totalSeconds = parseModeSetting(config.modeSetting, 30);
    if (runStartRef.current === null) runStartRef.current = performance.now();

    const id = window.setInterval(() => {
      const startedAt = runStartRef.current ?? performance.now();
      const elapsed = (performance.now() - startedAt) / 1000;
      const remaining = totalSeconds - elapsed;
      setRemainingSeconds(Math.max(0, remaining));
      if (remaining <= 0) {
        window.clearInterval(id);
        complete();
      }
    }, 200);

    return () => window.clearInterval(id);
  }, [status, config.mode, config.modeSetting, complete]);

  // Escape reveals the config bar mid-test — docs/phases/PHASE-1.md §6.
  useEffect(() => {
    function onWindowKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && status === "running") {
        setConfigOverride((v) => !v);
      }
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [status]);

  // Autofocus the capture input so typing works immediately on load.
  useEffect(() => {
    if (words) inputRef.current?.focus();
  }, [words]);

  // Tell the shell to get out of the way — docs/DESIGN.md §7: no chrome while
  // a test is running. Signalled through a body attribute rather than React
  // context so the nav never re-renders on the typing path; it fades in CSS.
  // Fires on status transitions only, not per keystroke.
  useEffect(() => {
    const running = status === "running";
    if (running) document.body.dataset.typing = "true";
    else delete document.body.dataset.typing;
    return () => {
      delete document.body.dataset.typing;
    };
  }, [status]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      const native = e.nativeEvent;
      if (native.isComposing) {
        engine?.handleKeyDown(native);
        return;
      }
      const key = native.key;
      const isContentKey =
        key === "Backspace" || key === " " || key === "Spacebar" || key.length === 1;
      if (!isContentKey) return; // let Tab/Enter/Escape/arrows fall through untouched

      // Prevent the (visually hidden) input from also inserting the character —
      // the engine is the single source of truth for what was "typed".
      e.preventDefault();
      engine?.handleKeyDown(native);
      // No-op unless the probe was explicitly enabled — see latency-probe.ts.
      recordKeydownLatency(native.timeStamp);
    },
    [engine]
  );

  /**
   * Key releases. Passed through unfiltered — unlike keydown, there is no key
   * class to exclude here: a release carries no content, so recording every one
   * costs nothing and filtering risks dropping the release of a key whose press
   * we did record. The engine ignores releases outside a running test.
   *
   * No `preventDefault`: a keyup has no default to prevent, and calling it
   * would put work on the input path for no reason.
   */
  const onKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      engine?.handleKeyUp(e.nativeEvent);
    },
    [engine],
  );

  const configVisible = status !== "running" || configOverride;
  const wordProgress =
    words && (config.mode === "words" || config.mode === "quote" || config.mode === "drill")
      ? { current: Math.min(wordIdx + 1, words.length), total: words.length }
      : null;

  if (loadError) {
    return (
      <div className="label-type text-flag">
        Failed to load word data — {loadError}
      </div>
    );
  }

  return (
    <div
      className="flex w-full max-w-4xl flex-col items-center gap-8"
      onClick={() => inputRef.current?.focus()}
    >
      <input
        ref={inputRef}
        type="text"
        className="sr-only"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label="Typing test input"
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onCompositionStart={() => engine?.handleCompositionStart()}
        onCompositionEnd={() => engine?.handleCompositionEnd()}
        onChange={() => {
          /* value intentionally discarded — see onKeyDown */
        }}
        disabled={status === "finished"}
      />

      <button
        type="button"
        onClick={onRestart}
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-1/2 focus:-translate-x-1/2 focus:rounded focus:bg-trace focus:px-3 focus:py-1 focus:text-background focus:label-type"
      >
        restart (enter)
      </button>

      <TestConfigBar
        config={config}
        onConfigChange={onConfigChange}
        onRestart={onRestart}
        visible={configVisible}
      />

      <TestTimer mode={config.mode} remainingSeconds={remainingSeconds} wordProgress={wordProgress} />

      <div className="min-h-[8rem] w-full">
        {words && engine ? (
          <WordList engine={engine} words={words} />
        ) : (
          <div className="label-type text-muted-foreground">loading…</div>
        )}
      </div>

      {/* Kept in flow and faded rather than unmounted. Removing it shortened
          the vertically-centred column, so the words jumped down ~25px on the
          first keystroke — the worst possible moment for the text to move. */}
      <p
        aria-hidden={!(status === "waiting" && words)}
        className={`label-type text-muted-foreground transition-opacity duration-200 ${
          status === "waiting" && words ? "opacity-100" : "opacity-0"
        }`}
      >
        start typing to begin
      </p>
    </div>
  );
}
