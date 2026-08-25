/**
 * The two club-timezone premise helpers a temporal suite needs.
 *
 * {@link expectClubTimeZonePremise} is for a suite whose subject is "the club's
 * calendar day is NOT the UTC day". {@link divergentClubZone} is for a suite
 * whose subject is "the PERSISTED zone, and not the environment, is the
 * authority" — a different claim, and the one this epic keeps failing to test.
 */
import { expect } from "vitest";

import { APP_TIME_ZONE } from "@/config/operational";
import { asClubTimeZone, type ClubTimeZone } from "@/lib/club-time";

/**
 * The premise guard for a suite whose subject is "the club's calendar day is
 * NOT the UTC day" (#2834, INV-DATE-019).
 *
 * `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`
 * (`src/config/operational.ts`), so setting `TZ=UTC` to imitate the CI runner
 * ALSO moves the club's zone to UTC — docs/TESTING.md rule 6. Every assertion in
 * a suite like this then goes red with a bare `expected '2026-06-14' to be
 * '2026-06-15'`, which reads exactly like the product bug the suite exists to
 * prove fixed. One environment failure that says so is worth more than thirty
 * date mismatches that do not.
 *
 * Call it from the `beforeEach` of the block that pins a divergent instant, so
 * the explanation arrives before any date assertion runs.
 */
export function expectClubTimeZonePremise(): void {
  expect(
    APP_TIME_ZONE,
    "This assertion proves the club's calendar day differs from the UTC day, so it needs the club zone to be New Zealand. APP_TIME_ZONE is being overridden by TZ (or NEXT_PUBLIC_TZ) — see docs/TESTING.md rule 6. This is an environment problem, not the dating bug these tests describe.",
  ).toBe("Pacific/Auckland");
}

/**
 * The zones this helper is allowed to hand out as "the club's", widest offset
 * spread first so the search below terminates on the first candidate for almost
 * every host.
 *
 * `Pacific/Auckland` is deliberately ABSENT. It is what `APP_TIME_ZONE` falls
 * back to and what `CLUB_TIME_TEST_ZONE` hands the shared render harness, so a
 * suite that ended up on it would be back to the blind default this helper
 * exists to escape.
 *
 * BOTH OFFSET EXTREMES ARE REQUIRED, not a nice spread. A calendar-day
 * derivation has only two or three possible answers on the whole planet at any
 * instant (see "Choosing the instant" below), and two of them can already be
 * taken — one by `APP_TIME_ZONE`, one by the host. So the list has to be able to
 * reach the remaining day from either end: `Pacific/Kiritimati` is UTC+14 and
 * `Pacific/Pago_Pago` is UTC-11, with the rest in the middle. Dropping an
 * extreme turns "a divergent zone always exists" into
 * "depends on the machine".
 */
const CANDIDATE_CLUB_ZONES = [
  "America/Denver",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
  "Europe/Berlin",
  "Asia/Tokyo",
  "America/Sao_Paulo",
  "Pacific/Honolulu",
] as const;

/** What {@link divergentClubZone} hands back. */
export interface DivergentClubZone<T> {
  /** The club's persisted zone. Never one that either mutant class would reach. */
  readonly zone: ClubTimeZone;
  /** `derive(zone)` — the ORACLE, computed from the chosen zone. */
  readonly expected: T;
  /** `derive(APP_TIME_ZONE)` — proven to differ from {@link expected}. */
  readonly environmentAnswer: T;
  /** `derive(the host's own resolved zone)` — proven to differ too. */
  readonly hostAnswer: T;
}

/**
 * The zone this process's own `Date` component APIs answer in.
 *
 * READING `resolvedOptions().timeZone` IS THE POINT HERE, and it is the one
 * legitimate use of it: this helper's job is to be sure the club's zone is not
 * the host's, which cannot be established without asking the host. The read
 * `INV-CONFIG-002` forbids is a CLIENT deciding club time from the viewer's
 * clock; a test asserting that no such decision is being made is the opposite.
 *
 * It is deliberately NOT `APP_TIME_ZONE`. On the CI runner those two are
 * DIFFERENT — the host resolves `UTC` while `APP_TIME_ZONE` falls back to
 * `Pacific/Auckland` — so a suite that checked only one of them still could not
 * tell a host-local-getter implementation from a correct one.
 */
function hostResolvedZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A zone identifier one of the WRONG answers is computed in, branded WITHOUT
 * validation.
 *
 * That has to be unvalidated, and it is worth spelling out because validating it
 * would have turned every importing suite red on CI and green here. CT-1's
 * validator refuses `"UTC"` on purpose — it is not a named region zone and no
 * club may choose it — and the CI runner's own host resolves EXACTLY `"UTC"`.
 * `APP_TIME_ZONE` is a raw `process.env` string too, which a deployment can
 * legitimately set to `UTC`, `NZ` or `EST`; `club-time/zone.ts` brands it
 * unvalidated for the legacy adapters for the same reason.
 *
 * Neither value is a candidate for the club's zone. They are the answers a WRONG
 * implementation would give, so the only thing that matters is that `Intl` can
 * describe them — and `Intl` accepts far more than CT-1 does.
 */
function probeZone(id: string): ClubTimeZone {
  return id as ClubTimeZone;
}

/**
 * A club zone whose answer to `derive` is DIFFERENT from both the environment's
 * and the host's, plus all three answers.
 *
 * ## Why a suite needs this at all
 *
 * `src/lib/__tests__/support/club-time-render.tsx` sets
 * `CLUB_TIME_TEST_ZONE = "Pacific/Auckland"`, deliberately equal to what
 * `APP_TIME_ZONE` resolves to under test, so that moving 37 suites onto the
 * shared renderer changed no expected string. The consequence is stated in that
 * file and is worth restating: **a suite on the default wrapper cannot tell the
 * persisted zone from the environment, whatever it asserts.** Measured on this
 * epic, a mutant hook that ignored the provider entirely failed 0 of 460
 * assertions across 34 such suites.
 *
 * A hand-picked divergent zone (`America/Denver`, the house choice) fixes that
 * on a default host and breaks on a developer whose `TZ` is already Denver —
 * where the two agree again and the suite silently stops discriminating without
 * going red. So the zone has to be chosen RELATIVE to whatever the environment
 * resolves, which is what this does.
 *
 * ## It defeats BOTH mutant classes, not one
 *
 * There are two ways to get this wrong and they read differently in the source:
 * an implementation that formats through `APP_TIME_ZONE` (the ENVIRONMENT's
 * claim), and one that uses `getFullYear`/`getMonth`/`getDate` (the HOST's own
 * clock). Under test with `TZ` unset those two answer differently from each
 * other — `Pacific/Auckland` against `UTC` — so a chosen zone is only safe when
 * it diverges from both. This checks both, and says which one it could not
 * escape when it fails.
 *
 * ## It enforces the link rather than documenting it
 *
 * The earlier form of this chooser returned a zone and left each caller to write
 * its own expected literal, so it guaranteed that the two ZONES differed and
 * not that the suite's assertion could tell them apart — four of five importers
 * re-established that by hand. This one takes the derivation and returns the
 * oracle with it, then refuses to return at all unless the oracle differs from
 * both wrong answers. A provider-blind implementation produces
 * `environmentAnswer` and a host-local one produces `hostAnswer`, by
 * construction, so neither can match `expected`.
 *
 * `derive` must be a pure function of the zone (a `clubToday`, a
 * `clubCalendarDateOf`, a formatted instant). Values are compared by
 * `JSON.stringify`, so an object oracle works as long as its key order is
 * stable.
 *
 * ## Choosing the instant a CALENDAR-DAY derivation reads
 *
 * Put it in the 10:00-11:00 UTC hour — and the reason is the fact an earlier
 * review of this idea had backwards. **Three** calendar days exist
 * simultaneously on earth only while the UTC hour is 10: `UTC+14` has turned
 * over while `UTC-11` has not. At every other hour there are only TWO. So
 * outside that window a calendar-day derivation has at most two possible
 * answers, and both can already be taken — one by `APP_TIME_ZONE`, one by the
 * host — in which case no divergent zone exists at all and this helper can only
 * fail.
 *
 * Measured on the CI shape (host `UTC`, `APP_TIME_ZONE` `Pacific/Auckland`): a
 * fixture at 21:00 UTC leaves no third day and every candidate above is refused;
 * the same fixture at 10:30 UTC resolves on the first candidate. The three-days
 * fact is therefore not a curiosity to steer around — it is the property that
 * makes this helper terminate.
 *
 * A derivation with more than three possible answers — a wall-clock hour, a
 * formatted time, an instant — has no such constraint and works at any hour. A
 * suite deriving the club's TODAY has to pin its own instant with
 * `vi.setSystemTime`, because the repository's frozen clock sits at 00:00 UTC.
 *
 * A premise failure here is a FAILURE and never a skip (owner decision, #2870):
 * a suite that quietly stops checking when its premise breaks is the disease
 * this epic exists to cure.
 */
