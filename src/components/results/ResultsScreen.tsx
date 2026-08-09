"use client";

/**
 * The reward screen — docs/DESIGN.md §10: "results screen is the reward,"
 * motion and colour belong here, not on the test screen.
 *
 * Phase 1 owns headline stats. The cardiograph replay (docs/DESIGN.md §5, the
 * product's signature) is Phase 3's — it mounts below the headline stats,
 * replaying the raw event log as a waveform.
 */

import { Button } from "@/components/ui/button";
import { Trace } from "@/components/results/Trace";
import type { CompletedTest } from "@/lib/types";
import { cn } from "@/lib/utils";

type ResultsScreenProps = {
  test: CompletedTest;
  onRestart: () => void;
};

function StatTile({
  label,
  value,
  unit,
  emphasis = false,
}: {
  label: string;
  value: string;
  unit?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label-type text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-[family-name:var(--font-display)] tabular-nums",
          emphasis ? "text-[4.5rem] leading-none text-trace" : "text-[2.5rem] leading-none"
        )}
      >
        {value}
        {unit && <span className="ml-1 text-lg text-muted-foreground">{unit}</span>}
      </span>
    </div>
  );
}

export function ResultsScreen({ test, onRestart }: ResultsScreenProps) {
  const { result, config } = test;
  const seconds = test.durationMs / 1000;

  return (
    <div className="flex w-full max-w-4xl flex-col items-center gap-10 py-12 animate-in fade-in duration-500">
      <div className="flex flex-wrap items-end justify-center gap-x-16 gap-y-8">
        <StatTile label="wpm" value={result.wpm.toFixed(0)} emphasis />
        <StatTile label="accuracy" value={(result.accuracy * 100).toFixed(1)} unit="%" />
        <StatTile label="consistency" value={result.consistency.toFixed(0)} unit="%" />
        <StatTile label="raw" value={result.rawWpm.toFixed(0)} unit="wpm" />
      </div>

      <div className="label-type flex flex-wrap justify-center gap-x-6 gap-y-2 text-muted-foreground">
        <span>{config.mode} {config.modeSetting}</span>
        <span>{seconds.toFixed(1)}s</span>
        <span className="text-type-correct">{result.charsCorrect} correct</span>
        <span className="text-flag">{result.charsIncorrect} incorrect</span>
        <span>{result.charsExtra} extra</span>
        <span>{result.charsMissed} missed</span>
        <span>n={test.events.length} events</span>
      </div>

      {/* The cardiograph replay — docs/DESIGN.md §5, the product's signature. */}
      <Trace events={test.events} durationMs={test.durationMs} className="max-w-3xl" />

      <Button type="button" size="lg" onClick={onRestart} autoFocus>
        new test
      </Button>
    </div>
  );
}
