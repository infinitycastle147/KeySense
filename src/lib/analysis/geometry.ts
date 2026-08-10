/**
 * Bigram geometry — the mechanical vocabulary of "why this transition is slow".
 *
 * Same-finger bigrams were the only member of this family the product shipped,
 * out of the handful that actually explain a slow transition. An SFB is one way
 * a bigram can be awkward; these are the others, and a finding that names the
 * right one is the difference between "drill `ol`" and "your hand is
 * over-rotating to reach the top row".
 *
 *   alternation   consecutive keys on opposite hands — the cheap case
 *   same-hand run how many keys in a row stay on one hand before it swaps
 *   SFB           same finger twice (already in bigrams.ts, counted here too
 *                 so every category is measured on one consistent denominator)
 *   scissor       same hand, adjacent fingers, two or more rows apart — the
 *                 fingers cross vertically and one has to get out of the way
 *   lateral       same hand, one key in an index finger's inner column — the
 *                 index has to leave home and stretch sideways
 *   redirect      three same-hand keys that reverse direction, e.g. inward
 *                 then outward — the hand changes its mind mid-motion
 *
 * All are derived from the layout at analysis time, never stored, so a typist
 * who switches layout gets the new geometry applied to their whole history —
 * the same reason docs/ARCHITECTURE.md §3.1 keeps finger attribution out of the
 * event record.
 *
 * Pure. See geometry.test.ts.
 */

import type { KeyEvent, Finger, Measured } from "@/lib/types";
import type { LayoutIndex } from "./layout";
import { MIN_FINDING_N, OUTLIER_MS, median } from "./stats";

export type BigramShape =
  | "alternation"
  | "same-finger"
  | "scissor"
  | "lateral-stretch"
  | "same-hand"; // same hand, none of the sharper categories

export type ShapeStat = {
  shape: BigramShape;
  n: number;
  errors: number;
  errorRate: number;
  latencyP50: number;
};

export type GeometryStats = {
  shapes: ShapeStat[];
  /** Share of transitions that swapped hands. Low means long same-hand runs,
   *  which is where awkwardness concentrates. */
  alternationRate: Measured<number>;
  /** Median length of an uninterrupted same-hand run, in keystrokes. */
  medianSameHandRun: number;
  longestSameHandRun: number;
  /** Three same-hand keys that reverse direction. Counted as a rate over
   *  eligible triples, not raw, so it doesn't just track test length. */
  redirectRate: Measured<number>;
};

/**
 * True when this key sits in an index finger's *inner* column — the one it has
 * to leave home and stretch sideways to reach (`t`/`g`/`b` and `y`/`h`/`n` on
 * QWERTY).
 *
 * Derived from the layout rather than hardcoded per keyboard: each index owns
 * two adjacent columns, and the inner one is whichever is closer to the
 * keyboard's centre. That holds for any layout with the standard finger
 * assignment, which is exactly the set layout.ts derives.
 */
function isLateralColumn(layout: LayoutIndex, key: string): boolean {
  const finger = layout.keyToFinger(key);
  if (finger !== "l-index" && finger !== "r-index") return false;
  const pos = layout.keyToPosition(key);
  if (!pos) return false;
  return isInnerColumn(layout, finger, pos);
}

function isInnerColumn(
  layout: LayoutIndex,
  finger: Finger,
  pos: { rowIndex: number; col: number },
): boolean {
  // Walk the row's neighbours to find the other column this finger owns.
  for (const delta of [-1, 1]) {
    const neighbourCol = pos.col + delta;
    const neighbour = findKeyAt(layout, pos.rowIndex, neighbourCol);
    if (!neighbour) continue;
    if (layout.keyToFinger(neighbour) !== finger) continue;
    // The inner column is the one closer to the keyboard's centre. For a left
    // index that is the higher column; for a right index, the lower.
    return finger === "l-index" ? pos.col > neighbourCol : pos.col < neighbourCol;
  }
  return false;
}

/** Reverse lookup by physical position. The layout index is small enough that
 *  a scan is cheaper than maintaining a second map. */
function findKeyAt(layout: LayoutIndex, rowIndex: number, col: number): string | undefined {
  for (const key of LATIN_KEYS) {
    const pos = layout.keyToPosition(key);
    if (pos && pos.rowIndex === rowIndex && pos.col === col) return key;
  }
  return undefined;
}

const LATIN_KEYS = "abcdefghijklmnopqrstuvwxyz0123456789-=[]\;',./`".split("");

function handOf(finger: Finger | undefined): "l" | "r" | "thumb" | undefined {
  if (!finger) return undefined;
  if (finger === "thumb") return "thumb";
  return finger.startsWith("l-") ? "l" : "r";
}

