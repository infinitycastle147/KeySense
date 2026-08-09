import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Trace } from "./Trace";
import type { KeyEvent } from "@/lib/types";

/** jsdom doesn't implement SVG geometry (and doesn't even expose a distinct
 *  SVGPathElement — path nodes are plain SVGElement instances), so the
 *  draw-on measurement needs a stubbed length or the component would throw. */
function stubGetTotalLength() {
  Object.defineProperty(window.SVGElement.prototype, "getTotalLength", {
    configurable: true,
    value: () => 100,
  });
}

function mockMatchMedia(reducedMotion: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

function charEvent(t: number, expected: string, key: string, prev: string | null): KeyEvent {
  return {
    t,
    key,
    expected,
    ok: key === expected,
    wordIdx: 0,
    charIdx: 0,
    prev,
    mods: [],
    kind: "char",
  };
}

function deleteEvent(t: number): KeyEvent {
  return {
    t,
    key: "",
    expected: "",
    ok: false,
    wordIdx: 0,
    charIdx: 0,
    prev: null,
    mods: [],
    kind: "backspace",
  };
}

/** A short run: three clean keystrokes, one error, one correcting backspace,
 *  then the corrected keystroke — real-shaped event stream. */
const SAMPLE_EVENTS: KeyEvent[] = [
  charEvent(0, "t", "t", null),
  charEvent(110, "h", "h", "t"),
  charEvent(230, "e", "x", "h"), // error
  deleteEvent(340), // correction
  charEvent(420, "e", "e", "h"),
];

beforeEach(() => {
  stubGetTotalLength();
  mockMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Trace", () => {
  it("renders a waveform from real event data with an evidence tag", () => {
    render(<Trace events={SAMPLE_EVENTS} durationMs={500} />);

    // n counts "char" events only (4 of the 5 sample events); 1 is an error.
    expect(screen.getByText(/n=4 keystrokes/)).toBeInTheDocument();
    expect(screen.getByText(/1 error/)).toBeInTheDocument();

    const button = screen.getByRole("button");
    expect(button.querySelector("svg")).toBeInTheDocument();
    expect(button.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("is skippable — clicking completes the trace instantly", () => {
    render(<Trace events={SAMPLE_EVENTS} durationMs={500} />);

    expect(screen.getByText("click to skip")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("trace complete")).toBeInTheDocument();
    const button = screen.getByRole("button");
    for (const path of Array.from(button.querySelectorAll("path"))) {
      expect(path.style.transition).toBe("none");
      expect(path.style.strokeDashoffset).toBe("0");
    }
  });

  it("renders the completed trace immediately under prefers-reduced-motion", () => {
    mockMatchMedia(true);
    render(<Trace events={SAMPLE_EVENTS} durationMs={500} />);

    expect(screen.getByText(/reduced motion/)).toBeInTheDocument();
    const button = screen.getByRole("button");
    for (const path of Array.from(button.querySelectorAll("path"))) {
      expect(path.style.strokeDashoffset).toBe("0");
    }
  });

  it("handles an empty event log without crashing", () => {
    render(<Trace events={[]} durationMs={0} />);
    expect(screen.getByText(/n=0 keystrokes/)).toBeInTheDocument();
    expect(screen.getByText("no keystrokes recorded")).toBeInTheDocument();
  });
});
