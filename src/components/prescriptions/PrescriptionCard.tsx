/**
 * One prescription row — active (with a "start drill" entry point) or
 * completed (with its verdict and the baseline/outcome numbers that earned
 * it). Every claim shows its evidence (docs/DESIGN.md): baseline, outcome,
 * and n are always visible, never just the verdict word.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Prescription, PrescriptionVerdict } from "@/lib/types";

const VERDICT_STYLES: Record<PrescriptionVerdict, string> = {
  resolved: "border-vital/50 text-vital",
  improved: "border-trace/50 text-trace",
  "no-change": "border-border text-muted-foreground",
  regressed: "border-flag/50 text-flag",
};

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function targetLabel(p: Prescription): string {
  return `${p.targetType} · ${p.targets.join(", ")}`;
}

export function PrescriptionCard({
  prescription,
  onStartDrill,
}: {
  prescription: Prescription;
  onStartDrill?: (p: Prescription) => void;
}) {
  const isActive = prescription.status === "active";

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="label-type">{targetLabel(prescription)}</span>
          {prescription.verdict ? (
            <Badge variant="outline" className={`label-type ${VERDICT_STYLES[prescription.verdict]}`}>
              {prescription.verdict}
            </Badge>
          ) : (
            <Badge variant="outline" className="label-type text-muted-foreground">
              {prescription.status}
            </Badge>
          )}
        </div>

        <div className="label-type flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          <span>
            baseline error rate {pct(prescription.baseline.errorRate)} (n={prescription.baseline.n})
          </span>
          {prescription.outcome && (
            <span>
              outcome {pct(prescription.outcome.errorRate)} (n={prescription.outcome.n})
            </span>
          )}
        </div>

        {isActive && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="label-type text-muted-foreground">
              {prescription.drillsDone}/{prescription.drillsTarget} drills done
            </span>
            {onStartDrill && (
              <Button type="button" size="sm" onClick={() => onStartDrill(prescription)}>
                start prescribed drill
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
