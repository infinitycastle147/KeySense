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

/** 2 — key releases are captured (see `KeyUpEvent`). Version 1 archives have
 *  keydowns only, and every dynamics metric is unavailable for them. */
export const EVENT_SCHEMA_VERSION = 2;

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

/**
 * One key release.
 *
 * Kept in its own array rather than interleaved into `KeyEvent[]`, for two
 * reasons that both matter:
 *
 *   1. A release has no `expected`, no `ok`, no `charIdx` — nearly every
 *      KeyEvent field would be meaningless filler, and filler in an immutable
 *      archive is a lie waiting to be read back as data.
 *   2. Every latency metric in src/lib/analysis/ walks consecutive events and
 *      takes `t[i] - t[i-1]`. Interleaving releases would silently halve or
 *      corrupt every one of those intervals — a change with no failing test to
 *      announce it, which is the exact failure mode this codebase is built to
 *      avoid.
 *
 * Why capture it at all: a keydown-only log collapses dwell (how long a key is
 * held) and flight (how long the hand is in transit) into a single composite
 * interval. Two typists with identical 180ms transitions — one holding keys
 * 140ms, the other 40ms — have opposite problems and opposite prescriptions,
 * and are indistinguishable without this. Overlap (a key going down before the
 * previous is released) is the clearest single marker of fluent typing and is
 * likewise invisible without releases.
 */
export type KeyUpEvent = {
  /** ms from test start. From `event.timeStamp`, same clock base as KeyEvent.t. */
  t: number;
  /** The key released, as reported by the browser. */
  key: string;
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
  /** Key releases, in order. Absent on archives written before schema
   *  version 2 — dynamics metrics are simply unavailable for those, never
   *  approximated. */
  keyups?: KeyUpEvent[];
  /**
   * The prompt the user was asked to type, word by word.
   *
   * Part of the immutable archive, not a convenience field. Without it the
   * event log cannot be replayed: `KeyEvent.expected` only covers positions
   * the user actually reached, so a word left incomplete loses its tail
   * entirely (only a `missed` count survives). Sequence alignment — which is
   * what separates a dropped character from a run of fabricated substitutions,
   * see src/lib/analysis/align.ts — needs the whole expected string.
   *
   * Optional because tests archived before this field existed genuinely do not
   * have it, and inventing one would be worse than an honest absence. The
   * analysis layer falls back to positional classification for those.
   */
  words?: string[];
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
  /** Bootstrap confidence interval on `latencyP50`.
   *
   *  Optional because not every producer has the raw interval samples to
   *  resample from — pooled rollups (see profile.ts) carry per-test
   *  percentiles, not the underlying observations. Absent means "no
   *  uncertainty information", never "no uncertainty": consumers must treat it
   *  as unknown rather than as a point estimate they can trust.
   *  See bootstrapMedianCI in src/lib/analysis/stats.ts. */
  latencyCI?: Interval;
  /** 20ms-bin counts of the intervals behind `latencyP50`. Lets a window be
   *  pooled by summing distributions instead of averaging medians — see
   *  src/lib/analysis/histogram.ts. Absent on pre-0007 rollups. */
  latencyHist?: number[];
};

