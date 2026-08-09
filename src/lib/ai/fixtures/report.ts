/**
 * Fixture reports for development without an API key.
 *
 * These are built FROM the caller's real profile rather than hardcoded, so the
 * report UI is exercised against real shapes and the hallucination guard passes
 * on them the same way it would on live output. A fixture that cited invented
 * numbers would mask exactly the bug the guard exists to catch.
 *
 * TODO(ai-key): once live output is verified, decide whether to keep fixtures
 * for offline development or delete this module entirely.
 */

import type { CompactProfile } from "../profile-input";
import type { ParsedReport } from "../schema";

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function fixtureReport(compact: CompactProfile): ParsedReport {
  const findings: ParsedReport["findings"] = [];

  const worstBigram = compact.worstBigrams[0];
  if (worstBigram) {
    findings.push({
      id: "bigram-transition",
      title: `Transition \`${worstBigram.bigram}\` is costing you time`,
      detail: `The \`${worstBigram.bigram}\` transition errors at ${pct(worstBigram.errorRate)} with a median latency of ${worstBigram.latencyP50}ms.${worstBigram.sameFinger ? " This is a same-finger bigram, which is a known structural weak point rather than a habit." : ""}`,
      severity: "high",
      evidence: [
        { label: "error rate", value: pct(worstBigram.errorRate), n: worstBigram.n },
        { label: "median latency", value: `${worstBigram.latencyP50}ms`, n: worstBigram.n },
      ],
      targetType: worstBigram.sameFinger ? "sfb" : "bigram",
      targets: [worstBigram.bigram],
    });
  }

  const slowestFinger = [...compact.fingers].sort(
    (a, b) => b.relativeLatency - a.relativeLatency,
  )[0];
  if (slowestFinger && slowestFinger.relativeLatency > 1) {
    findings.push({
      id: "finger-latency",
      title: `${slowestFinger.finger} lags your other fingers`,
      detail: `Keys struck with the ${slowestFinger.finger} run at ${slowestFinger.relativeLatency.toFixed(2)}x your own median latency, with an error rate of ${pct(slowestFinger.errorRate)}. Measured against your own baseline, not a population norm.`,
      severity: "medium",
      evidence: [
        {
          label: "relative latency",
          value: `${slowestFinger.relativeLatency.toFixed(2)}x`,
          n: slowestFinger.n,
        },
        { label: "error rate", value: pct(slowestFinger.errorRate), n: slowestFinger.n },
      ],
      targetType: "finger",
      targets: [slowestFinger.finger],
    });
  }

  const worstKey = compact.worstKeys[0];
  if (worstKey && findings.length < 3) {
    findings.push({
      id: "key-accuracy",
      title: `\`${worstKey.key}\` is your least reliable key`,
      detail: `\`${worstKey.key}\` errors at ${pct(worstKey.errorRate)} with a median latency of ${worstKey.latencyP50}ms.`,
      severity: "low",
      evidence: [
        { label: "error rate", value: pct(worstKey.errorRate), n: worstKey.n },
      ],
      targetType: "key",
      targets: [worstKey.key],
    });
  }

  if (findings.length === 0) {
    findings.push({
      id: "insufficient-signal",
      title: "No weakness meets the reporting threshold",
      detail: `Across ${compact.testCount} tests, no key, transition, or finger accumulated enough observations to support a finding. Keep typing — the thresholds exist so that early noise is not reported as signal.`,
      severity: "low",
      evidence: [{ label: "tests in window", value: `${compact.testCount}`, n: compact.testCount }],
      targetType: "class",
      targets: ["general"],
    });
  }

  return {
    summary: `Reviewed ${compact.testCount} tests. ${findings.length} finding${findings.length === 1 ? "" : "s"} met the evidence threshold.`,
    findings,
  };
}

/**
 * A deliberately dishonest response: correct shape, invented numbers. Used to
 * prove the guard rejects fabricated figures — see parse.test.ts.
 */
export const hallucinatingFixture = {
  summary: "Reviewed your typing.",
  findings: [
    {
      id: "fabricated",
      title: "Right pinky is dramatically slower",
      detail: "Your right pinky runs at 9.87x your median latency.",
      severity: "high" as const,
      evidence: [
        { label: "relative latency", value: "9.87x", n: 99991 },
        { label: "error rate", value: "77.3%", n: 99991 },
      ],
      targetType: "finger" as const,
      targets: ["r-pinky"],
    },
  ],
};
