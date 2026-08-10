/**
 * Keystroke dynamics: dwell, flight, and overlap.
 *
 * An inter-key interval is a composite. It contains the time a key was held
 * and the time the hand spent travelling, and a keydown-only log cannot tell
 * them apart:
 *
 *     keydown A ──── keyup A ──────── keydown B
 *     |<─── dwell ──>|<─── flight ──>|
 *     |<────────── inter-key interval ────────>|
 *
 * Two typists with the same 180ms interval — one holding keys 140ms with 40ms
 * of travel, the other 40ms with 140ms of travel — have opposite problems.
 * The first is pressing sluggishly; the second is moving slowly between keys.
 * The drills that help them are different, and until releases were captured
 * they were the same row in the data.
 *
 * **Overlap** is the third quantity and the most diagnostic of the three. A
 * fluent typist presses the next key *before* releasing the last, so flight
 * time goes negative — that is rollover, and its prevalence separates
 * genuinely fluent typing from fast one-key-at-a-time typing far more sharply
 * than raw speed does. A beginner's overlap rate is near zero at any WPM.
 *
 * Available only for schema version 2 archives onward. Version 1 tests have no
 * releases and get no dynamics at all — never an approximation, which here
 * would mean inventing the very quantity in question.
 *
 * Pure. See dynamics.test.ts.
 */

import type { KeyEvent, KeyUpEvent, Measured } from "@/lib/types";
import { MIN_FINDING_N, OUTLIER_MS, bootstrapMedianCI, median, percentile } from "./stats";
import type { Interval } from "@/lib/types";

export type DynamicsStats = {
  /** Median hold time, keydown to its matching keyup, in ms. */
  dwellP50: Measured<number>;
  dwellCI: Interval;
  /**
   * Median flight time: previous key's release to the next key's press.
   * Negative values mean the next key went down first — see `overlapRate`.
   */
  flightP50: Measured<number>;
  flightCI: Interval;
  /**
   * Share of consecutive keystroke pairs that overlapped at all. The single
   * best available marker of fluency as distinct from speed.
   */
  overlapRate: Measured<number>;
  /** Median overlap duration among pairs that did overlap, in ms. */
  overlapP50: number;
  /** 90th percentile dwell — the slow tail of key holds, where a sticky
   *  finger or a hard-to-reach key shows up before it shows up in the median. */
  dwellP90: number;
};

function measured(values: number[], value: number): Measured<number> {
  return { value, n: values.length, reportable: values.length >= MIN_FINDING_N };
}

function empty(): DynamicsStats {
  const zero = { low: 0, high: 0 };
  return {
    dwellP50: { value: 0, n: 0, reportable: false },
    dwellCI: zero,
    flightP50: { value: 0, n: 0, reportable: false },
    flightCI: zero,
    overlapRate: { value: 0, n: 0, reportable: false },
    overlapP50: 0,
    dwellP90: 0,
  };
}

/**
 * Pairs each character keydown with its release.
 *
 * Matching is by key identity, taking the **first** release of that key at or
 * after the press. Position-independent matching is necessary because releases
 * arrive out of order whenever keys overlap, which is exactly the case this
 * module exists to measure — matching by index would systematically mis-pair
 * the fluent typing it is supposed to detect.
 *
 * A press with no matching release (the test ended mid-hold, or the release
 * landed outside the window) contributes nothing rather than a guessed dwell.
 */
export function pairDwells(
  events: KeyEvent[],
  keyups: KeyUpEvent[],
): { downT: number; upT: number; dwell: number }[] {
  const byKey = new Map<string, number[]>();
  for (const up of keyups) {
    const list = byKey.get(up.key) ?? [];
    list.push(up.t);
    byKey.set(up.key, list);
  }
  for (const list of byKey.values()) list.sort((a, b) => a - b);

  const consumed = new Map<string, number>();
  const pairs: { downT: number; upT: number; dwell: number }[] = [];

  for (const event of events) {
    if (event.kind !== "char") continue;
    const releases = byKey.get(event.key);
    if (!releases) continue;

    let cursor = consumed.get(event.key) ?? 0;
    while (cursor < releases.length && releases[cursor] < event.t) cursor += 1;
    if (cursor >= releases.length) {
      consumed.set(event.key, cursor);
      continue;
    }

    const upT = releases[cursor];
    consumed.set(event.key, cursor + 1);

    const dwell = upT - event.t;
    // A hold longer than the outlier threshold is not a keystroke — it is a
    // key left resting under a finger while the typist thought about something.
    if (dwell >= 0 && dwell <= OUTLIER_MS) pairs.push({ downT: event.t, upT, dwell });
  }

  return pairs;
}

/**
 * Computes dwell, flight, and overlap for one test.
 *
 * Flight is measured between *consecutive pressed keys* — the release of the
 * earlier one to the press of the later one — so it is defined even when that
 * value is negative. Clamping negatives away would erase rollover, which is
 * the most informative thing in here.
 */
export function computeDynamics(events: KeyEvent[], keyups: KeyUpEvent[]): DynamicsStats {
  if (keyups.length === 0) return empty();

  const pairs = pairDwells(events, keyups);
  if (pairs.length === 0) return empty();

  const dwells = pairs.map((p) => p.dwell);

  const flights: number[] = [];
  let overlapped = 0;
  const overlaps: number[] = [];

  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1];
    const curr = pairs[i];
    const flight = curr.downT - prev.upT;
    // The magnitude bound applies to the gap, not to the overlap: a long pause
    // is not typing, but a long overlap is bounded by dwell already.
    if (flight > OUTLIER_MS) continue;

    flights.push(flight);
    if (flight < 0) {
      overlapped += 1;
      overlaps.push(-flight);
    }
  }

  return {
    dwellP50: measured(dwells, median(dwells)),
    dwellCI: bootstrapMedianCI(dwells),
    flightP50: measured(flights, median(flights)),
    flightCI: bootstrapMedianCI(flights),
    overlapRate: measured(flights, flights.length > 0 ? overlapped / flights.length : 0),
    overlapP50: median(overlaps),
    dwellP90: percentile(dwells, 90),
  };
}
