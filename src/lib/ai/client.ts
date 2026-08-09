import "server-only";

/**
 * The one place that talks to the Anthropic API.
 *
 * There is no ANTHROPIC_API_KEY yet, so the live branch is written but not
 * exercised. Everything around it — compaction, prompting, validation,
 * persistence — is pure and tested, so switching this on is a one-line change
 * rather than a new integration.
 *
 * `grep -rn "TODO(ai-key)"` lists the full activation checklist.
 */

import Anthropic from "@anthropic-ai/sdk";
import { MAX_PROFILE_BYTES, PROMPT_VERSION, REPORT_MODEL } from "./model";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { collectAllowedNumbers, type CompactProfile } from "./profile-input";
import { validateReport } from "./parse";
import { fixtureReport } from "./fixtures/report";
import type { ParsedReport } from "./schema";

export type ReportSource = "live" | "fixture";

export type GeneratedReport = {
  source: ReportSource;
  model: string;
  promptVersion: string;
  report: ParsedReport;
};

/** True once a key exists. The single switch between fixture and live. */
export function isLiveAIEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export class ProfileTooLargeError extends Error {}
export class HallucinationError extends Error {
  constructor(public readonly details: string[]) {
    super("model cited figures absent from the profile");
  }
}

export async function generateReport(
  compact: CompactProfile,
): Promise<GeneratedReport> {
  const userMessage = buildUserMessage(compact);
  const allowed = collectAllowedNumbers(compact);

  // A payload this size means compaction regressed and raw data is leaking in.
  const payloadBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
  if (payloadBytes > MAX_PROFILE_BYTES * 4) {
    throw new ProfileTooLargeError(
      `compact profile is ${payloadBytes} bytes; compaction is not doing its job`,
    );
  }

  if (!isLiveAIEnabled()) {
    // No key: return a clearly-labelled fixture. The caller surfaces
    // source === "fixture" in the UI so a fake diagnosis never reads as real.
    return {
      source: "fixture",
      model: REPORT_MODEL,
      promptVersion: PROMPT_VERSION,
      report: fixtureReport(compact),
    };
  }

  // TODO(ai-key): unverified — this branch has never executed. Before trusting
  // it: set ANTHROPIC_API_KEY in .env.local, run one real report, confirm the
  // structured output parses and the guard passes on genuine output, and check
  // token usage against MAX_PROFILE_BYTES.
  const client = new Anthropic();

  const response = await client.messages.create({
    model: REPORT_MODEL,
    // Thinking is on by default on this model and counts against max_tokens,
    // so this leaves room for reasoning plus the report itself.
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    output_config: {
      format: {
        type: "json_schema",
        schema: reportJsonSchema,
      },
    },
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("model returned no text block");
  }

  const validation = validateReport(JSON.parse(textBlock.text), allowed);
  if (!validation.ok) {
    // Never fall back to fixtures here — a live call that produced bad output
    // is a real failure and must be visible, not papered over.
    throw new HallucinationError(validation.rejectedFindings ?? [validation.reason]);
  }

  return {
    source: "live",
    model: REPORT_MODEL,
    promptVersion: PROMPT_VERSION,
    report: validation.report,
  };
}

/**
 * JSON Schema mirroring schema.ts. Written out rather than derived so the
 * structured-output contract is explicit at the call site.
 * TODO(ai-key): verify this is accepted as-is on the first live call.
 */
const reportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "detail", "severity", "evidence", "targetType", "targets"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          detail: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "value", "n"],
              properties: {
                label: { type: "string" },
                value: { type: "string" },
                n: { type: "integer" },
              },
            },
          },
          targetType: {
            type: "string",
            enum: ["bigram", "key", "finger", "sfb", "class"],
          },
          targets: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;
