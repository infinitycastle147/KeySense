/**
 * Sequence alignment of what was typed against what was expected.
 *
 * ## Why positional comparison is not enough
 *
 * The engine compares each keystroke to `word[charIdx]` — the character at the
 * same *position*. That is correct for the caret and for accuracy, but it is
 * the wrong model for diagnosing errors, because a single dropped or added
 * character shifts every position after it:
 *
 *     expected  h e l l o
 *     typed     h e l o
 *     positional:  h=h  e=e  l=l  l->o      "substitution l->o", 1 missed
 *     aligned:     h=h  e=e  l=l  -l-  o=o  "omission of l"
 *
 * The positional reading invents a confusion between `l` and `o` that the
 * typist never had. In longer words every remaining character keeps cascading,
 * so one dropped key can manufacture a whole run of fabricated confusion
 * pairs — which then flow into `topConfusions` and into the model's prompt as
 * if they were evidence.
 *
 * Alignment fixes this by allowing gaps: the cheapest edit script that turns
 * the expected string into the typed one tells us what actually happened.
 *
 * ## The algorithm
 *
 * Needleman-Wunsch (global alignment) with unit costs — substitution 1, gap 1,
 * match 0 — minimised by dynamic programming. Unit costs mean a substitution
 * is always preferred to an insert/delete pair (cost 1 vs 2), which is the
 * right bias: typing the wrong key is far more common than simultaneously
 * dropping one and adding another.
 *
 * Words are short (a few characters), so the O(n*m) table is trivial here.
 *
 * Pure — no I/O, no React. See align.test.ts.
 */

export type AlignOpKind = "match" | "substitution" | "insertion" | "omission";

export type AlignOp = {
  kind: AlignOpKind;
  /** The expected character. Empty for an insertion (nothing was called for). */
  expected: string;
  /** The character actually produced. Empty for an omission (nothing typed). */
  typed: string;
  /** Index into the expected string, or -1 for an insertion. */
  expectedIdx: number;
  /** Index into the typed string, or -1 for an omission. */
  typedIdx: number;
};

const COST_MATCH = 0;
const COST_SUBSTITUTION = 1;
const COST_GAP = 1;

/**
 * Aligns `typed` against `expected`, returning the edit script in expected
 * order.
 *
 * Traceback tie-breaking is fixed and deterministic — diagonal (match or
 * substitution) first, then omission, then insertion — so the same pair of
 * strings always produces the same script. An unstable tie-break would make
 * the confusion matrix depend on floating-point ordering rather than on the
 * typist.
 *
 * Note that ties are common and real: in `hello` vs `helo`, either of the two
 * adjacent `l`s can carry the gap for the same cost. Which one is chosen is
 * arbitrary and carries no meaning — the *counts* are what every caller reads,
 * and those are identical under either choice. Don't build anything on the
 * position of a gap inside a run of repeated characters.
 *
 * Empty inputs are handled without special-casing: aligning against an empty
 * string yields all insertions or all omissions, which is exactly right.
 */
export function alignWord(expected: string, typed: string): AlignOp[] {
  const rows = expected.length;
  const cols = typed.length;

  // cost[i][j] = cheapest alignment of expected[0..i) against typed[0..j)
  const cost: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );

  for (let i = 1; i <= rows; i++) cost[i][0] = i * COST_GAP;
  for (let j = 1; j <= cols; j++) cost[0][j] = j * COST_GAP;

  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= cols; j++) {
      const diagonal =
        cost[i - 1][j - 1] +
        (expected[i - 1] === typed[j - 1] ? COST_MATCH : COST_SUBSTITUTION);
      const omission = cost[i - 1][j] + COST_GAP;
      const insertion = cost[i][j - 1] + COST_GAP;
      cost[i][j] = Math.min(diagonal, omission, insertion);
    }
  }

  const ops: AlignOp[] = [];
  let i = rows;
  let j = cols;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const isMatch = expected[i - 1] === typed[j - 1];
      const diagonal = cost[i - 1][j - 1] + (isMatch ? COST_MATCH : COST_SUBSTITUTION);
      if (cost[i][j] === diagonal) {
        ops.push({
          kind: isMatch ? "match" : "substitution",
          expected: expected[i - 1],
          typed: typed[j - 1],
          expectedIdx: i - 1,
          typedIdx: j - 1,
        });
        i -= 1;
        j -= 1;
        continue;
      }
    }

    if (i > 0 && cost[i][j] === cost[i - 1][j] + COST_GAP) {
      ops.push({
        kind: "omission",
        expected: expected[i - 1],
        typed: "",
        expectedIdx: i - 1,
        typedIdx: -1,
      });
      i -= 1;
      continue;
    }

    ops.push({
      kind: "insertion",
      expected: "",
      typed: typed[j - 1],
      expectedIdx: -1,
      typedIdx: j - 1,
    });
    j -= 1;
  }

  return ops.reverse();
}

/**
 * Rewrites adjacent substitution pairs that swap two characters into a single
 * transposition, run over an already-computed script.
 *
 * `ab` typed as `ba` aligns as two substitutions (a->b, b->a) because
 * Needleman-Wunsch has no transposition move. Detecting it afterwards keeps
 * the alignment itself simple and matches how the taxonomy has always defined
 * a transposition — see src/lib/analysis/errors.ts. The pair is consumed, so
 * neither half is also counted as a substitution.
 *
 * Returns the indices, into `ops`, of the first element of each detected pair.
 */
export function findTranspositions(ops: AlignOp[]): number[] {
  const found: number[] = [];
  for (let i = 0; i < ops.length - 1; i++) {
    const a = ops[i];
    const b = ops[i + 1];
    if (a.kind !== "substitution" || b.kind !== "substitution") continue;
    if (a.expected === b.expected) continue;
    if (a.expected !== b.typed || a.typed !== b.expected) continue;
    found.push(i);
    i += 1; // consume the pair — the second half can't start another
  }
  return found;
}
