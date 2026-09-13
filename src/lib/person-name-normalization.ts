/**
 * ONE spelling of "the same written name", for every place that compares one
 * person's written name with another's (`INV-SSOT-001`).
 *
 * The normalisation is deliberately the dullest one the project already used:
 * **trim, lowercase, collapse internal whitespace**. Nothing phonetic, nothing
 * partial, no accent folding, no nickname table. Two names are "the same" here
 * only when they are the same characters typed with different spacing or case.
 *
 * WHY IT IS A MODULE RATHER THAN A LOCAL HELPER. It was a private
 * `normalizeNamePart` inside `guest-name-similarity.ts` when #2721 needed the
 * identical rule for own-dependant collision detection
 * (`booking-dependant-identity.ts`). Two hand-written copies of a name
 * comparison are two rules the day someone folds accents into one of them: the
 * post-payment typo guard would start accepting a rename the dependant guard
 * still called a different person, or the other way round. One home, imported
 * twice.
 *
 * WHY IT MUST NOT GROW CLEVERER WITHOUT A DECISION. Both callers use it to
 * decide identity, and each fails in a different direction. Widening what counts
 * as "the same name" makes the typo guard accept more post-payment renames (a
 * booking-transfer hole, #1386) and makes the dependant guard stop more genuine
 * different-people (a booking a parent cannot make at all, #2721). The owner rule
 * on #2721 is explicit that matching stays exact on the normalised form.
 */

/**
 * Normalise ONE name part — a first name or a last name.
 *
 * Returns `""` for a value that is only whitespace, and every caller must treat
 * an empty part as "no name to compare" rather than as a match: an empty string
 * equals another empty string, which would make two half-filled guest rows
 * collide with each other and with an unnamed member.
 *
 * A MISSING value is the same answer rather than a throw, and the reason is the
 * shape of the callers rather than tidiness. Both of them are GUARDS reading a
 * party row: the #2721 collision detector runs over proposed booking guests on
 * the server and again in the wizard, where a row is half-built while it is
 * being typed. A guard that throws on a row it cannot read turns a refusal the
 * member could act on into a 500 they cannot, and it fails in the loud
 * direction for a value that could never have matched anybody anyway. The
 * declared type still says `string`, so a typed caller is told to pass one.
 */
export function normalizePersonNamePart(
  value: string | null | undefined,
): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The comparison key for a whole person: `"<first> <last>"`, each part
 * normalised, joined by exactly one space.
 *
 * Returns `""` when EITHER part normalises to empty. That is the one deliberate
 * asymmetry in this module: a key is only minted for a person whose name is
 * complete, so a guest row still being typed ("Sam" with no surname yet) can
 * never collide with anybody. Callers test the key for emptiness rather than
 * testing the two parts themselves, so that decision has one home too.
 */
export function normalizePersonFullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  const first = normalizePersonNamePart(firstName);
  const last = normalizePersonNamePart(lastName);
  if (!first || !last) return "";
  return `${first} ${last}`;
}
