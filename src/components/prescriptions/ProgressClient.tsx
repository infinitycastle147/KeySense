"use client";

/**
 * Progress page orchestration — PHASE-5.md §5: "I am measurably better than
 * I was a month ago." Long-horizon WPM/accuracy strips (server-fetched, see
 * src/app/progress/page.tsx) plus the prescription history and the
 * "start prescribed drill" entry point (PHASE-5.md §3 calls for this on the
 * dashboard; it lives here instead because src/components/dashboard/ is out
 * of bounds for this phase — see the implementation report).
 *
 * Swaps between the progress view and DrillRunner inline, the same pattern
 * src/app/page.tsx uses to swap between TypingTest and ResultsScreen.
 */

import { useState } from "react";
import { Strip } from "@/components/dashboard/Strip";
import { DrillRunner, type DrillResponse } from "@/components/prescriptions/DrillRunner";
import { PrescriptionCard } from "@/components/prescriptions/PrescriptionCard";
import type { CompletedTest, Prescription } from "@/lib/types";

export type WeeklySeries = {
  rangeLabel: string;
  labels: string[];
  wpm: (number | null)[];
  accuracy: (number | null)[];
  currentWpm: number | null;
  currentAccuracy: number | null;
  wpmDelta: number | null;
  accuracyDelta: number | null;
  testCount: number;
};

type ProgressClientProps = {
  initialPrescriptions: Prescription[];
  weekly: WeeklySeries;
};

type View = { mode: "list" } | { mode: "drilling"; prescription: Prescription };

export function ProgressClient({ initialPrescriptions, weekly }: ProgressClientProps) {
  const [prescriptions, setPrescriptions] = useState(initialPrescriptions);
  const [view, setView] = useState<View>({ mode: "list" });
  const [lastResult, setLastResult] = useState<{ test: CompletedTest; response: DrillResponse | null } | null>(
    null,
  );

  function handleDrillComplete(test: CompletedTest, response: DrillResponse | null) {
    setLastResult({ test, response });
    if (response) {
      setPrescriptions((prev) =>
        prev.map((p) => (p.id === response.prescription.id ? response.prescription : p)),
      );
    }
    setView({ mode: "list" });
  }

  if (view.mode === "drilling") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-8">
        <DrillRunner
          prescription={view.prescription}
          onComplete={handleDrillComplete}
          onCancel={() => setView({ mode: "list" })}
        />
      </main>
    );
  }

  const active = prescriptions.filter((p) => p.status === "active");
  const completed = prescriptions.filter((p) => p.status === "completed");
  const resolved = completed.filter((p) => p.verdict === "resolved");

  return (
    <main className="flex flex-1 justify-center px-4 py-10">
      <div className="flex w-full max-w-3xl flex-col gap-10">
        <header className="flex flex-col gap-1">
          <h1 className="font-[family-name:var(--font-display)] text-[2.5rem] leading-none">progress</h1>
          <p className="label-type text-muted-foreground">
            {weekly.testCount} tests · {weekly.rangeLabel}
          </p>
        </header>

        {lastResult?.response?.evaluated && (
          <div className="rounded-md border border-vital/40 bg-vital/5 p-4">
            <p className="label-type text-vital">
              drill recorded — verdict: {lastResult.response.verdict}
            </p>
          </div>
        )}

        <section aria-label="Long-horizon trends" className="rounded-md bg-chassis px-4 ring-1 ring-grid">
          <Strip
            label="wpm"
            rangeLabel={weekly.rangeLabel}
            series={weekly.wpm}
            current={weekly.currentWpm}
            delta={weekly.wpmDelta}
            n={weekly.testCount}
            reportable={weekly.testCount > 0}
            decimals={0}
            goodDirection="up"
          />
          <Strip
            label="accuracy"
            rangeLabel={weekly.rangeLabel}
            series={weekly.accuracy}
            current={weekly.currentAccuracy}
            delta={weekly.accuracyDelta}
            n={weekly.testCount}
            reportable={weekly.testCount > 0}
            unit="%"
            decimals={1}
            goodDirection="up"
          />
        </section>

        <section aria-label="Active prescriptions" className="flex flex-col gap-3">
          <h2 className="label-type text-muted-foreground">active prescriptions</h2>
          {active.length === 0 ? (
            <p className="label-type text-muted-foreground">
              None right now — new ones appear here after a diagnosis flags a weakness.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {active.map((p) => (
                <li key={p.id}>
                  <PrescriptionCard
                    prescription={p}
                    onStartDrill={(rx) => setView({ mode: "drilling", prescription: rx })}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Resolved weaknesses" className="flex flex-col gap-3">
          <h2 className="label-type text-muted-foreground">resolved-weakness timeline</h2>
          {resolved.length === 0 ? (
            <p className="label-type text-muted-foreground">Nothing resolved yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {resolved.map((p) => (
                <li key={p.id}>
                  <PrescriptionCard prescription={p} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Prescription history" className="flex flex-col gap-3">
          <h2 className="label-type text-muted-foreground">all prescriptions</h2>
          {prescriptions.length === 0 ? (
            <p className="label-type text-muted-foreground">
              No prescriptions yet — run a diagnosis on the reports page first.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {prescriptions.map((p) => (
                <li key={p.id}>
                  <PrescriptionCard prescription={p} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
