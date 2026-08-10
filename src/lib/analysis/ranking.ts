/**
 * Ranking weaknesses without manufacturing them.
 *
 * ## The problem with sorting by raw error rate
 *
 * A window contains a few hundred distinct bigrams. Sorting them by observed
 * error rate and taking the top ten is a **maximum of noisy estimators**: a
 * bigram reaches the top partly because it is genuinely bad and partly because
 * its estimate was unlucky. With hundreds of candidates, the second effect
 * dominates the first — the top of an unshrunk list is mostly noise, even with
 * an n >= 30 gate, because a 30-sample rate is still wide.
 *
 * That has two downstream consequences, and the second is the expensive one:
 *
 *   1. The user drills targets that were never their real weaknesses.
 *   2. Those targets then improve on re-measurement no matter what, because
 *      the unlucky part washes out — which is exactly the artifact
 *      src/lib/prescriptions/control.ts exists to cancel. The two corrections
 *      are halves of the same problem: shrinkage stops it being *selected*,
 *      the hold-out stops it being *scored* as a win.
 *
 * ## Two corrections
 *
 * **Empirical-Bayes shrinkage.** Fit a Beta prior to the population of
 * observed rates, then report each row's posterior mean. A rate measured on 30
 * observations is pulled hard toward the typist's typical rate; one measured
 * on 900 barely moves. Extremes therefore have to *earn* their position with
 * sample size rather than with luck.
 *
 * **Benjamini-Hochberg FDR.** Even after shrinkage, scanning hundreds of
 * candidates and reporting the worst is a multiple-comparisons problem. BH
 * controls the expected proportion of false discoveries among what is
 * reported, at a stated level, and it is the right family here: we want to
 * bound how much of the report is noise, not to guarantee zero false findings
 * at the price of never reporting anything.
 *
 * Pure — no I/O. See ranking.test.ts.
 */

/** Expected proportion of reported weaknesses allowed to be false discoveries.
 *  Loose by inferential standards, deliberately: this gates *what to practise*,
 *  not what to publish, and the cost of a wasted drill is far lower than the
 *  cost of never surfacing a real weakness. */
export const DEFAULT_FDR_Q = 0.1;

/**
 * Fewer candidates than this and the FDR gate is skipped entirely.
 *
 * Multiple-comparison correction answers "how many of these many findings are
 * flukes". With a handful of candidates that question has no force, and
 * asking it anyway is actively harmful here: p-values are computed against a
 * population mean the candidates themselves define, so in a tiny set every row
 * sits near the mean it helped set and nothing can ever be a discovery.
 */
export const MIN_CANDIDATES_FOR_FDR = 10;

export type RankableRow = {
  n: number;
  errors: number;
  errorRate: number;
  latencyP50: number;
};

export type BetaPrior = {
  alpha: number;
  beta: number;
  /** The prior mean — the typist's overall rate, which everything shrinks
   *  toward. Exposed because it is the honest answer for a row with no data. */
  mean: number;
  /** Prior strength in pseudo-observations (alpha + beta). Larger means the
   *  population is tightly clustered, so individual rows move less. */
  strength: number;
};

/**
 * Fits a Beta prior to the observed rates by method of moments.
 *
 * Moments are computed on the *pooled* counts rather than on the unweighted
 * mean of per-row rates: a row with n=30 and one with n=900 are not equally
 * informative about the population, and averaging their rates as if they were
 * would let the noisiest rows define the prior they are supposed to be
 * corrected by.
 *
 * Falls back to a weak, uninformative prior when the data cannot support a
 * fit — zero rows, zero observations, or a degenerate variance (every row
 * identical, or over-dispersed beyond what a Beta can express). A weak prior
 * shrinks almost nothing, which is the right failure mode: it declines to
 * correct rather than correcting in an arbitrary direction.
 */
export function fitBetaPrior(rows: RankableRow[]): BetaPrior {
  const totalN = rows.reduce((a, r) => a + r.n, 0);
  const totalErrors = rows.reduce((a, r) => a + r.errors, 0);

  if (rows.length < 2 || totalN === 0) {
    return { alpha: 1, beta: 1, mean: totalN > 0 ? totalErrors / totalN : 0, strength: 2 };
  }

  const mean = totalErrors / totalN;
  if (mean <= 0 || mean >= 1) {
    return { alpha: 1, beta: 1, mean, strength: 2 };
  }

  // n-weighted variance of the per-row rates around the pooled mean.
  let weighted = 0;
  for (const r of rows) {
    const rate = r.n > 0 ? r.errors / r.n : 0;
    weighted += r.n * (rate - mean) ** 2;
  }
  const variance = weighted / totalN;

  // A Beta's variance is bounded by mean*(1-mean); anything at or beyond that
  // cannot be fitted, and anything at zero means there is nothing to shrink.
  const maxVariance = mean * (1 - mean);
  if (variance <= 0 || variance >= maxVariance) {
    return { alpha: 1, beta: 1, mean, strength: 2 };
  }

  const strength = maxVariance / variance - 1;
  return { alpha: mean * strength, beta: (1 - mean) * strength, mean, strength };
}

