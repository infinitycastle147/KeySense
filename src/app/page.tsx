"use client";

/**
 * The test screen — docs/DESIGN.md §7: sacred, no chrome, no ambient motion.
 * This route owns TestConfig and the completed-test/result handoff; all
 * per-keystroke state lives inside the engine (src/lib/engine/engine.ts).
 */

import { useState } from "react";
import { TypingTest } from "@/components/test/TypingTest";
import { ResultsScreen } from "@/components/results/ResultsScreen";
import type { CompletedTest, TestConfig } from "@/lib/types";

const DEFAULT_CONFIG: TestConfig = {
  mode: "time",
  modeSetting: "30",
  language: "english",
  layout: "qwerty",
  punctuation: false,
  numbers: false,
};

export default function Home() {
  const [config, setConfig] = useState<TestConfig>(DEFAULT_CONFIG);
  const [runId, setRunId] = useState(0);
  const [result, setResult] = useState<CompletedTest | null>(null);

  function handleRestart() {
    setResult(null);
    setRunId((n) => n + 1);
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-8">
      {result ? (
        <ResultsScreen test={result} onRestart={handleRestart} />
      ) : (
        <TypingTest
          key={runId}
          config={config}
          onConfigChange={setConfig}
          onComplete={setResult}
          onRestart={handleRestart}
        />
      )}
    </main>
  );
}