export function divergentClubZone<T>(
  derive: (zone: ClubTimeZone) => T,
): DivergentClubZone<T> {
  const hostZoneId = hostResolvedZone();
  const answerFor = (id: string, label: string): { value: T; json: string } => {
    let value: T;
    try {
      value = derive(probeZone(id));
    } catch (error) {
      throw new Error(
        `${label} is ${JSON.stringify(id)} and this runtime cannot describe an instant in it ` +
          `(${(error as Error).message}). That is an environment problem, not the behaviour under test.`,
      );
    }
    return { value, json: JSON.stringify(value) };
  };

  const environment = answerFor(APP_TIME_ZONE, "APP_TIME_ZONE");
  const host = answerFor(hostZoneId, "the host's resolved zone");

  const tried: string[] = [];
  for (const candidate of CANDIDATE_CLUB_ZONES) {
    if (candidate === APP_TIME_ZONE || candidate === hostZoneId) continue;
    const zone = asClubTimeZone(candidate);
    if (zone === null) continue;
    const expected = derive(zone);
    const json = JSON.stringify(expected);
    if (json !== environment.json && json !== host.json) {
      return {
        zone,
        expected,
        environmentAnswer: environment.value,
        hostAnswer: host.value,
      };
    }
    tried.push(`${candidate} -> ${json}`);
  }

  throw new Error(
    "No candidate club zone gives an answer different from BOTH the environment's " +
      `(APP_TIME_ZONE ${APP_TIME_ZONE} -> ${environment.json}) and the host's ` +
      `(${hostZoneId} -> ${host.json}); tried ${tried.join(", ") || "none"}. ` +
      "Without a zone that diverges from both, this assertion cannot tell the club's persisted zone " +
      "from an implementation that formats through APP_TIME_ZONE or one that reads the host's own " +
      "Date getters, so it would pass for either. Either the derivation is zone-independent — in which " +
      "case it needs no zone and should not be using this helper — or the fixture instant needs moving " +
      "to a time of day at which the candidates disagree.",
  );
}

/* -------------------------------------------------------------------------
 * The HAND-WRITTEN-LITERAL chooser — the default (CT-6, #2991).
 *
 * `divergentClubZone` above computes its oracle from the kernel. That is the
 * stronger guarantee about ZONES and the weaker one about ASSERTIONS: an
 * expected value derived from the same kernel the subject calls lets a wrong
 * kernel satisfy both sides of the comparison. `chooseDivergentClubZone` below
 * keeps the suite's own hand-written literals and only chooses WHICH pair is in
 * force, so a wrong kernel is caught and a mistyped fixture fails loudly.
 *
 * Orchestrator decision on #2991 (25 Aug 2026), taken so this lane did not
 * re-litigate two docblocks that each argue soundly against the other: the
 * hand-written-literal oracle is the DEFAULT, and the always-both-rivals
 * guarantee is available as an OPT-IN whose fixture constraint the helper
 * ASSERTS rather than documents. Both live here, in one file, because these two
 * implementations spent this epic in separate trees — one under
 * `src/app/(admin)/admin/_lib/__tests__` and one here — and four lanes each
 * worked around the absence of whichever one they could not import.
 * ------------------------------------------------------------------------- */

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
  /**
   * OPT IN to the stronger guarantee: the chosen answer must also differ from
   * the answer THIS PROCESS's own resolved zone gives, so the assertion
   * discriminates a host-local `getFullYear`/`getMonth`/`getDate`
   * implementation as well as an `APP_TIME_ZONE` one.
   *
   * Pass the instant the suite's `answerFor` reads. It is not decoration: for a
   * CALENDAR-DAY answer the helper asserts the instant can actually produce a
   * third distinct day, because outside the 10:00-10:59 UTC hour only two
   * calendar days exist on earth and both can already be taken — one by
   * `APP_TIME_ZONE`, one by the host. Documenting that constraint was the
   * previous arrangement and it degrades quietly: a suite whose host and
   * environment happen to coincide (a New Zealand developer with `TZ` unset)
   * passes locally at any hour and then finds no candidate at all on a CI
   * runner whose host is `UTC`. Asserted, the fixture is wrong in the same way
   * on every machine.
   */
  readonly alsoDifferFromHostAt?: Date;
}

/** `YYYY-MM-DD` — the answer shape the three-calendar-days constraint governs. */
const CALENDAR_DAY_ANSWER = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The UTC hour during which THREE calendar days exist on earth at once.
 *
 * Offsets span UTC-11 to UTC+14, twenty-five hours, so for one hour a day the
 * far side of the date line has turned over while the near side has not. At
 * `2026-07-01T10:00:00Z` the zones read 30 June, 1 July and 2 July at once; at
 * every other hour there are two.
 */
const THREE_CALENDAR_DAYS_UTC_HOUR = 10;

/** Milliseconds in a fixed 24-hour span — UTC day arithmetic only, never civil. */
const UTC_DAY_MS = 86_400_000;