export function classifyBigramShape(
  layout: LayoutIndex,
  firstChar: string,
  secondChar: string,
): BigramShape | undefined {
  const a = layout.charToKey(firstChar);
  const b = layout.charToKey(secondChar);
  if (!a || !b) return undefined;

  const fa = layout.keyToFinger(a);
  const fb = layout.keyToFinger(b);
  if (!fa || !fb) return undefined;

  const ha = handOf(fa);
  const hb = handOf(fb);
  // The space bar is a thumb and belongs to neither hand; treating it as one
  // would make every word boundary look like an alternation.
  if (ha === "thumb" || hb === "thumb") return undefined;
  if (ha !== hb) return "alternation";

  if (fa === fb) return "same-finger";

  const pa = layout.keyToPosition(a);
  const pb = layout.keyToPosition(b);
  if (pa && pb && Math.abs(pa.rowIndex - pb.rowIndex) >= 2) return "scissor";

  if (isLateralColumn(layout, a) || isLateralColumn(layout, b)) return "lateral-stretch";

  return "same-hand";
}

const SHAPES: BigramShape[] = [
  "alternation",
  "same-finger",
  "scissor",
  "lateral-stretch",
  "same-hand",
];

/**
 * Computes shape statistics and hand-flow metrics over one test.
 *
 * Shapes are keyed on the *expected* transition, like every other metric here:
 * the question is how the typist handles the motion they were asked to make,
 * regardless of whether they got it right.
 */
export function computeGeometry(events: KeyEvent[], layout: LayoutIndex): GeometryStats {
  type Acc = { n: number; errors: number; latencies: number[] };
  const byShape = new Map<BigramShape, Acc>(SHAPES.map((s) => [s, { n: 0, errors: 0, latencies: [] }]));

  const hands: ("l" | "r")[] = [];
  let alternations = 0;
  let handPairs = 0;

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev.kind !== "char" || curr.kind !== "char") continue;

    const shape = classifyBigramShape(layout, prev.expected, curr.expected);
    if (!shape) continue;

    const acc = byShape.get(shape)!;
    acc.n += 1;
    if (!curr.ok) acc.errors += 1;

    const interval = curr.t - prev.t;
    if (interval >= 0 && interval <= OUTLIER_MS) acc.latencies.push(interval);

    handPairs += 1;
    if (shape === "alternation") alternations += 1;
  }

  // Hand sequence, for runs and redirects. Built separately from the pair loop
  // because a run is a property of the sequence, not of any one transition.
  for (const event of events) {
    if (event.kind !== "char") continue;
    const key = layout.charToKey(event.expected);
    const hand = handOf(key ? layout.keyToFinger(key) : undefined);
    if (hand === "l" || hand === "r") hands.push(hand);
  }

  const runs: number[] = [];
  let run = 0;
  for (let i = 0; i < hands.length; i++) {
    if (i > 0 && hands[i] === hands[i - 1]) run += 1;
    else {
      if (run > 0) runs.push(run);
      run = 1;
    }
  }
  if (run > 0) runs.push(run);

  const { redirects, triples } = countRedirects(events, layout);

  return {
    shapes: SHAPES.map((shape) => {
      const acc = byShape.get(shape)!;
      return {
        shape,
        n: acc.n,
        errors: acc.errors,
        errorRate: acc.n > 0 ? acc.errors / acc.n : 0,
        latencyP50: median(acc.latencies),
      };
    }),
    alternationRate: {
      value: handPairs > 0 ? alternations / handPairs : 0,
      n: handPairs,
      reportable: handPairs >= MIN_FINDING_N,
    },
    medianSameHandRun: median(runs),
    longestSameHandRun: runs.length > 0 ? Math.max(...runs) : 0,
    redirectRate: {
      value: triples > 0 ? redirects / triples : 0,
      n: triples,
      reportable: triples >= MIN_FINDING_N,
    },
  };
}

/**
 * A redirect is three consecutive same-hand keys whose horizontal direction
 * reverses: the hand travels inward then outward, or the reverse. It is the
 * motion that makes a same-hand run feel worse than its length suggests.
 *
 * Keys in the same column are skipped rather than counted as a direction —
 * zero movement has no direction to reverse.
 */
function countRedirects(
  events: KeyEvent[],
  layout: LayoutIndex,
): { redirects: number; triples: number } {
  let redirects = 0;
  let triples = 0;

  const chars = events.filter((e) => e.kind === "char");

  for (let i = 2; i < chars.length; i++) {
    const keys = [chars[i - 2], chars[i - 1], chars[i]].map((e) => layout.charToKey(e.expected));
    if (keys.some((k) => !k)) continue;

    const fingers = keys.map((k) => layout.keyToFinger(k!));
    if (fingers.some((f) => !f)) continue;

    const hands = fingers.map((f) => handOf(f));
    if (hands[0] === "thumb" || hands[0] !== hands[1] || hands[1] !== hands[2]) continue;

    const cols = keys.map((k) => layout.keyToPosition(k!)?.col);
    if (cols.some((c) => c === undefined)) continue;

    const first = cols[1]! - cols[0]!;
    const second = cols[2]! - cols[1]!;
    if (first === 0 || second === 0) continue;

    triples += 1;
    if (Math.sign(first) !== Math.sign(second)) redirects += 1;
  }

  return { redirects, triples };
}
