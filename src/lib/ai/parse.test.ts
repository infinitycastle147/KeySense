import { describe, it, expect } from "vitest";
import { validateReport, extractNumbers } from "./parse";
import { hallucinatingFixture } from "./fixtures/report";

const allowed = [0.084, 211, 340, 2.13, 0.031, 178, 25];

function validFinding(over: Record<string, unknown> = {}) {
  return {
    id: "f1",
    title: "Right pinky lags",
    detail: "Slower than baseline.",
    severity: "high",
    evidence: [{ label: "error rate", value: "8.4%", n: 340 }],
    targetType: "finger",
    targets: ["r-pinky"],
    ...over,
  };
}

describe("extractNumbers", () => {
  it("pulls numbers out of display strings", () => {
    expect(extractNumbers("8.4%")).toEqual([8.4]);
    expect(extractNumbers("211ms")).toEqual([211]);
    expect(extractNumbers("2.13x slower (n=340)")).toEqual([2.13, 340]);
  });

  it("returns nothing for prose", () => {
    expect(extractNumbers("no digits here")).toEqual([]);
  });
});

describe("hallucination guard", () => {
  // The single most important test in the AI layer. A fabricated statistic in a
  // clinical-looking report is indistinguishable from a real one at a glance,
  // so it must never reach the user.
  it("rejects a response whose numbers are not in the profile", () => {
    const result = validateReport(hallucinatingFixture, allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("hallucinated");
      expect(result.rejectedFindings?.length).toBeGreaterThan(0);
    }
  });

  it("accepts a response citing only real numbers", () => {
    const result = validateReport(
      { summary: "ok", findings: [validFinding()] },
      allowed,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts percent-formatted rates (0.084 cited as 8.4%)", () => {
    const result = validateReport(
      {
        summary: "ok",
        findings: [
          validFinding({ evidence: [{ label: "err", value: "8.4%", n: 340 }] }),
        ],
      },
      allowed,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts display rounding (2.13 cited as 2.1x)", () => {
    const result = validateReport(
      {
        summary: "ok",
        findings: [
          validFinding({ evidence: [{ label: "ratio", value: "2.1x", n: 340 }] }),
        ],
      },
      allowed,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an invented sample size even when the value is real", () => {
    const result = validateReport(
      {
        summary: "ok",
        findings: [
          validFinding({ evidence: [{ label: "err", value: "8.4%", n: 7777 }] }),
        ],
      },
      allowed,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a plausible-but-absent number", () => {
    // 250ms is not in the profile, and is close enough to 211 to look right.
    const result = validateReport(
      {
        summary: "ok",
        findings: [
          validFinding({ evidence: [{ label: "lat", value: "250ms", n: 340 }] }),
        ],
      },
      allowed,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects malformed shapes before checking numbers", () => {
    const result = validateReport({ findings: [] }, allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("schema");
  });

  it("rejects a finding with no evidence at all", () => {
    const result = validateReport(
      { summary: "ok", findings: [validFinding({ evidence: [] })] },
      allowed,
    );
    expect(result.ok).toBe(false);
  });
});