/**
 * The first candidate whose answer differs from the environment's and from
 * every extra rival.
 *
 * @throws when a candidate's pinned literal disagrees with its own zone's
 * answer, when the environment's zone cannot be projected at all, when
 * {@link ChooseDivergentClubZoneOptions.alsoDifferFromHostAt} names an instant
 * that cannot produce a third calendar day, or when no candidate diverges —
 * each deliberately, rather than skipping.
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
  alsoDifferFromHostAt,
}: ChooseDivergentClubZoneOptions<Case, Key>): Case {
  const hostZoneId = hostResolvedZone();
  const rivalZones = [
    ...new Set([
      APP_TIME_ZONE,
      ...alsoDifferFrom,
      ...(alsoDifferFromHostAt === undefined ? [] : [hostZoneId]),
    ]),
  ];
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

  if (alsoDifferFromHostAt !== undefined) {
    assertThirdCalendarDayIsReachable({
      subject,
      instant: alsoDifferFromHostAt,
      environmentAnswer: rivals[0].answer,
      hostZoneId,
    });
  }

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

/**
 * The fixture constraint that `alsoDifferFromHostAt` opts into, ASSERTED.
 *
 * Two things are checked, and the second is the one that stops a caller
 * satisfying the first by naming an instant its derivation does not read:
 *
 * 1. the instant sits in the hour during which a third calendar day exists;
 * 2. the environment's own answer is one of the three calendar days that
 *    instant can produce anywhere on earth, so the derivation demonstrably
 *    reads it.
 *
 * Both are skipped when the answers are not calendar days. A wall-clock hour, a
 * formatted time or a whole instant has far more than three possible answers
 * across the zone set, so no window constrains it.
 */
function assertThirdCalendarDayIsReachable({
  subject,
  instant,
  environmentAnswer,
  hostZoneId,
}: {
  subject: string;
  instant: Date;
  environmentAnswer: string;
  hostZoneId: string;
}): void {
  if (!CALENDAR_DAY_ANSWER.test(environmentAnswer)) return;

  if (Number.isNaN(instant.getTime())) {
    throw new Error(
      `alsoDifferFromHostAt for ${subject} is an Invalid Date (CT-6, #2991). Pass the ` +
        `instant the suite's answerFor reads, so the three-calendar-days constraint ` +
        `can be checked against it.`,
    );
  }

  const utcHour = instant.getUTCHours();
  if (utcHour !== THREE_CALENDAR_DAYS_UTC_HOUR) {
    throw new Error(
      `alsoDifferFromHostAt asks that ${subject} differ from the HOST's answer as well ` +
        `as the environment's, but the fixture instant ${instant.toISOString()} is at ` +
        `${String(utcHour).padStart(2, "0")}:xx UTC, and THREE calendar days exist on ` +
        `earth only while the UTC hour is ${THREE_CALENDAR_DAYS_UTC_HOUR} (offsets span ` +
        `UTC-11 to UTC+14, twenty-five hours). At every other hour there are two, and ` +
        `both can already be taken — one by APP_TIME_ZONE, one by the host — so no ` +
        `candidate can differ from both and this chooser could only fail (CT-6, #2991). ` +
        `Move the fixture into the 10:00-10:59 UTC hour, or drop alsoDifferFromHostAt ` +
        `and rely on the environment rival alone.\n${describeEnvironment()}, host ` +
        `${JSON.stringify(hostZoneId)}.`,
    );
  }

  const reachable = [
    shiftUtcDay(instant, -1),
    shiftUtcDay(instant, 0),
    shiftUtcDay(instant, 1),
  ];
  if (!reachable.includes(environmentAnswer)) {
    throw new Error(
      `alsoDifferFromHostAt for ${subject} names ${instant.toISOString()}, but the ` +
        `environment zone answers ${JSON.stringify(environmentAnswer)}, which is not one ` +
        `of the three calendar days that instant can produce anywhere on earth ` +
        `(${reachable.join(", ")}). The derivation is therefore reading a DIFFERENT ` +
        `instant from the one this call claims, so the fixture-window check above proved ` +
        `nothing about it (CT-6, #2991). Pass the instant answerFor actually reads.`,
    );
  }
}

/** The UTC calendar day `offsetDays` either side of `instant`'s own. */
function shiftUtcDay(instant: Date, offsetDays: number): string {
  return new Date(instant.getTime() + offsetDays * UTC_DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function describeEnvironment(): string {
  return (
    `APP_TIME_ZONE is ${JSON.stringify(APP_TIME_ZONE)} (process.env.TZ = ` +
    `${JSON.stringify(process.env.TZ)}, host resolves ` +
    `${JSON.stringify(hostResolvedZone())})`
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
