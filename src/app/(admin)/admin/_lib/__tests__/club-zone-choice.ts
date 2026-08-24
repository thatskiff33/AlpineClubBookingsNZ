/**
 * Choosing the club timezone a ZONE-AUTHORITY assertion runs under — relative
 * to whatever the environment resolves to, rather than pinned to a literal
 * (CT-4, #2870; epic #2988).
 *
 * ## The problem, and it is not hypothetical
 *
 * A test that means to prove "this screen used the club's PERSISTED zone, not
 * the environment's" has to render under a zone the environment does not hold,
 * and assert an answer only that zone produces. The house choice for that has
 * been the literal `America/Denver`, because it is behind UTC where these
 * defects show and because `APP_TIME_ZONE` resolves to `Pacific/Auckland` under
 * test.
 *
 * That literal is only divergent BY COINCIDENCE. `APP_TIME_ZONE` is
 * `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`, so a contributor —
 * or a future CI image — running with `TZ=America/Denver` makes the club zone
 * and the environment the same zone, and every assertion underneath stops
 * telling them apart. MEASURED on this branch: with `TZ=America/Denver`, three
 * of group D's four zone suites had a premise guard go red, and a fourth
 * (`subscription-billing-panel`) went quietly vacuous because its premise
 * compared two of its own constants and never consulted the environment at all.
 * A silent one is the worse outcome of the two.
 *
 * ## What this does instead
 *
 * The suite supplies SEVERAL candidate zones, each carrying its own
 * hand-written expected literals, and this picks the first whose answer differs
 * from every rival — the environment always, plus whatever else that particular
 * assertion has to exclude (`"UTC"`, when the test pins the host there and a
 * host read would be a plausible bug). The expectations stay hand-checkable
 * literals rather than being recomputed by the kernel under test, which would
 * make the assertion agree with itself; all that moves is WHICH literal pair is
 * in force.
 *
 * ## `answerKey` — why the helper insists on being told which literal is the answer
 *
 * A first version of this only guaranteed that the ORACLE diverged. That is not
 * the same as guaranteeing the SUITE's assertion diverges: the suite asserts its
 * own hand-written literal, and if that literal were mistyped as the
 * environment's value the test would demand the environment's answer and pass
 * against the very defect it describes. Four of the five original importers
 * re-established the link by hand with an `expect(chosen.today).not.toBe(
 * environmentToday)`, which works exactly until an adopter forgets it.
 *
 * So the caller names the field holding the oracle's answer, and this checks
 * every candidate's literal against `answerFor(candidate.zone)` before choosing.
 * A typo in a fixture is then an immediate, explained failure rather than a
 * quietly weaker test, and the chosen literal is provably not the environment's.
 * Callers no longer need the hand-written premise line for the answer field
 * itself — only for further literals they DERIVE from it, which this cannot see.
 *
 * ## Why it throws rather than skipping when nothing diverges
 *
 * Owner decision, 23 Aug 2026: where a premise no longer holds, the test fails
 * loudly. A skip is a green suite that proved nothing, which is the exact
 * failure mode this epic keeps finding. With two or three well-spread
 * candidates the throw is unreachable in practice — but the message below
 * prints the whole table, so if it ever does fire the reader is handed the
 * diagnosis instead of a mystery.
 *
 * ## A note on "today" assertions, learned the hard way
 *
 * At one instant the earth holds only TWO calendar days for most of the day and
 * THREE for one hour of it. MEASURED over all 418 zones `Intl` knows: offsets
 * span −11 to +14, twenty-five hours, so a third day exists precisely while UTC
 * is between 10:00 and 10:59 — at `2026-07-01T10:00:00Z` the zones read 30 June,
 * 1 July and 2 July at once. Outside that hour there are two.
 *
 * Two things follow, and both matter when picking a fixture instant:
 *
 * 1. **Do not list `"UTC"` as a rival for a "today" assertion unless you have
 *    checked your instant is in that hour.** With two days in existence and the
 *    environment holding one of them, UTC holds one of the two as well; a
 *    candidate would have to differ from both and there is nothing left to
 *    choose, so this would throw on a completely correct tree. Rivals are opt-in
 *    for exactly that reason.
 * 2. **Two candidates are enough, and only just.** Outside the three-day hour
 *    the two candidates must between them cover both days that exist, or the
 *    chooser has nothing to fall back on when the environment moves onto one of
 *    them. The house pair — one zone well behind UTC and one well ahead — does
 *    that. Every fixture in this repository sits outside the three-day hour
 *    (the frozen clock is `2026-07-01T00:00:00.000Z`), so the two-day rule is
 *    the one in force here.
 *
 * ## The other way of doing this, and when it is the better one
 *
 * Ten suites under `src/app/api/**` solve the same problem from the other end:
 * they `vi.mock("@/config/operational")` so `APP_TIME_ZONE` is a LITERAL on
 * every host, and then vary the persisted club zone against it. MEASURED: five
 * of the ten pin `America/Denver` and the other five pin `Pacific/Auckland`,
 * so it is not one house literal but a per-suite choice of which environment
 * the test wants to be arguing with. That is simpler where it fits, and
 * `@/config/operational` has only four exports so the mock is cheap to keep
 * complete.
 *
 * It was not the right tool here, for two reasons worth writing down. It pins
 * the rival rather than testing against the real one, so it cannot notice that
 * a genuine behind-UTC deployment breaks; and in a component suite the mocked
 * module is in the render graph — `APP_LOCALE` and `APP_CURRENCY` reach money
 * and date formatting in the same tree — so pinning it changes what the file's
 * OTHER tests see. Reach for the config mock in a route or service suite where
 * the graph is narrow; reach for this where a component renders.
 *
 * ## Where this wants to live
 *
 * Next to `expectClubTimeZonePremise` in
 * `src/lib/__tests__/helpers/club-time-zone.ts`, so groups E and F can reach it
 * without importing out of the admin tree. `src/lib` is another lane's surface
 * on this epic, so it is here for now and reported on #2870 for the hoist.
 */

