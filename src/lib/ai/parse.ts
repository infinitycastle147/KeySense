/**
 * Response validation, including the hallucination guard.
 *
 * Schema validation only proves the model returned the right *shape*. It says
 * nothing about whether the numbers are real — and a fabricated statistic in a
 * medical-sounding report is the single worst failure this product can have,
 * because it is indistinguishable from a correct one at a glance.
 *
 * So every number a finding cites is checked against the numbers actually
 * present in the input profile. A finding citing anything else is rejected
 * rather than repaired: a report that silently drops a bad claim is trustworthy,
 * one that rewrites it is not.
 */

import { reportSchema, type ParsedReport } from "./schema";

/**
 * Display rounding means the model legitimately writes 8.4% for 0.08421, so
 * exact equality would reject correct output. Relative tolerance covers that:
 * 0.084 vs 0.08421 is a 0.25% difference, well inside 2%.
 *
 * The absolute tolerance exists only so values at or near zero can match at
 * all, where a relative comparison is meaningless. It must stay tiny — at 0.05
 * a fabricated "9%" matched a real rate of 0.084, because the absolute gap is
 * 0.006. Rates live in 0..1, so a loose absolute bound silently accepts
 * invented percentages across a wide band.
 */
const RELATIVE_TOLERANCE = 0.02;
const ABSOLUTE_TOLERANCE = 0.0005;

export type ValidationResult =
  | { ok: true; report: ParsedReport }
  | { ok: false; reason: string; rejectedFindings?: string[] };

/** Pulls every numeric literal out of a display string like "8.4% (n=340)". */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d+(?:\.\d+)?/g);
  if (!matches) return [];
  return matches.map(Number).filter(Number.isFinite);
}

function matchesAny(value: number, allowed: number[]): boolean {
  return allowed.some((a) => {
    const diff = Math.abs(a - value);
    if (diff <= ABSOLUTE_TOLERANCE) return true;
    const scale = Math.max(Math.abs(a), Math.abs(value));
    return scale > 0 && diff / scale <= RELATIVE_TOLERANCE;
  });
}

/**
 * A rate of 0.084 is displayed as 8.4%, and a ratio of 2.1 may be written
 * "2.1x" — so a cited number is acceptable if it matches the profile directly
 * or under the one unit conversion the prompt permits.
 */
function isCitable(value: number, allowed: number[]): boolean {
  return (
    matchesAny(value, allowed) ||
    matchesAny(value / 100, allowed) ||
    matchesAny(value * 100, allowed)
  );
}

/**
 * @param raw     Model output, already JSON-parsed.
 * @param allowed Every number from the compact profile
 *                (`collectAllowedNumbers`).
 */
export function validateReport(raw: unknown, allowed: number[]): ValidationResult {
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }

  const rejected: string[] = [];

  // The summary is checked too, not just evidence. Since Phase 5 the prompt
  // asks the model to open it with the previous cycle's "8.4% -> 3.1%" — the
  // most trust-carrying sentence in the report. Leaving it unguarded would let
  // a fabricated figure through in exactly the place it does most damage.
  //
  // The only number the summary may cite that isn't in the profile is how many
  // findings it contains, which it can legitimately count. Everything else is
  // held to the same standard as evidence: an exemption by magnitude would let
  // a fabricated "8%" through, since that is a small integer too.
  const summaryAllowed = [...allowed, parsed.data.findings.length];
  for (const num of extractNumbers(parsed.data.summary)) {
    if (!isCitable(num, summaryAllowed)) {
      rejected.push(`summary cites ${num}, not in profile`);
    }
  }

  for (const finding of parsed.data.findings) {
    for (const ev of finding.evidence) {
      // The sample size must be one the profile actually reported.
      if (!isCitable(ev.n, allowed)) {
        rejected.push(`${finding.id}: n=${ev.n} not present in profile`);
        continue;
      }
      for (const num of extractNumbers(ev.value)) {
        if (!isCitable(num, allowed)) {
          rejected.push(`${finding.id}: "${ev.value}" cites ${num}, not in profile`);
        }
      }
    }
  }

  if (rejected.length > 0) {
    return {
      ok: false,
      reason: "hallucinated figures in evidence",
      rejectedFindings: rejected,
    };
  }

  return { ok: true, report: parsed.data };
}
