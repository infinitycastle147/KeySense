/**
 * Shared contracts for KeySense.
 *
 * These types are the interface between the typing engine (producer), the
 * analysis layer (consumer), and the persistence layer (transport). Changing a
 * shape here ripples across all three — see docs/ARCHITECTURE.md §3.1.
 *
 * `KeyEvent` in particular is the raw archival record. It is written once and
 * never mutated, so adding a field is safe but changing the meaning of an
 * existing one is not: historical rows would silently mean something different.
 * Bump `EVENT_SCHEMA_VERSION` if that ever becomes necessary.
 */

export const EVENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export type KeyEventKind = "char" | "backspace" | "word-delete";

/** One recorded keystroke. See docs/ARCHITECTURE.md §3.1. */
export type KeyEvent = {
  /** ms from test start. MUST come from `event.timeStamp`, never performance.now(). */
  t: number;
  /** The character actually produced. Empty for deletions. */
  key: string;
  /** The character that should have been produced at this position. */
  expected: string;
  ok: boolean;
  wordIdx: number;
  charIdx: number;
  /** Preceding *expected* character — bigram context. Null at test start. */
  prev: string | null;
  mods: string[];
  kind: KeyEventKind;
  /**
   * Expected characters skipped because this event committed a word early —
   * set only on the space that advances past an incomplete word.
   *
   * Omissions produce no keydown of their own, so they cannot be their own
   * event without putting synthetic keystrokes into the archive. Carrying the
   * count on the committing event keeps the log honest (one record per real
   * keydown) while leaving omissions derivable by the analysis layer.
   */
  missed?: number;
};

export type TestMode = "time" | "words" | "quote" | "zen" | "drill";
export type TestSource = "freeplay" | "prescribed";

export type TestConfig = {
  mode: TestMode;
  /** Seconds for "time", word count for "words", quote id for "quote". */
  modeSetting: string;
  language: string;
  layout: string;
  punctuation: boolean;
  numbers: boolean;
};

/** Headline stats. Definitions are fixed — see docs/ARCHITECTURE.md and the
 *  typing-engine skill. Changing them breaks historical comparability. */
export type TestResult = {
  wpm: number;
  rawWpm: number;
  accuracy: number;
  consistency: number;
  charsCorrect: number;
  charsIncorrect: number;
  charsExtra: number;
  charsMissed: number;
};

/** A completed test, as produced by the engine and persisted locally. */
export type CompletedTest = {
  /** Client-generated UUID. Makes sync an idempotent upsert. */
  id: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  config: TestConfig;
  result: TestResult;
  events: KeyEvent[];
  source: TestSource;
  prescriptionId: string | null;
  deviceId: string;
  appVersion: string;
  /** Local-only. Not sent to the server. */
  syncedAt: string | null;
};

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Every reported measurement carries its sample size. A value without an `n`
 *  cannot become a finding — see docs/ARCHITECTURE.md §5.3. */
export type Measured<T> = {
  value: T;
  n: number;
  /** False when n is below the reporting threshold (MIN_FINDING_N). */
  reportable: boolean;
};

export type Interval = { low: number; high: number };

export type KeyStat = {
  key: string;
  n: number;
  errors: number;
  errorRate: number;
  errorRateCI: Interval;
  latencyP50: number;
  latencyP90: number;
};

export type BigramStat = {
  bigram: string;
  n: number;
  errors: number;
  errorRate: number;
  errorRateCI: Interval;
  latencyP50: number;
  sameFinger: boolean;
};

export type Finger =
  | "l-pinky" | "l-ring" | "l-middle" | "l-index"
  | "r-index" | "r-middle" | "r-ring" | "r-pinky"
  | "thumb";

export type FingerStat = {
  finger: Finger;
  n: number;
  errorRate: number;
  latencyP50: number;
  /** Ratio against the user's own overall median. >1 is slower than baseline. */
  relativeLatency: number;
};

export type ErrorClass =
  | "substitution"
  | "insertion"
  | "omission"
  | "transposition";

export type ErrorTaxonomy = Record<ErrorClass, number>;

/** intended char -> typed char -> count */
export type ConfusionMatrix = Record<string, Record<string, number>>;

/** The compact profile handed to the LLM. Never contains raw events. */
export type MetricProfile = {
  windowStart: string;
  windowEnd: string;
  testCount: number;
  overall: {
    wpm: Measured<number>;
    accuracy: Measured<number>;
    consistency: Measured<number>;
  };
  worstBigrams: BigramStat[];
  worstKeys: KeyStat[];
  fingers: FingerStat[];
  errorTaxonomy: ErrorTaxonomy;
  topConfusions: { intended: string; typed: string; count: number }[];
  sameFingerBigrams: BigramStat[];
  fatigue: { bucketSeconds: number; wpm: number[] };
  corrections: { backspaceRate: number; meanCharsToNotice: Measured<number> };
  trend: { wpmDelta: number; accuracyDelta: number; comparedToDays: number };
};

// ---------------------------------------------------------------------------
// Diagnosis (Phase 4/5)
// ---------------------------------------------------------------------------

export type Finding = {
  id: string;
  title: string;
  /** Prose, written by the LLM, citing only numbers from `evidence`. */
  detail: string;
  severity: "high" | "medium" | "low";
  /** Every finding must cite its numbers. Enforced in review, not by types. */
  evidence: { label: string; value: string; n: number }[];
  targetType: PrescriptionTargetType;
  targets: string[];
};

export type PrescriptionTargetType =
  | "bigram" | "key" | "finger" | "sfb" | "class";

export type PrescriptionVerdict =
  | "resolved" | "improved" | "no-change" | "regressed";

export type Prescription = {
  id: string;
  reportId: string | null;
  targetType: PrescriptionTargetType;
  targets: string[];
  drillConfig: DrillConfig;
  /** Captured at creation. Never updated — see docs/ARCHITECTURE.md §7. */
  baseline: { errorRate: number; latencyP50: number; n: number };
  outcome: { errorRate: number; latencyP50: number; n: number } | null;
  verdict: PrescriptionVerdict | null;
  status: "active" | "completed" | "abandoned";
  drillsTarget: number;
  drillsDone: number;
  createdAt: string;
  completedAt: string | null;
};

export type DrillConfig = {
  wordCount: number;
  /** Share of words that must contain a target pattern. The remainder is
   *  general vocabulary — drilling only weaknesses regresses overall speed.
   *  See docs/ARCHITECTURE.md §6. */
  targetRatio: number;
  corpus: string;
};