import { APP_TIME_ZONE } from "@/config/operational";

/** A candidate club zone plus whatever literals the suite pinned for it. */
export interface ClubZoneCase {
  /** The IANA identifier handed to `ClubTimeProvider` or `bindClubTime`. */
  readonly zone: string;
}

/** Any field of a case other than the zone itself may hold the oracle's answer. */
type AnswerKey<Case extends ClubZoneCase> = Exclude<keyof Case, "zone">;

export interface ChooseDivergentClubZoneOptions<
  Case extends ClubZoneCase,
  Key extends AnswerKey<Case>,
> {
  /**
   * What the assertion is about, for the failure message — e.g.
   * "the club's today" or "the Xero cache stamp".
   */
  readonly subject: string;
  /** Candidates in preference order; the first divergent one wins. */
  readonly cases: readonly Case[];
  /**
   * Which field of a case holds the value `answerFor` produces. Every
   * candidate's literal is checked against its own zone's answer before
   * anything is chosen, so a mistyped fixture fails here rather than weakening
   * the assertion downstream. Other literals on the case (a derived label, a
   * second bound) are the suite's own and are not checked.
   */
  readonly answerKey: Key;
  /**
   * The answer the code under test would produce for a given zone. Keep it to
   * the ONE operation the suite asserts: two zones can agree on the day and
   * disagree on the hour, and a chooser told about the wrong one picks a zone
   * that leaves the real assertion vacuous.
   */
  readonly answerFor: (zone: string) => string;
  /**
   * Extra zones the chosen answer must also differ from. The environment is
   * always a rival; add `"UTC"` when reading the host would be a plausible bug
   * the assertion should exclude — but see the "today" note above.
   */
  readonly alsoDifferFrom?: readonly string[];
}

/**
 * The first candidate whose answer differs from the environment's and from
 * every extra rival.
 *
 * @throws when a candidate's pinned literal disagrees with its own zone's
 * answer, when the environment's zone cannot be projected at all, or when no
 * candidate diverges — each deliberately, rather than skipping.
 */
