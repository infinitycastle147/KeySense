/**
 * Prescription lifecycle constants. Named and centralised per PHASE-5.md:
 * "Verdict thresholds should be explicit constants, not magic numbers
 * inline."
 */

/**
 * Verdict thresholds, expressed as a *relative* improvement/regression
 * against the baseline — see docs/ARCHITECTURE.md §7's own worked example:
 * errorRate 0.084 -> 0.031 is called "resolved," and that's a 63% relative
 * drop, not some fixed absolute one. A fixed absolute threshold wouldn't
 * scale between someone starting at 8% errors and someone starting at 40%.
 *
 * See src/lib/prescriptions/evaluate.ts for how these combine errorRate and
 * latencyP50 into a single score.
 */
export const RESOLVED_RELATIVE_IMPROVEMENT = 0.5;
export const IMPROVED_RELATIVE_IMPROVEMENT = 0.15;
export const REGRESSED_RELATIVE_WORSENING = 0.1;

/** Default number of drill sessions completed before a prescription is
 *  evaluated. Matches the `drills_target` column default in
 *  supabase/migrations/0001_init.sql. */
export const DEFAULT_DRILLS_TARGET = 5;

/** Default drill length in words, used when a prescription doesn't specify
 *  its own. */
export const DEFAULT_DRILL_WORD_COUNT = 40;
