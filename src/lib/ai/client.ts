import "server-only";

/**
 * The one place that talks to a model provider.
 *
 * Routed through OpenRouter, so the model is a configuration value
 * (OPENROUTER_MODEL) rather than a code dependency — swapping vendors is an
 * env change, not a rewrite.
 *
 * There is no OPENROUTER_API_KEY yet, so the live branch is written but not
 * exercised. Everything around it — compaction, prompting, validation,
 * persistence — is pure and tested, so switching this on is a one-line change
 * rather than a new integration.
 *
 * `grep -rn "TODO(ai-key)"` lists the full activation checklist.
 */

import { OpenRouter } from "@openrouter/sdk";
import { MAX_PROFILE_BYTES, PROMPT_VERSION, REPORT_MODEL } from "./model";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { collectAllowedNumbers, type CompactProfile } from "./profile-input";
import { validateReport } from "./parse";
import { fixtureReport } from "./fixtures/report";
import type { ParsedReport } from "./schema";
import type { PrescriptionReportContext } from "@/lib/prescriptions/report-context";

export type ReportSource = "live" | "fixture";

export type GeneratedReport = {
  source: ReportSource;
  model: string;
  promptVersion: string;
  report: ParsedReport;
};

/** True once a key exists. The single switch between fixture and live. */
export function isLiveAIEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export class ProfileTooLargeError extends Error {}
export class HallucinationError extends Error {
  constructor(public readonly details: string[]) {
    super("model cited figures absent from the profile");
  }
}

export async function generateReport(
  compact: CompactProfile,
  prescriptionContext?: PrescriptionReportContext,
): Promise<GeneratedReport> {
  const userMessage = buildUserMessage(compact, prescriptionContext);
  // The context is included because the prompt tells the model to cite the
  // previous cycle's figures in the summary; omitting it here would make the
  // guard reject the model for doing exactly what it was asked.
  const allowed = collectAllowedNumbers(compact, prescriptionContext);

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
      report: fixtureReport(compact, prescriptionContext),
    };
  }

  // TODO(ai-key): unverified — this branch has never executed. Before trusting
  // it: set OPENROUTER_API_KEY in .env.local, run one real report, confirm the
  // structured output parses and the guard passes on genuine output, and check
  // token usage against MAX_PROFILE_BYTES.
  const client = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    appTitle: "KeySense",
  });

  const response = await client.chat.send({
    chatRequest: {
      model: REPORT_MODEL,
      maxTokens: 8000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      responseFormat: {
        type: "json_schema",
        jsonSchema: {
          name: "keysense_report",
          strict: true,
          schema: reportJsonSchema,
        },
      },
      provider: {
        // OpenRouter picks a provider per request, and providers differ in
        // whether they honour json_schema. Without this the request can be
        // routed to one that ignores it and returns prose, which surfaces as a
        // JSON parse error with no hint that routing was the cause.
        requireParameters: true,
      },
    },
  });

  // Narrow away the streaming variant — this request does not set stream.
  if (!("choices" in response)) {
    throw new Error("unexpected streaming response from OpenRouter");
  }

  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("model returned no content");
  }

  const validation = validateReport(JSON.parse(content), allowed);
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
