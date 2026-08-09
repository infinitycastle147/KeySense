"use client";

/**
 * Runs one prescribed drill session — PHASE-5.md §3. A deliberately smaller
 * sibling of src/components/test/TypingTest.tsx (out of bounds for this
 * phase to modify): a fixed word list, no mode switching, no config bar. The
 * per-keystroke capture path (engine + WordList) is reused unmodified —
 * duplicating capture logic would risk the "budget: <16ms keydown to caret
 * paint" rule TypingTest.tsx already satisfies.
 *
 * On completion: saves the test locally (source "prescribed", tagged with
 * this prescription's id — CLAUDE.md invariant 7's offline-first rule still
 * applies here, same as any other test), then tells the server a drill
 * finished so drills_done can advance and, once the target is met,
 * evaluate() can run (src/app/api/prescriptions/[id]/drills/route.ts).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createEngine, type EngineHandle } from "@/lib/engine/engine";
import { getDeviceId, saveTest } from "@/lib/db/local";
import { buildDrillWords } from "@/lib/drills/loader";
import { WordList } from "@/components/test/WordList";
import { TestTimer } from "@/components/test/TestTimer";
import type { CompletedTest, Prescription, TestConfig } from "@/lib/types";

const APP_VERSION = "0.1.0";

function useEngineWordIdx(engine: EngineHandle | null): number {
  return useSyncExternalStore(
    useCallback((cb) => (engine ? engine.subscribe(cb) : () => {}), [engine]),
    () => engine?.getWordIdx() ?? 0,
    () => 0,
  );
}

export type DrillResponse = {
  prescription: Prescription;
  evaluated: boolean;
  verdict?: Prescription["verdict"];
  reason?: string;
};

type DrillRunnerProps = {
  prescription: Prescription;
  onComplete: (test: CompletedTest, response: DrillResponse | null) => void;
  onCancel: () => void;
};

function targetLabel(prescription: Prescription): string {
  return `${prescription.targetType}: ${prescription.targets.join(", ")}`;
}

export function DrillRunner({ prescription, onComplete, onCancel }: DrillRunnerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const completedRef = useRef(false);

  const [engine, setEngine] = useState<EngineHandle | null>(null);
  const [words, setWords] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const wordIdx = useEngineWordIdx(engine);

  useEffect(() => {
    let cancelled = false;
    buildDrillWords(prescription)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.length === 0) {
          setLoadError("Could not assemble any drill words for this prescription.");
          return;
        }
        const config: TestConfig = {
          mode: "drill",
          modeSetting: String(loaded.length),
          language: prescription.drillConfig.corpus,
          layout: "qwerty",
          punctuation: false,
          numbers: false,
        };
        setEngine(
          createEngine(config, loaded, {
            deviceId: getDeviceId(),
            appVersion: APP_VERSION,
            source: "prescribed",
            prescriptionId: prescription.id,
          }),
        );
        setWords(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [prescription]);

  const complete = useCallback(
    (endTimeStamp?: number) => {
      if (!engine || completedRef.current) return;
      completedRef.current = true;
      const test = engine.finish(endTimeStamp);
      setSubmitting(true);

      void saveTest(test)
        .catch((err) => {
          console.error("Failed to persist drill test to IndexedDB:", err);
        })
        .then(() =>
          fetch(`/api/prescriptions/${prescription.id}/drills`, { method: "POST" })
            .then((res) => (res.ok ? (res.json() as Promise<DrillResponse>) : null))
            .catch(() => null),
        )
        .then((response) => {
          setSubmitting(false);
          onComplete(test, response ?? null);
        });
    },
    [engine, onComplete, prescription.id],
  );

  useEffect(() => {
    if (!engine || !words) return;
    return engine.subscribe(() => {
      if (engine.isDone()) complete();
    });
  }, [engine, words, complete]);

  useEffect(() => {
    if (words) inputRef.current?.focus();
  }, [words]);

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
      if (!isContentKey) return;
      e.preventDefault();
      engine?.handleKeyDown(native);
    },
    [engine],
  );

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-4">
        <p className="label-type text-flag">Failed to load drill — {loadError}</p>
        <button type="button" onClick={onCancel} className="label-type text-muted-foreground underline">
          back
        </button>
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
        aria-label="Drill input"
        onKeyDown={onKeyDown}
        onCompositionStart={() => engine?.handleCompositionStart()}
        onCompositionEnd={() => engine?.handleCompositionEnd()}
        onChange={() => {
          /* value intentionally discarded — the engine is the source of truth */
        }}
        disabled={submitting}
      />

      <div className="flex w-full items-center justify-between">
        <p className="label-type text-muted-foreground">
          prescribed drill — {targetLabel(prescription)}
        </p>
        <button type="button" onClick={onCancel} className="label-type text-muted-foreground underline">
          cancel
        </button>
      </div>

      <TestTimer
        mode="drill"
        remainingSeconds={null}
        wordProgress={words ? { current: Math.min(wordIdx + 1, words.length), total: words.length } : null}
      />

      <div className="min-h-[8rem] w-full">
        {words && engine ? (
          <WordList engine={engine} words={words} />
        ) : (
          <div className="label-type text-muted-foreground">loading…</div>
        )}
      </div>

      {submitting && <p className="label-type text-muted-foreground">saving…</p>}
    </div>
  );
}