/** Posterior mean error rate for one row under `prior`. */
export function shrinkRate(row: RankableRow, prior: BetaPrior): number {
  return (row.errors + prior.alpha) / (row.n + prior.alpha + prior.beta);
}

/**
 * Upper-tail probability of seeing at least `errors` failures in `n` trials
 * when the true rate is `p` — the evidence that this row is worse than the
 * typist's baseline rather than an unlucky draw from it.
 *
 * Normal approximation with a continuity correction. Exact binomial tails are
 * unnecessary here: every candidate has already cleared MIN_FINDING_N (30) and
 * rates are not near-degenerate, which is precisely the regime where the
 * approximation is accurate. Choosing it keeps the function cheap enough to
 * run over every bigram in a window.
 */
export function binomialUpperTailP(errors: number, n: number, p: number): number {
  if (n <= 0) return 1;
  if (p <= 0) return errors > 0 ? 0 : 1;
  if (p >= 1) return 1;

  const mean = n * p;
  const sd = Math.sqrt(n * p * (1 - p));
  if (sd === 0) return errors > mean ? 0 : 1;

  const z = (errors - 0.5 - mean) / sd;
  return 1 - normalCdf(z);
}

/** Abramowitz & Stegun 7.1.26 — max error ~1.5e-7, far below anything that
 *  could change a BH decision. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Benjamini-Hochberg step-up procedure.
 *
 * Returns, for each input p-value in its original order, whether it is a
 * discovery at false-discovery-rate `q`. Ties are handled by the step-up rule
 * itself: the largest k whose sorted p-value is <= k*q/m sets the threshold,
 * and everything at or below it is rejected — so equal p-values always share a
 * verdict.
 */
export function benjaminiHochberg(pValues: number[], q = DEFAULT_FDR_Q): boolean[] {
  const m = pValues.length;
  if (m === 0) return [];

  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);

  let cutoff = -1;
  for (let k = 0; k < m; k++) {
    if (indexed[k].p <= ((k + 1) * q) / m) cutoff = k;
  }

  const significant = new Array<boolean>(m).fill(false);
  for (let k = 0; k <= cutoff; k++) significant[indexed[k].i] = true;
  return significant;
}

export type RankedRow<T> = {
  row: T;
  /** Posterior mean error rate — the value the ranking actually uses. */
  shrunkErrorRate: number;
  /** Raw observed rate, kept so the gap between the two stays inspectable. */
  rawErrorRate: number;
  pValue: number;
  /** Survived the FDR gate. */
  significant: boolean;
};

/**
 * Ranks candidate weaknesses worst-first on their shrunken rate, annotating
 * each with the evidence behind its position.
 *
 * Nothing is dropped here — the FDR verdict is attached, not applied. Callers
 * decide whether to show only discoveries (a report, a prescription) or the
 * whole ordered list with its uncertainty (a dashboard). Filtering inside
 * would make the two indistinguishable and hide how much was excluded.
 *
 * Ties on the shrunken rate break on latency, as before: given equal error
 * evidence, the slower transition is the more useful thing to practise.
 */
export function rankWeaknesses<T extends RankableRow>(
  rows: T[],
  q = DEFAULT_FDR_Q,
): RankedRow<T>[] {
  if (rows.length === 0) return [];

  const prior = fitBetaPrior(rows);
  const pValues = rows.map((r) => binomialUpperTailP(r.errors, r.n, prior.mean));

  // Below MIN_CANDIDATES_FOR_FDR there is no multiplicity to correct, and
  // applying BH anyway would be a category error with a nasty edge: each row's
  // p-value is measured against the population the rows themselves define, so
  // with a handful of candidates every row sits near the mean it helped set
  // and nothing is ever a discovery — including a single genuinely dreadful
  // one. Shrinkage still applies; only the multiplicity gate is skipped.
  const significant =
    rows.length >= MIN_CANDIDATES_FOR_FDR
      ? benjaminiHochberg(pValues, q)
      : new Array<boolean>(rows.length).fill(true);

  return rows
    .map((row, i) => ({
      row,
      shrunkErrorRate: shrinkRate(row, prior),
      rawErrorRate: row.errorRate,
      pValue: pValues[i],
      significant: significant[i],
    }))
    .sort(
      (a, b) =>
        b.shrunkErrorRate - a.shrunkErrorRate || b.row.latencyP50 - a.row.latencyP50,
    );
}
