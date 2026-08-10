import "server-only";

/**
 * The one place that talks to a model provider.
 *
 * Gemini, called directly. The model id stays a configuration value
 * (GEMINI_MODEL) so it can be swapped without a code change, but the vendor is
 * now a code dependency — that is the trade made when the OpenRouter routing
 * layer was dropped (docs/ARCHITECTURE.md §12).
 *
 * Everything around this call — compaction, prompting, validation, persistence
 * — is pure and tested, so the provider is the only thing this module owns.
 */

import { GoogleGenAI } from "@google/genai";
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
  return Boolean(process.env.GEMINI_API_KEY);
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

  // Verified live 2026-08-10 against gemini-3.6-flash: structured output parses
  // and the hallucination guard passes on genuine output, ~10s per report.
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const response = await client.models.generateContent({
    model: REPORT_MODEL,
    contents: userMessage,
    config: {
      // Gemini takes the system prompt as config, not as a message with a
      // role — there is no "system" role in `contents`.
      systemInstruction: SYSTEM_PROMPT,
      // Both are required together: a schema without the mime type is ignored.
      responseMimeType: "application/json",
      responseJsonSchema: reportJsonSchema,
      // Thinking tokens are drawn from this same budget, so it has to cover the
      // reasoning as well as the report. Too low and generation stops mid-JSON
      // with finishReason MAX_TOKENS, which reads downstream as a parse error
      // rather than as the truncation it is — hence the explicit check below.
      maxOutputTokens: 16000,
    },
  });

  if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new Error(
      "model hit the output token limit before finishing the report; raise maxOutputTokens",
    );
  }

  const content = response.text;
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
 *
 * Passed as `responseJsonSchema` rather than `responseSchema`: the latter is
 * Gemini's OpenAPI 3.0 subset, which has no `additionalProperties`, so the
 * model would be free to bolt extra keys onto findings. Validation in parse.ts
 * would still catch them, but rejecting a whole report after paying for it is a
 * worse outcome than constraining generation up front.
 *
 * Accepted as-is by gemini-3.6-flash on the first live call.
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
