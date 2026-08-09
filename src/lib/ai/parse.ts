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
 * exact equality would reject correct output. Matching is therefore tolerant,
 * but only to the precision a human would actually read.
 */
const RELATIVE_TOLERANCE = 0.02;
const ABSOLUTE_TOLERANCE = 0.05;

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
