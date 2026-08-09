/**
 * Shared fixture builders for analysis-layer unit tests. Not consumed by any
 * production code path — exists purely to keep hand-built KeyEvent[]
 * fixtures readable across the metric test suites.
 */

import fs from "node:fs";
import path from "node:path";
import type { KeyEvent } from "@/lib/types";
import { parseLayout, type LayoutIndex, type LayoutJson } from "./layout";

type CharEventInput = Partial<KeyEvent> & { t: number; expected: string; key: string };

export function charEvent(input: CharEventInput): KeyEvent {
  return {
    wordIdx: 0,
    charIdx: 0,
    prev: null,
    mods: [],
    kind: "char",
    ok: input.key === input.expected,
    ...input,
  };
}

type DeleteEventInput = Partial<KeyEvent> & { t: number; kind?: "backspace" | "word-delete" };

export function deleteEvent(input: DeleteEventInput): KeyEvent {
  return {
    key: "",
    expected: "",
    ok: false,
    wordIdx: 0,
    charIdx: 0,
    prev: null,
    mods: [],
    kind: "backspace",
    ...input,
  };
}

export function loadLayoutIndex(name: string): LayoutIndex {
  const file = path.join(process.cwd(), "public", "data", "layouts", `${name}.json`);
  const json: LayoutJson = JSON.parse(fs.readFileSync(file, "utf-8"));
  return parseLayout(json);
}
