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
 * At any single instant there are only ever TWO calendar days anywhere on
 * earth. So a suite asserting the club's `today()` must NOT list `"UTC"` as a
 * rival: with the environment on one of the two days and UTC on the other, no
 * candidate can differ from both and this would throw on a correct tree. Rivals
 * are opt-in for exactly that reason.
 *
 * ## The other way of doing this, and when it is the better one
 *
 * Nine suites under `src/app/api/**` solve the same problem from the other end:
 * they `vi.mock("@/config/operational")` so `APP_TIME_ZONE` is a LITERAL
 * (`America/Denver`) on every host, and then vary the persisted club zone
 * against it. That is simpler where it fits, and `@/config/operational` has only
 * four exports so the mock is cheap to keep complete.
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

export interface ChooseDivergentClubZoneOptions<Case extends ClubZoneCase> {
  /**
   * What the assertion is about, for the failure message — e.g.
   * "the club's today" or "the Xero cache stamp".
   */
  readonly subject: string;
  /** Candidates in preference order; the first divergent one wins. */
  readonly cases: readonly Case[];
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
 * @throws when no candidate diverges — deliberately, rather than skipping.
 */
export function chooseDivergentClubZone<Case extends ClubZoneCase>({
  subject,
  cases,
  answerFor,
  alsoDifferFrom = [],
}: ChooseDivergentClubZoneOptions<Case>): Case {
  const rivals = [...new Set([APP_TIME_ZONE, ...alsoDifferFrom])].map(
    (zone) => ({ zone, answer: answerFor(zone) }),
  );

  const chosen = cases.find((candidate) => {
    const answer = answerFor(candidate.zone);
    return rivals.every((rival) => rival.answer !== answer);
  });
  if (chosen) return chosen;

  const table = [
    ...rivals.map((rival) => `  rival     ${rival.zone} -> ${rival.answer}`),
    ...cases.map(
      (candidate) =>
        `  candidate ${candidate.zone} -> ${answerFor(candidate.zone)}`,
    ),
  ].join("\n");
  throw new Error(
    `No candidate club zone disagrees with the environment about ${subject}, so an ` +
      `assertion under any of them would pass whether or not the club's persisted zone ` +
      `was used (CT-4, #2870; INV-CONFIG-002). This is an environment problem, not the ` +
      `defect the suite describes: APP_TIME_ZONE is "${APP_TIME_ZONE}" (process.env.TZ ` +
      `= ${JSON.stringify(process.env.TZ)}). Add a candidate zone that diverges here, ` +
      `with its own expected literals — do NOT relax the rivals.\n${table}`,
  );
}
