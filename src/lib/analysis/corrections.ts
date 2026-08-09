/**
 * Correction behaviour: backspace rate, and time-to-notice — caught at char 1
 * or char 5? Per docs/ARCHITECTURE.md §5.4.
 */

import type { KeyEvent, Measured } from "@/lib/types";
import { MIN_FINDING_N, median } from "./stats";

export type CorrectionStats = {
  backspaceCount: number;
  charAttemptCount: number;
  /** backspaceCount / charAttemptCount. 0 when there were no attempts. */
  backspaceRate: number;
  /** Median number of characters typed after an error before it is noticed
   *  and corrected (a backspace/word-delete event follows it). 1 means the
   *  very next keystroke was the correction; higher means the error survived
   *  longer before detection. */
  meanCharsToNotice: Measured<number>;
};

/**
 * "Chars to notice" for one error event is computed by scanning forward from
 * that event for the next backspace/word-delete event, counting the
 * intervening "char" events (inclusive of the error itself, so an immediate
 * correction scores 1, not 0). Errors never followed by any deletion before
 * the stream ends are *uncorrected* and excluded from this measure — there
 * is no "notice" to time.
 *
 * This is a judgement call: KeyEvent doesn't carry an explicit link between
 * an error and the deletion that fixes it, so "the next deletion after this
 * error" is the closest available signal from the raw stream.
 *
 * The distribution of notice-distances can have a long tail (an error caught
 * 40 characters later), so — per the "never a raw mean" rule — the pooled
 * value is a median despite the field being named `meanCharsToNotice` to
 * match the fixed `types.ts` contract; the name is inherited, the statistic
 * underneath is robust.
 */
export function computeCorrections(events: KeyEvent[]): CorrectionStats {
  let backspaceCount = 0;
  let charAttemptCount = 0;

  for (const event of events) {
    if (event.kind === "backspace" || event.kind === "word-delete") backspaceCount += 1;
    if (event.kind === "char") charAttemptCount += 1;
  }

  const noticeDistances: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.kind !== "char" || event.ok) continue;

    let charsSeen = 1; // the error itself
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      if (next.kind === "char") {
        charsSeen += 1;
      } else {
        // backspace or word-delete: this is the correction.
        noticeDistances.push(charsSeen);
        break;
      }
    }
  }

  return {
    backspaceCount,
    charAttemptCount,
    backspaceRate: charAttemptCount > 0 ? backspaceCount / charAttemptCount : 0,
    meanCharsToNotice: {
      value: median(noticeDistances),
      n: noticeDistances.length,
      reportable: noticeDistances.length >= MIN_FINDING_N,
    },
  };
}