export type BigramStat = {
  bigram: string;
  n: number;
  errors: number;
  errorRate: number;
  errorRateCI: Interval;
  latencyP50: number;
  sameFinger: boolean;
  /** Bootstrap confidence interval on `latencyP50`.
   *
   *  Optional because not every producer has the raw interval samples to
   *  resample from — pooled rollups (see profile.ts) carry per-test
   *  percentiles, not the underlying observations. Absent means "no
   *  uncertainty information", never "no uncertainty": consumers must treat it
   *  as unknown rather than as a point estimate they can trust.
   *  See bootstrapMedianCI in src/lib/analysis/stats.ts. */
  latencyCI?: Interval;
  /** 20ms-bin counts of the intervals behind `latencyP50`. See KeyStat. */
  latencyHist?: number[];
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
  /** Ratio against the user's own overall median. >1 is slower than baseline.
   *
   *  CONFOUNDED. The interval this is built from belongs to the *transition*
   *  into this finger, not to the finger itself, so a high value may mean
   *  "the keys preceding this finger are far away" rather than "this finger is
   *  slow". Kept because it is the number the dashboard has always shown and
   *  because the gap between it and `relativeAdjusted` is itself informative —
   *  but a finding should cite the adjusted figure. */
  relativeLatency: number;
  /** Ratio against the same baseline, with the cost of the preceding finger
   *  removed by the additive model in src/lib/analysis/residual.ts. Absent when
   *  there were too few transitions to fit. */
  relativeAdjusted?: number;
  /** Bootstrap confidence interval on `latencyP50`.
   *
   *  Optional because not every producer has the raw interval samples to
   *  resample from — pooled rollups (see profile.ts) carry per-test
   *  percentiles, not the underlying observations. Absent means "no
   *  uncertainty information", never "no uncertainty": consumers must treat it
   *  as unknown rather than as a point estimate they can trust.
   *  See bootstrapMedianCI in src/lib/analysis/stats.ts. */
  latencyCI?: Interval;
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
  /** Discoveries: ranked, then held to the FDR gate. These drive the report
   *  and the prescription flow, where a row's presence is treated as a real
   *  weakness — so a row that cannot be told apart from noise must not appear.
   *  Usually short, and legitimately empty when nothing clears the gate. */
  worstBigrams: BigramStat[];
  worstKeys: KeyStat[];
  /** The same ranking with the gate reported rather than applied — every row
   *  at n >= MIN_FINDING_N, worst first. Display surfaces read these: a
   *  dashboard's job is to show the ordered field with its uncertainty, not to
   *  go blank because nothing rose to the level of a discovery
   *  (src/lib/analysis/ranking.ts, "attached, not applied"). Never feed these
   *  to the model or to prescription creation. */
  bigramStats: BigramStat[];
  keyStats: KeyStat[];
  fingers: FingerStat[];
  errorTaxonomy: ErrorTaxonomy;
  topConfusions: { intended: string; typed: string; count: number }[];
  sameFingerBigrams: BigramStat[];
  fatigue: { bucketSeconds: number; wpm: number[] };
  corrections: { backspaceRate: number; meanCharsToNotice: Measured<number> };
  /** Rhythm across the window: robust spread of inter-key intervals plus how
   *  often the typist bursts or stalls. Implemented since Phase 3 and never
   *  surfaced until now — steadiness is a separate axis from speed. */
  rhythm: { medianIki: number; coefficientOfVariation: number; burstRate: number; stallRate: number; n: number };
  /** Dwell / flight / overlap, pooled. `available` is false for windows made
   *  entirely of schema-version-1 tests, which carry no key releases. */
  dynamics: { available: boolean; dwellP50: number; flightP50: number; overlapRate: number; n: number };
  /** What the latency metrics had to discard. A window with a high discard
   *  rate is weaker evidence than its sample size alone suggests. */
  quality: { discardRate: number; distractedTests: number; testCount: number };
  /** Per-character-class error rate and latency relative to lowercase.
   *  ARCHITECTURE §5.4 called for this from the start; `KeyEvent.mods` carried
   *  the data all along and nothing read it. */
  charClasses: { charClass: string; n: number; errorRate: number; relativeToLowercase: number }[];
  /** Shift chord isolated from the letters it produces. */
  shift: { shiftedErrorRate: number; unshiftedErrorRate: number; n: number };
  /** Bigram shapes and hand flow — the mechanical vocabulary beyond SFBs. */
  geometry: {
    shapes: { shape: string; n: number; errorRate: number; latencyP50: number }[];
    alternationRate: number;
    medianSameHandRun: number;
    redirectRate: number;
    n: number;
  };
  /** Confusions with a root cause attached, not just a pair of characters. */
  classifiedConfusions: { intended: string; typed: string; count: number; cause: string }[];
  /** What each weakness costs in words per minute — the impact ranking the
   *  README promises, distinct from the error-rate ranking above. */
  timeLoss: {
    floorMs: number;
    baselineWpm: number;
    top: { bigram: string; n: number; excessMs: number; wpmCost: number }[];
  };
  /** True when every test pooled into this window shared one test config.
   *  When false, `trend` mixes workloads: a punctuation run and a plain-words
   *  run are different tasks, and a delta across them conflates a change in
   *  skill with a change in what was typed. */
  configMatched: boolean;
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

/** One measurement of a target set, at baseline or at outcome. */
export type TargetMeasurement = { errorRate: number; latencyP50: number; n: number };

/**
 * The hold-out control set: same-type targets ranked immediately below the
 * treated ones, deliberately never drilled and never shown to the user.
 *
 * It exists because a prescription's targets are chosen as *extremes* of a
 * noisy estimate, so re-measuring them later shows improvement whether or not
 * the drills did anything (regression to the mean). The control set was drawn
 * from the same tail of the same distribution and receives no treatment, so
 * whatever it does between baseline and outcome is what the treated set would
 * have done anyway. The difference between the two is the part attributable
 * to the prescription — see `lift` in src/lib/prescriptions/evaluate.ts.
 *
 * Null when no control could be formed (see control.ts): the prescription is
 * still valid, its verdict is just uncontrolled and must say so.
 */
export type PrescriptionControl = {
  targets: string[];
  /** Captured at creation alongside the treated baseline, never updated. */
  baseline: TargetMeasurement;
  outcome: TargetMeasurement | null;
};

export type Prescription = {
  id: string;
  reportId: string | null;
  targetType: PrescriptionTargetType;
  targets: string[];
  drillConfig: DrillConfig;
  /** Captured at creation. Never updated — see docs/ARCHITECTURE.md §7. */
  baseline: TargetMeasurement;
  outcome: TargetMeasurement | null;
  control: PrescriptionControl | null;
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
