// Same-person (typo-correction) guard for editing a free-text NON-MEMBER guest
// name AFTER a booking is fully paid (issue #1386).
//
// The paid-name lock exists to stop swapping in a DIFFERENT person after
// payment — an unauthorised booking transfer/resale. We relax it ONLY for an
// unambiguous spelling correction of the SAME name, and we draw the line
// CONSERVATIVELY: a false reject just sends the member to the office (the prior
// status quo), while a false accept opens a transfer hole. When in doubt, reject.
//
// A change counts as a typo correction only when ALL of the following hold, on
// names normalised as: trim + lowercase + collapse internal whitespace.
//
//   1. Neither NEW name part is blank — never drop a name to nothing.
//   2. First name and last name each keep the SAME word/token count: a typo
//      fixes letters, it never adds or removes a name part. This alone rejects
//      "John" -> "Johnathan Smith".
//   3. No positionally-aligned token is a whole-token REPLACEMENT. A real typo
//      keeps most of a token's characters, so for each aligned first-name and
//      last-name token pair we reject when at least half of the longer token
//      changed (edit distance * 2 >= max token length). This kills
//      surname-family swaps like "David Ng" -> "David Wu" and "Ann Ho" ->
//      "Ann Lo", and short given-name swaps, even when the overall distance is
//      small — while still allowing real typos that preserve most letters
//      ("Jhon" -> "John" keeps j/o/n, "Sara" -> "Sarah" keeps Sar).
//   4. The Damerau-Levenshtein distance between the normalised FULL names
//      (an adjacent-character transposition counts as a single edit) is at most
//         min(2, floor(0.25 * lengthOfLongerNormalisedFullName))
//      i.e. at most TWO edits, and never more than a quarter of the longer
//      name — whichever bound is smaller. Distance 0 (a pure case/whitespace
//      fix) is allowed: it is unambiguously the same identity.
//
// Token overlap alone is deliberately NOT used as the test: it would pass a
// same-surname given-name swap ("John Smith" -> "Jane Smith"). This guard
// REJECTS that (full-name distance 3 > 2), and rejects a full swap
// ("John Smith" -> "Aroha Ngata") the same way.
//
// IRREDUCIBLE RESIDUAL (accepted by design): a SINGLE-character change on a
// token that keeps most of its letters is indistinguishable from a spelling
// typo by string comparison, so short one-edit swaps such as "Kim" -> "Tim",
// "Sam" -> "Pam", or "Rob" -> "Bob" are STILL accepted. On PAID/CONFIRMED
// bookings the owner (booking.memberId === actor) can self-serve this, so it
// cannot be closed in code. The mitigation is the audit trail: every allowed
// post-payment fix writes a `GUEST_TYPO_FIX` BookingModification row (old->new
// names, actor, time) that admins should periodically review. Tightening the
// per-token and distance bounds above already removes the wider swaps
// (Ng->Wu, Ho->Lo, Bob->Amy); the single-edit case is the remaining exposure.

import { must } from "@/lib/indexed-access";

function normalizeNamePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenCount(normalized: string): number {
  return normalized ? normalized.split(" ").length : 0;
}

/**
 * True when any positionally-aligned token in the (already normalised) name
 * part is a whole-token replacement rather than a typo — i.e. at least half of
 * the longer token changed (edit distance * 2 >= max token length). The caller
 * guarantees `prev` and `next` have the same token count. A real typo keeps
 * most of a token's characters, so this flags surname-family swaps ("ng" ->
 * "wu", "ho" -> "lo") and short given-name swaps ("bob" -> "amy") while leaving
 * true typos ("jhon" -> "john", "sara" -> "sarah") untouched.
 */
