import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DrillRunner } from "./DrillRunner";
import type { CompletedTest, Prescription } from "@/lib/types";

vi.mock("@/lib/drills/loader", () => ({
  buildDrillWords: vi.fn(async () => ["cat"]),
}));

const saveTest = vi.fn(async (test: CompletedTest) => {
  void test;
});
vi.mock("@/lib/db/local", () => ({
  getDeviceId: () => "device-1",
  saveTest: (test: CompletedTest) => saveTest(test),
}));

function prescription(overrides: Partial<Prescription> = {}): Prescription {
  return {
    id: "rx-1",
    reportId: "report-1",
    targetType: "bigram",
    targets: ["at"],
    drillConfig: { wordCount: 1, targetRatio: 0.7, corpus: "english_5k" },
    baseline: { errorRate: 0.1, latencyP50: 200, n: 40 },
    outcome: null,
    verdict: null,
    status: "active",
    drillsTarget: 5,
    drillsDone: 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function typeChar(input: HTMLElement, key: string) {
  fireEvent.keyDown(input, { key });
}

beforeEach(() => {
  saveTest.mockClear();
  global.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        prescription: prescription({ drillsDone: 3 }),
        evaluated: false,
      }),
      { status: 200 },
    ),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DrillRunner", () => {
  it("loads the prescribed word list and renders it", async () => {
    render(<DrillRunner prescription={prescription()} onComplete={vi.fn()} onCancel={vi.fn()} />);
    const wordList = await screen.findByTestId("word-list");
    expect(wordList.textContent).toContain("cat");
  });

  it("tags the completed test with source=prescribed and the prescription's id", async () => {
    const onComplete = vi.fn();
    render(<DrillRunner prescription={prescription({ id: "rx-42" })} onComplete={onComplete} onCancel={vi.fn()} />);

    // Wait for the word list (not just the input, which renders unconditionally)
    // so the engine is guaranteed to be wired up before dispatching keydowns.
    await screen.findByTestId("word-list");
    const input = screen.getByLabelText("Drill input");
    typeChar(input, "c");
    typeChar(input, "a");
    typeChar(input, "t");

    await waitFor(() => expect(saveTest).toHaveBeenCalledTimes(1));
    const savedTest = saveTest.mock.calls[0][0] as CompletedTest;
    expect(savedTest.source).toBe("prescribed");
    expect(savedTest.prescriptionId).toBe("rx-42");
    expect(savedTest.result.charsCorrect).toBe(3);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(global.fetch).toHaveBeenCalledWith("/api/prescriptions/rx-42/drills", { method: "POST" });
  });

  it("calls onCancel without saving anything", async () => {
    const onCancel = vi.fn();
    render(<DrillRunner prescription={prescription()} onComplete={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(await screen.findByText("cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(saveTest).not.toHaveBeenCalled();
  });
});
