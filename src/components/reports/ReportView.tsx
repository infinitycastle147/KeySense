"use client";

/**
 * The diagnosis. Prose is still and readable — no motion here
 * (docs/DESIGN.md §6). Every claim shows its evidence (§4).
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Finding } from "@/lib/types";

type ReportResponse = {
  id: string;
  source: "live" | "fixture";
  summary: string;
  findings: Finding[];
  model: string;
  promptVersion: string;
  windowStart: string;
  windowEnd: string;
  testCount: number;
};

type ErrorResponse = { error: string; detail?: string | string[] };

const severityStyles: Record<Finding["severity"], string> = {
  high: "border-flag/50 text-flag",
  medium: "border-trace/50 text-trace",
  low: "border-border text-muted-foreground",
};

export function ReportView() {
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<ErrorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // Phase 5 closed loop (docs/ARCHITECTURE.md §7): a finding becomes a
  // prescription with one click. Keyed by finding id so each card tracks its
  // own request/result independently.
  const [prescribing, setPrescribing] = useState<Record<string, "pending" | "done" | "error">>({});

  async function prescribe(findingId: string) {
    if (!report) return;
    setPrescribing((prev) => ({ ...prev, [findingId]: "pending" }));
    try {
      const res = await fetch("/api/prescriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: report.id, findingId }),
      });
      setPrescribing((prev) => ({ ...prev, [findingId]: res.ok ? "done" : "error" }));
    } catch {
      setPrescribing((prev) => ({ ...prev, [findingId]: "error" }));
    }
  }

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/report", { method: "POST" });
      const body = await res.json();
      if (!res.ok) setError(body as ErrorResponse);
      else setReport(body as ReportResponse);
    } catch {
      setError({ error: "Could not reach the server." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-10 flex items-end justify-between gap-6">
        <div>
          <p className="label-type text-muted-foreground">Diagnosis</p>
          <h1 className="font-display text-3xl tracking-tight">Report</h1>
        </div>
        <Button onClick={generate} disabled={loading}>
          {loading ? "Analysing…" : "Run diagnosis"}
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-border bg-card p-5">
          <p className="font-medium">{error.error}</p>
          {typeof error.detail === "string" && (
            <p className="mt-2 text-sm text-muted-foreground">{error.detail}</p>
          )}
          {Array.isArray(error.detail) && (
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {error.detail.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {report && (
        <article className="space-y-8">
          {/* A fake diagnosis must never be able to read as real. */}
          {report.source === "fixture" && (
            <div className="rounded-md border border-trace/40 bg-trace/5 p-4">
              <Badge variant="outline" className="label-type border-trace/60 text-trace">
                Sample report
              </Badge>
              <p className="mt-2 text-sm text-muted-foreground">
                Generated locally from your real statistics, not by the model — no
                API key is configured. The numbers are yours; the wording is a
                placeholder.
              </p>
            </div>
          )}

          <p className="text-lg leading-relaxed">{report.summary}</p>

          <div className="space-y-6">
            {report.findings.map((finding) => (
              <section
                key={finding.id}
                className="rounded-md border border-border bg-card p-6"
              >
                <div className="mb-3 flex items-center gap-3">
                  <span
                    className={`label-type rounded-sm border px-2 py-0.5 ${severityStyles[finding.severity]}`}
                  >
                    {finding.severity}
                  </span>
                  <h2 className="font-display text-lg">{finding.title}</h2>
                </div>

                <p className="leading-relaxed text-muted-foreground">
                  {finding.detail}
                </p>

                <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4">
                  {finding.evidence.map((ev) => (
                    <div key={`${finding.id}-${ev.label}`} className="flex items-baseline gap-2">
                      <dt className="label-type text-muted-foreground">{ev.label}</dt>
                      <dd className="font-display text-sm">{ev.value}</dd>
                      <dd className="label-type text-muted-foreground">n={ev.n}</dd>
                    </div>
                  ))}
                </dl>

                {/* Closes the loop (docs/ARCHITECTURE.md §7): turns this
                    finding into a tracked prescription — see /progress. */}
                <div className="mt-4 flex items-center gap-3 border-t border-border pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={prescribing[finding.id] === "pending" || prescribing[finding.id] === "done"}
                    onClick={() => prescribe(finding.id)}
                  >
                    {prescribing[finding.id] === "done" ? "prescribed" : "prescribe drill"}
                  </Button>
                  {prescribing[finding.id] === "error" && (
                    <span className="label-type text-flag">could not create prescription</span>
                  )}
                </div>
              </section>
            ))}
          </div>

          <footer className="label-type flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-4 text-muted-foreground">
            <span>{report.testCount} tests</span>
            <span>{report.model}</span>
            <span>prompt {report.promptVersion}</span>
          </footer>
        </article>
      )}

      {!report && !error && !loading && (
        <p className="text-muted-foreground">
          No diagnosis yet. Run one to analyse your recent tests.
        </p>
      )}
    </div>
  );
}
