/**
 * Keyboard geometry, derived from a layout JSON (public/data/layouts/*.json),
 * not fetched by this module — the caller reads the file and passes in the
 * parsed data. Keeps this library pure (no I/O) and lets the same function
 * work in tests, server routes, or the browser.
 *
 * All four shipped layouts (qwerty, dvorak, colemak, colemak_dh) describe the
 * same physical ANSI keyboard with different characters assigned to each
 * position — row1 always has 13 columns, row2 13, row3 11, row4 10, row5
 * (space) 1. That means finger assignment is a function of (row, column)
 * physical position, not of which character lives there: "derive, do not
 * hardcode" means derive per-character finger assignment from column
 * position, rather than hand-writing a per-character table per layout.
 */

import type { Finger } from "@/lib/types";

/** Shape of public/data/layouts/<name>.json. Each row entry is
 *  [lower] or [lower, upper] (row5/space has no shifted variant). */
export type LayoutJson = {
  keymapShowTopRow: boolean;
  type: string;
  keys: Record<string, string[][]>;
};

export type KeyPosition = {
  row: string;
  col: number;
};

/** Derived, queryable geometry for one layout. Built once via `parseLayout`
 *  and reused across every metric that needs finger/row/adjacency info. */
export type LayoutIndex = {
  /** The character actually produced (lower or shifted) -> canonical key id
   *  (the lowercase character at that physical position). Undefined if the
   *  character doesn't appear anywhere in this layout. */
  charToKey(char: string): string | undefined;
  /** Canonical key id -> standard touch-typing finger assignment. */
  keyToFinger(key: string): Finger | undefined;
  /** Canonical key id -> row label ("row1".."row5"). */
  keyToRow(key: string): string | undefined;
  /** Canonical key id -> its physical (row index, column) position. Row index
   *  is 0-based from the number row, so row distance is a plain subtraction —
   *  which is what scissor and stretch detection need. */
  keyToPosition(key: string): { rowIndex: number; col: number } | undefined;
  /** Physically adjacent keys (row distance <= 1 and column distance <= 1).
   *  A key is never "adjacent" to itself. */
  areAdjacent(keyA: string, keyB: string): boolean;
  /** Same finger, including the trivial case of the same key typed twice. */
  isSameFinger(keyA: string, keyB: string): boolean;
};

const ROW_ORDER = ["row1", "row2", "row3", "row4", "row5"];

/**
 * Standard touch-typing finger chart, indexed by (row, column). Verified
 * against all four shipped layouts' row lengths (13/13/11/10/1). This is the
 * "standard touch-typing assignment by column" called for in PHASE-3.md —
 * physical column position determines the finger, independent of layout.
 */
const FINGER_BY_ROW: Record<string, Finger[]> = {
  row1: [
    "l-pinky", "l-pinky", "l-ring", "l-middle", "l-index", "l-index",
    "r-index", "r-index", "r-middle", "r-ring", "r-pinky", "r-pinky", "r-pinky",
  ],
  row2: [
    "l-pinky", "l-ring", "l-middle", "l-index", "l-index",
    "r-index", "r-index", "r-middle", "r-ring", "r-pinky", "r-pinky", "r-pinky", "r-pinky",
  ],
  row3: [
    "l-pinky", "l-ring", "l-middle", "l-index", "l-index",
    "r-index", "r-index", "r-middle", "r-ring", "r-pinky", "r-pinky",
  ],
  row4: [
    "l-pinky", "l-ring", "l-middle", "l-index", "l-index",
    "r-index", "r-index", "r-middle", "r-ring", "r-pinky",
  ],
  row5: ["thumb"],
};

/**
 * Fallback for a row length not present in FINGER_BY_ROW (defensive — none of
 * the shipped layouts hit this path, but a future layout file with a
 * differently-shaped row shouldn't crash the parser). Splits the row in half
 * and assigns pinky/ring/middle/index-index outward from each edge.
 */
function fallbackFingerForColumn(col: number, rowLen: number): Finger {
  if (rowLen <= 1) return "thumb";
  const leftCount = Math.floor(rowLen / 2);
  if (col < leftCount) {
    if (col === 0) return "l-pinky";
    if (col === 1) return "l-ring";
    if (col === 2) return "l-middle";
    return "l-index";
  }
  const fromRight = rowLen - 1 - col;
  if (fromRight === 0) return "r-pinky";
  if (fromRight === 1) return "r-ring";
  if (fromRight === 2) return "r-middle";
  return "r-index";
}

export function parseLayout(json: LayoutJson): LayoutIndex {
  const charToKeyMap = new Map<string, string>();
  const keyToFingerMap = new Map<string, Finger>();
  const keyToRowMap = new Map<string, string>();
  const keyToPositionMap = new Map<string, KeyPosition>();

  for (const rowName of ROW_ORDER) {
    const row = json.keys[rowName];
    if (!row) continue;

    const fingerTable = FINGER_BY_ROW[rowName];

    row.forEach((entry, col) => {
      const lower = entry[0];
      const upper = entry.length > 1 ? entry[1] : null;
      if (!lower) return;

      const keyId = lower;
      charToKeyMap.set(lower, keyId);
      if (upper) charToKeyMap.set(upper, keyId);

      keyToRowMap.set(keyId, rowName);
      keyToPositionMap.set(keyId, { row: rowName, col });

      const finger = fingerTable?.[col] ?? fallbackFingerForColumn(col, row.length);
      keyToFingerMap.set(keyId, finger);
    });
  }

  function charToKey(char: string): string | undefined {
    return charToKeyMap.get(char);
  }

  function keyToFinger(key: string): Finger | undefined {
    return keyToFingerMap.get(key);
  }

  function keyToRow(key: string): string | undefined {
    return keyToRowMap.get(key);
  }

  function keyToPosition(key: string): { rowIndex: number; col: number } | undefined {
    const pos = keyToPositionMap.get(key);
    if (!pos) return undefined;
    return { rowIndex: ROW_ORDER.indexOf(pos.row), col: pos.col };
  }

  function areAdjacent(keyA: string, keyB: string): boolean {
    if (keyA === keyB) return false;
    const a = keyToPositionMap.get(keyA);
    const b = keyToPositionMap.get(keyB);
    if (!a || !b) return false;

    const rowDist = Math.abs(ROW_ORDER.indexOf(a.row) - ROW_ORDER.indexOf(b.row));
    const colDist = Math.abs(a.col - b.col);
    return rowDist <= 1 && colDist <= 1;
  }

  function isSameFinger(keyA: string, keyB: string): boolean {
    const a = keyToFingerMap.get(keyA);
    const b = keyToFingerMap.get(keyB);
    if (!a || !b) return false;
    return a === b;
  }

  return { charToKey, keyToFinger, keyToRow, keyToPosition, areAdjacent, isSameFinger };
}