function hasReplacedToken(prev: string, next: string): boolean {
  const prevTokens = prev.split(" ");
  const nextTokens = next.split(" ");
  for (let i = 0; i < prevTokens.length; i++) {
    // The caller guarantees `prev` and `next` have the same token count, so
    // `nextTokens` always has an element at every `prevTokens` index too.
    const prevToken = must(prevTokens[i], `hasReplacedToken: no prev token at index ${i}`);
    const nextToken = must(nextTokens[i], `hasReplacedToken: no next token at index ${i} - prev/next token counts differ`);
    const maxLen = Math.max(prevToken.length, nextToken.length);
    if (maxLen === 0) continue;
    if (2 * damerauLevenshtein(prevToken, nextToken) >= maxLen) {
      return true;
    }
  }
  return false;
}

/**
 * Damerau-Levenshtein (optimal string alignment) edit distance: counts
 * insertions, deletions, substitutions, and adjacent transpositions each as a
 * single edit. Pure and deterministic.
 */
/**
 * Read/write one cell of the (al+1) x (bl+1) DP table below. Every `i`/`j`
 * this module passes is in `0..al`/`0..bl` by the loop bounds around each
 * call site (an adjacent-transposition read additionally guarded by `i > 1`/
 * `j > 1`), so the row and the cell always exist.
 */
function dpCell(table: number[][], i: number, j: number): number {
  const row = must(table[i], `damerauLevenshtein: no row ${i}`);
  return must(row[j], `damerauLevenshtein: no cell [${i}][${j}]`);
}
function setDpCell(table: number[][], i: number, j: number, value: number): void {
  must(table[i], `damerauLevenshtein: no row ${i}`)[j] = value;
}

export function damerauLevenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const d: number[][] = Array.from({ length: al + 1 }, () =>
    new Array<number>(bl + 1).fill(0),
  );
  for (let i = 0; i <= al; i++) setDpCell(d, i, 0, i);
  for (let j = 0; j <= bl; j++) setDpCell(d, 0, j, j);

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      setDpCell(
        d,
        i,
        j,
        Math.min(
          dpCell(d, i - 1, j) + 1, // deletion
          dpCell(d, i, j - 1) + 1, // insertion
          dpCell(d, i - 1, j - 1) + cost, // substitution
        ),
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        // adjacent transposition
        setDpCell(d, i, j, Math.min(dpCell(d, i, j), dpCell(d, i - 2, j - 2) + 1));
      }
    }
  }

  return dpCell(d, al, bl);
}

/**
 * True only when changing (prevFirst, prevLast) to (newFirst, newLast) is an
 * unambiguous spelling correction of the SAME name — see the file header for
 * the exact rule. Rejects anything that could be a different person.
 */
export function isLikelyTypoCorrection(
  prevFirst: string,
  prevLast: string,
  newFirst: string,
  newLast: string,
): boolean {
  const newFirstNorm = normalizeNamePart(newFirst);
  const newLastNorm = normalizeNamePart(newLast);
  // Never allow dropping a name part to blank after payment.
  if (!newFirstNorm || !newLastNorm) {
    return false;
  }

  const prevFirstNorm = normalizeNamePart(prevFirst);
  const prevLastNorm = normalizeNamePart(prevLast);

  // A typo fixes letters; it never adds or removes a name part.
  if (tokenCount(prevFirstNorm) !== tokenCount(newFirstNorm)) {
    return false;
  }
  if (tokenCount(prevLastNorm) !== tokenCount(newLastNorm)) {
    return false;
  }

  // Reject a whole-token replacement (a swap) even when the overall distance is
  // small — e.g. "David Ng" -> "David Wu" or "Ann Ho" -> "Ann Lo".
  if (
    hasReplacedToken(prevFirstNorm, newFirstNorm) ||
    hasReplacedToken(prevLastNorm, newLastNorm)
  ) {
    return false;
  }

  const prevFull = `${prevFirstNorm} ${prevLastNorm}`.trim();
  const newFull = `${newFirstNorm} ${newLastNorm}`.trim();

  const distance = damerauLevenshtein(prevFull, newFull);
  const longerLength = Math.max(prevFull.length, newFull.length);
  const threshold = Math.min(2, Math.floor(longerLength * 0.25));

  return distance <= threshold;
}
