/**
 * The shape the model must return. Mirrors `Finding` in types.ts.
 *
 * Kept minimal deliberately: every optional field is a field the model can fill
 * with something plausible and unverifiable. Evidence is required on every
 * finding because a claim without a number is not shippable
 * (docs/DESIGN.md §8).
 */

import { z } from "zod";

export const evidenceSchema = z.object({
  label: z.string().min(1).describe("What was measured, e.g. 'error rate'"),
  value: z
    .string()
    .min(1)
    .describe("The value as it should be displayed, e.g. '8.4%' or '211ms'"),
  n: z.number().int().nonnegative().describe("Sample size for this measurement"),
});

export const findingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(80),
  detail: z.string().min(1).max(600),
  severity: z.enum(["high", "medium", "low"]),
  evidence: z.array(evidenceSchema).min(1),
  targetType: z.enum(["bigram", "key", "finger", "sfb", "class"]),
  targets: z.array(z.string()).min(1),
});

export const reportSchema = z.object({
  summary: z.string().min(1).max(400),
  findings: z.array(findingSchema).min(1).max(4),
});

export type ParsedReport = z.infer<typeof reportSchema>;