export function chooseDivergentClubZone<
  Case extends ClubZoneCase,
  Key extends AnswerKey<Case>,
>({
  subject,
  cases,
  answerKey,
  answerFor,
  alsoDifferFrom = [],
}: ChooseDivergentClubZoneOptions<Case, Key>): Case {
  const rivalZones = [...new Set([APP_TIME_ZONE, ...alsoDifferFrom])];
  const rivals = rivalZones.map((zone) => ({
    zone,
    /*
     * `APP_TIME_ZONE` is an unvalidated `process.env.TZ` passthrough, so it can
     * be a Windows zone name ("New Zealand Standard Time") or a POSIX TZ string
     * ("NZST-12NZDT,M9.5.0,M4.1.0/3"), and `Intl` answers either with a bare
     * `RangeError: Invalid time zone specified`. Unwrapped, that surfaces as a
     * mystery failure from inside a test helper — precisely the "environment
     * problem misread as a product bug" this file exists to prevent — so it is
     * re-thrown carrying the same diagnosis as the no-candidate case.
     */
    answer: safeAnswer(zone, answerFor, subject),
  }));

  for (const candidate of cases) {
    const answer = answerFor(candidate.zone);
    const pinned = String(candidate[answerKey]);
    if (pinned !== answer) {
      throw new Error(
        `Candidate zone "${candidate.zone}" pins ${String(answerKey)} = ` +
          `${JSON.stringify(pinned)} for ${subject}, but that zone actually answers ` +
          `${JSON.stringify(answer)} (CT-4, #2870). The pinned literal is what the suite ` +
          `asserts, so a wrong one would demand the wrong value — and if it happened to ` +
          `match the environment's answer the test would pass against the defect it ` +
          `describes. Fix the literal, or the candidate's zone.`,
      );
    }
  }

  const chosen = cases.find((candidate) => {
    const answer = answerFor(candidate.zone);
    return rivals.every((rival) => rival.answer !== answer);
  });
  if (chosen) return chosen;

  throw new Error(
    `No candidate club zone disagrees with the environment about ${subject}, so an ` +
      `assertion under any of them would pass whether or not the club's persisted zone ` +
      `was used (CT-4, #2870; INV-CONFIG-002). This is an environment problem, not the ` +
      `defect the suite describes: ${describeEnvironment()}. Add a candidate zone that ` +
      `diverges here, with its own expected literals — do NOT relax the rivals.\n` +
      describeTable(rivals, cases, answerFor),
  );
}

function describeEnvironment(): string {
  return (
    `APP_TIME_ZONE is ${JSON.stringify(APP_TIME_ZONE)} (process.env.TZ = ` +
    `${JSON.stringify(process.env.TZ)})`
  );
}

function describeTable<Case extends ClubZoneCase>(
  rivals: ReadonlyArray<{ zone: string; answer: string }>,
  cases: readonly Case[],
  answerFor: (zone: string) => string,
): string {
  return [
    ...rivals.map((rival) => `  rival     ${rival.zone} -> ${rival.answer}`),
    ...cases.map(
      (candidate) =>
        `  candidate ${candidate.zone} -> ${answerFor(candidate.zone)}`,
    ),
  ].join("\n");
}

function safeAnswer(
  zone: string,
  answerFor: (zone: string) => string,
  subject: string,
): string {
  try {
    return answerFor(zone);
  } catch (cause) {
    throw new Error(
      `The rival zone ${JSON.stringify(zone)} could not be projected at all while ` +
        `choosing a club zone for ${subject} (CT-4, #2870). ${describeEnvironment()}. ` +
        `An IANA identifier is what this needs; a Windows zone name or a POSIX TZ ` +
        `string is not one, and Intl rejects it with a bare RangeError. This is an ` +
        `environment problem, not the defect the suite describes — set TZ to an IANA ` +
        `identifier, or unset it so the shipped default applies.`,
      { cause },
    );
  }
}
