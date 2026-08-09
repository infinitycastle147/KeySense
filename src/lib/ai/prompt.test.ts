import { describe, expect, it } from "vitest";
import { buildUserMessage } from "./prompt";
import type { CompactProfile } from "./profile-input";
import type { PrescriptionReportContext } from "@/lib/prescriptions/report-context";

function compactProfile(): CompactProfile {
  return {
    windowStart: "2026-01-01T00:00:00.000Z",
    windowEnd: "2026-01-10T00:00:00.000Z",
    testCount: 20,
    overall: [],
    worstBigrams: [],
    worstKeys: [],
    fingers: [],
    errorTaxonomy: [],
    topConfusions: [],
    corrections: { backspaceRate: 0, meanCharsToNotice: null, n: 0 },
    trend: { wpmDelta: 0, accuracyDelta: 0, comparedToDays: 0 },
  };
}

describe("buildUserMessage", () => {
  it("omits the prescription block entirely when none is given", () => {
    const msg = buildUserMessage(compactProfile());
    expect(msg).not.toContain("Previous prescription cycle");
    expect(msg).not.toContain("Currently active prescriptions");
  });

  it("omits the prescription block when the context is empty (no completed, no active)", () => {
    const context: PrescriptionReportContext = { lastCompleted: null, active: [] };
    const msg = buildUserMessage(compactProfile(), context);
    expect(msg).not.toContain("Previous prescription cycle");
    expect(msg).not.toContain("Currently active prescriptions");
  });

  it("opens with the previous cycle's verdict and numbers when one is completed", () => {
    const context: PrescriptionReportContext = {
      lastCompleted: {
        targetType: "sfb",
        targets: ["ol", "ju"],
        verdict: "resolved",
        baselineErrorRate: 0.084,
        outcomeErrorRate: 0.031,
        drillsCompleted: 6,
        completedAt: "2026-08-05T00:00:00.000Z",
      },
      active: [],
    };
    const msg = buildUserMessage(compactProfile(), context);
    expect(msg).toContain("Previous prescription cycle");
    expect(msg).toContain("8.4%");
    expect(msg).toContain("3.1%");
    expect(msg).toContain("resolved");
    expect(msg).toContain("6 drill sessions");
  });

  it("lists active prescriptions so the model doesn't re-prescribe the same target", () => {
    const context: PrescriptionReportContext = {
      lastCompleted: null,
      active: [{ targetType: "bigram", targets: ["th"], drillsDone: 2, drillsTarget: 5 }],
    };
    const msg = buildUserMessage(compactProfile(), context);
    expect(msg).toContain("Currently active prescriptions");
    expect(msg).toContain("bigram [th]: 2/5 drills done");
  });

  it("still includes the full compact profile JSON regardless of prescription context", () => {
    const compact = compactProfile();
    const msg = buildUserMessage(compact, { lastCompleted: null, active: [] });
    expect(msg).toContain(JSON.stringify(compact, null, 2));
  });
});
