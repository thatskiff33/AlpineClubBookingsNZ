/**
 * The civil-time facts a lodge booking depends on, pinned against a CONFIGURED
 * club zone in both hemispheres (CT-6, #2991; epic #2988).
 *
 * ## Why this file exists on top of the two that already test this kernel
 *
 * `club-day-boundaries.test.ts` proves the RESOLVER — three probes, the skipped
 * and ambiguous policies, the eleven zones the old two-pass trick got wrong.
 * `stay-window.test.ts` proves the noon-to-noon window for `Pacific/Auckland`.
 * Both are about the machinery. This file is about the CALENDAR the machinery
 * has to keep intact: that a stay across a spring-forward is still exactly the
 * same number of lodge nights even though it is an hour shorter in real time,
 * that a leap day is a night like any other, and that a year boundary is not a
 * place where a club day quietly becomes a UTC day.
 *
 * Three things here are genuinely not tested anywhere else, and each names a
 * defect that would otherwise ship green:
 *
 * 1. **Nothing proved its own premise.** Every DST case in this tree asserts an
 *    answer on a date somebody once looked up. When a tzdata update moves a
 *    transition — Beirut moved one in 2023, Chile has moved several — the case
 *    keeps asserting an instant that is no longer a transition at all, and it
 *    passes, because the kernel and the assertion drift together. Every block
 *    below MEASURES the offset either side of the transition it depends on,
 *    with an `Intl.DateTimeFormat` built here and pinned to an explicit zone,
 *    BEFORE it asserts anything that rests on it. A premise that stopped
 *    holding fails loudly; it never skips.
 * 2. **Northern-hemisphere DST was half-covered.** `America/Denver` appears in
 *    the existing suites only on days where nothing happens, so a bug that
 *    reversed the direction of the correction — subtracting the offset where it
 *    should add it — is invisible to a southern-only fixture set: NZDT starts
 *    in September and MDT in March, and a sign error swaps which of those is
 *    the short day. Denver's own spring gap (8 March 2026) and its own repeated
 *    hour (1 November 2026) are asserted here with hand-written instants.
 * 3. **"Noon is never skipped" was only half-asserted.** The existing case
 *    calls the rejecting default and checks the reading, which proves noon is
 *    not SKIPPED. It never asks whether noon is AMBIGUOUS, because an ambiguous
 *    reading does not throw — it silently picks the earlier of two instants.
 *    `INV-DATE-025` claims noon is neither, so the check that matters is that
 *    the `earliest` and `latest` policies return the SAME instant. They are
 *    compared here on every transition day in four zones, including two whose
 *    clocks move AT midnight and one whose offset is not a whole hour.
 *
 * ## How the expected values were obtained, and why that is not circular
 *
 * Every instant asserted below is a hand-written literal, derived on paper from
 * the zone's UTC offset on that side of the transition — noon on 8 March 2026 in
 * Denver is 12:00 at UTC-6, so 18:00Z, and it is written as `18:00:00.000Z`
 * rather than computed. Nothing here is a snapshot, and nothing here is compared
 * against the kernel function it is testing.
 *
 * The offsets themselves cannot be derived from first principles — a named
 * zone's transition table is IANA data and the runtime is the only thing that
 * holds it — so the premise blocks read it through a formatter this file builds,
 * with the zone passed explicitly. That shares the DATA with the kernel and
 * shares none of the ALGORITHM: the kernel resolves a wall time with three
 * probes, candidate read-back and a bisection, and none of that is exercised by
 * asking `Intl` for the parts of one known instant.
 *
 * ## Fixtures and the frozen clock
 *
 * Nothing here reads "now". Every date is an explicit literal, chosen relative
 * to the repository's frozen `2026-07-01T00:00:00.000Z` so it stays on the same
 * side of it for ever: 2026-03/04 are past, 2026-09/10/11/12 and 2028 are
 * future. 2028-02-29 is the next leap day after the freeze, and 2026 is not a
 * leap year, so the two cases can never converge.
 *
 * NO ZONE IS EVER READ FROM THE HOST. Every zone below is a value passed as an
 * argument, which is what makes these facts about the CLUB's civil time rather
 * than about the machine that happened to run the suite.
 */
import { describe, expect, it } from "vitest";

import {
  addCalendarDays,
  addCalendarMonths,
  calendarMonthOf,
  clubCalendarDateOf,
  clubWallTimeOf,
  countClubNights,
  daysInCalendarMonth,
  eachCalendarDate,
  endOfClubDayExclusive,
  instantForClubWallTime,
  noonOfClubDay,
  requireCalendarDate,
  requireClubTimeZone,
  SkippedClubWallTimeError,
  startOfCalendarMonth,
  startOfClubDay,
  stayWindow,
  type AmbiguousWallTimePolicy,
  type CalendarDate,
  type ClubTimeZone,
} from "@/lib/club-time";

const cd = requireCalendarDate;
const tz = requireClubTimeZone;

/** Southern hemisphere: NZDT +13, NZST +12. */
const AUCKLAND = tz("Pacific/Auckland");
/** Southern hemisphere, and NOT a whole-hour offset: +13:45 / +12:45. */
const CHATHAM = tz("Pacific/Chatham");
/** Northern hemisphere: MDT -6, MST -7. */
const DENVER = tz("America/Denver");
/** Southern hemisphere, and its clocks move AT local midnight. */
const SANTIAGO = tz("America/Santiago");
/** Northern hemisphere, and its clocks also move AT local midnight. */
const BEIRUT = tz("Asia/Beirut");

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The parts of an instant in a named zone, read through a formatter built HERE.
 *
 * This is the independent mechanism the whole file rests on. It shares the IANA
 * transition data with the kernel — there is no second source of that, and
 * pretending otherwise would be the fiction — but it shares none of the
 * kernel's algorithm: no probe list, no candidate read-back, no bisection, no
 * memoised factory. `hourCycle: "h23"` is what makes midnight read `00` rather
 * than `24`, which is the difference between a premise and an off-by-one-day.
 */
function zonedParts(
  instant: Date,
  zone: ClubTimeZone,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: String(zone),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const field = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new Error(
        `Intl reported no ${type} for ${instant.toISOString()} in ${String(zone)}; ` +
          "the probe this file's premises rest on is broken, not the kernel.",
      );
    }
    return Number(found.value);
  };
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

const pad = (value: number, width: number): string =>
  String(value).padStart(width, "0");

/** One instant's club reading as `YYYY-MM-DD HH:MM:SS`, independently derived. */
function zonedReading(instant: Date, zone: ClubTimeZone): string {
  const parts = zonedParts(instant, zone);
  return (
    `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)} ` +
    `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}`
  );
}

/**
 * A zone's UTC offset in MINUTES at an instant, positive east of Greenwich.
 *
 * Minutes rather than hours because `Pacific/Chatham` is 45 minutes off its
 * neighbour and `Australia/Lord_Howe` shifts by 30, so an hours-only premise
 * would round away exactly the zones that catch a whole-hour assumption.
 *
 * The instant is floored to the second first: `Intl` reports whole seconds, so
 * probing a value carrying a millisecond remainder returns an offset short by
 * that remainder — a wrong number rather than an error.
 */
function utcOffsetMinutes(instant: Date, zone: ClubTimeZone): number {
  const flooredMs = Math.floor(instant.getTime() / 1000) * 1000;
  const parts = zonedParts(new Date(flooredMs), zone);
  return (
    (Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) -
      flooredMs) /
    MINUTE_MS
  );
}

/**
 * THE PREMISE CHECK. A transition really happens at `atIso`, moving the offset
 * from `beforeMinutes` to `afterMinutes`.
 *
 * A case whose transition has moved must FAIL here rather than quietly go on to
 * assert an instant that no longer means anything.
 */
function expectTransition(
  zone: ClubTimeZone,
  atIso: string,
  beforeMinutes: number,
  afterMinutes: number,
): void {
  const at = new Date(atIso);
  expect(
    utcOffsetMinutes(new Date(at.getTime() - 1000), zone),
    `PREMISE: ${String(zone)} should be at ${beforeMinutes} minutes one second before ${atIso}`,
  ).toBe(beforeMinutes);
  expect(
    utcOffsetMinutes(at, zone),
    `PREMISE: ${String(zone)} should be at ${afterMinutes} minutes from ${atIso}`,
  ).toBe(afterMinutes);
}

/**
 * The weekday of a calendar day, from a UTC-pinned `Date` rather than from the
 * kernel's integer civil arithmetic — so "the last Sunday of September" is a
 * fact this file establishes rather than one it borrows from the code under
 * test. 0 is Sunday.
 */
function utcWeekday(date: CalendarDate): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** How many days later the same weekday leaves the month `date` belongs to. */
function isLastSuchWeekdayOfMonth(date: CalendarDate): boolean {
  const sevenDaysLater = new Date(
    new Date(`${date}T00:00:00.000Z`).getTime() + 7 * DAY_MS,
  );
  return sevenDaysLater.toISOString().slice(0, 7) !== date.slice(0, 7);
}

/** Which occurrence of its weekday `date` is within its month: 1 for the first. */
function weekdayOrdinalInMonth(date: CalendarDate): number {
  return Math.ceil(Number(date.slice(8, 10)) / 7);
}

const AMBIGUOUS_POLICIES: AmbiguousWallTimePolicy[] = ["earliest", "latest"];

/*
  ===========================================================================
  1. The premises. Nothing below this block is meaningful if these are wrong.
  ===========================================================================
*/
describe("the DST transitions every case in this file rests on", () => {
  it("Pacific/Auckland: NZDT ends the FIRST Sunday of April and begins the LAST Sunday of September", () => {
    // Fall back: 03:00 NZDT becomes 02:00 NZST on Sunday 5 April 2026.
    expectTransition(AUCKLAND, "2026-04-04T14:00:00.000Z", 13 * 60, 12 * 60);
    expect(zonedReading(new Date("2026-04-04T13:59:59.000Z"), AUCKLAND)).toBe(
      "2026-04-05 02:59:59",
    );
    expect(zonedReading(new Date("2026-04-04T14:00:00.000Z"), AUCKLAND)).toBe(
      "2026-04-05 02:00:00",
    );

    // Spring forward: 02:00 NZST becomes 03:00 NZDT on Sunday 27 September 2026.
    expectTransition(AUCKLAND, "2026-09-26T14:00:00.000Z", 12 * 60, 13 * 60);
    expect(zonedReading(new Date("2026-09-26T13:59:59.000Z"), AUCKLAND)).toBe(
      "2026-09-27 01:59:59",
    );
    expect(zonedReading(new Date("2026-09-26T14:00:00.000Z"), AUCKLAND)).toBe(
      "2026-09-27 03:00:00",
    );

    // And the New Zealand rule really is the one those dates come from.
    expect(utcWeekday(cd("2026-04-05")), "5 April 2026 is a Sunday").toBe(0);
    expect(weekdayOrdinalInMonth(cd("2026-04-05"))).toBe(1);
    expect(utcWeekday(cd("2026-09-27")), "27 September 2026 is a Sunday").toBe(0);
    expect(isLastSuchWeekdayOfMonth(cd("2026-09-27"))).toBe(true);
  });

  it("America/Denver: MDT begins the SECOND Sunday of March and ends the FIRST Sunday of November", () => {
    // Spring forward: 02:00 MST becomes 03:00 MDT on Sunday 8 March 2026.
    expectTransition(DENVER, "2026-03-08T09:00:00.000Z", -7 * 60, -6 * 60);
    expect(zonedReading(new Date("2026-03-08T08:59:59.000Z"), DENVER)).toBe(
      "2026-03-08 01:59:59",
    );
    expect(zonedReading(new Date("2026-03-08T09:00:00.000Z"), DENVER)).toBe(
      "2026-03-08 03:00:00",
    );

    // Fall back: 02:00 MDT becomes 01:00 MST on Sunday 1 November 2026.
    expectTransition(DENVER, "2026-11-01T08:00:00.000Z", -6 * 60, -7 * 60);
    expect(zonedReading(new Date("2026-11-01T07:59:59.000Z"), DENVER)).toBe(
      "2026-11-01 01:59:59",
    );
    expect(zonedReading(new Date("2026-11-01T08:00:00.000Z"), DENVER)).toBe(
      "2026-11-01 01:00:00",
    );

    expect(utcWeekday(cd("2026-03-08")), "8 March 2026 is a Sunday").toBe(0);
    expect(weekdayOrdinalInMonth(cd("2026-03-08"))).toBe(2);
    expect(utcWeekday(cd("2026-11-01")), "1 November 2026 is a Sunday").toBe(0);
    expect(weekdayOrdinalInMonth(cd("2026-11-01"))).toBe(1);

    /*
      THE ASYMMETRY THAT MAKES A SOUTHERN-ONLY FIXTURE SET UNSAFE. The two
      hemispheres put their short day in opposite halves of the year, so a sign
      error in the correction turns Auckland's 23-hour day into a 25-hour one
      and Denver's 23-hour day into a 25-hour one at the SAME TIME — and a suite
      that only knows about Auckland reads the second as a coincidence.
    */
    expect(utcOffsetMinutes(new Date("2026-07-01T00:00:00.000Z"), AUCKLAND)).toBe(
      12 * 60,
    );
    expect(utcOffsetMinutes(new Date("2026-07-01T00:00:00.000Z"), DENVER)).toBe(
      -6 * 60,
    );
  });

  it("America/Santiago and Asia/Beirut really do move their clocks AT local midnight", () => {
    /*
      This is the reachable form of the defect the kernel exists for: a resolver
      that lands on the wrong side of a midnight transition names the WRONG
      CALENDAR DAY, not merely the wrong hour. It is unreachable for a
      `Pacific/Auckland` club and reachable the moment CT-1 lets an operator
      pick any IANA zone, so it is asserted rather than assumed.

      Both are stated as MEASURED, because tzdata moves these two more than
      most: Chile has changed its rule repeatedly and Lebanon moved a transition
      at 48 hours' notice in 2023. What this runtime's ICU says today is what is
      pinned; if a data update moves either, this case fails first and names it.
    */
    // Santiago, autumn: 00:00 on 5 April 2026 winds back to 23:00 on the 4th.
    expectTransition(SANTIAGO, "2026-04-05T03:00:00.000Z", -3 * 60, -4 * 60);
    expect(zonedReading(new Date("2026-04-05T02:59:59.000Z"), SANTIAGO)).toBe(
      "2026-04-04 23:59:59",
    );
    expect(zonedReading(new Date("2026-04-05T03:00:00.000Z"), SANTIAGO)).toBe(
      "2026-04-04 23:00:00",
    );

    // Santiago, spring: 00:00 on 6 September 2026 becomes 01:00 — midnight is skipped.
    expectTransition(SANTIAGO, "2026-09-06T04:00:00.000Z", -4 * 60, -3 * 60);
    expect(zonedReading(new Date("2026-09-06T03:59:59.000Z"), SANTIAGO)).toBe(
      "2026-09-05 23:59:59",
    );
    expect(zonedReading(new Date("2026-09-06T04:00:00.000Z"), SANTIAGO)).toBe(
      "2026-09-06 01:00:00",
    );

    // Beirut, spring: 00:00 on 29 March 2026 becomes 01:00 — midnight is skipped.
    expectTransition(BEIRUT, "2026-03-28T22:00:00.000Z", 2 * 60, 3 * 60);
    expect(zonedReading(new Date("2026-03-28T21:59:59.000Z"), BEIRUT)).toBe(
      "2026-03-28 23:59:59",
    );
    expect(zonedReading(new Date("2026-03-28T22:00:00.000Z"), BEIRUT)).toBe(
      "2026-03-29 01:00:00",
    );

    // Beirut, autumn: 00:00 on 25 October 2026 winds back to 23:00 on the 24th.
    expectTransition(BEIRUT, "2026-10-24T21:00:00.000Z", 3 * 60, 2 * 60);
    expect(zonedReading(new Date("2026-10-24T20:59:59.000Z"), BEIRUT)).toBe(
      "2026-10-24 23:59:59",
    );
    expect(zonedReading(new Date("2026-10-24T21:00:00.000Z"), BEIRUT)).toBe(
      "2026-10-24 23:00:00",
    );
  });

  it("Pacific/Chatham's offset is not a whole number of hours", () => {
    // The premise for every "this does not assume whole-hour offsets" claim
    // below. +13:45 in NZDT, +12:45 in NZST.
    expect(utcOffsetMinutes(new Date("2026-01-01T00:00:00.000Z"), CHATHAM)).toBe(
      13 * 60 + 45,
    );
    expect(utcOffsetMinutes(new Date("2026-07-01T00:00:00.000Z"), CHATHAM)).toBe(
      12 * 60 + 45,
    );
  });
});

/*
  ===========================================================================
  2. Club midnight on a transition day: the day is 23 or 25 hours long, and
     the calendar does not notice.
  ===========================================================================
*/
describe("a club day that contains a DST transition", () => {
  /**
   * `[label, zone, day, startIso, endExclusiveIso, realHours]`.
   *
   * The two instants are hand-derived from the measured offsets: the start of
   * 5 April 2026 in Auckland is 00:00 at UTC+13, so 2026-04-04T11:00:00.000Z.
   * `realHours` is then a consequence of the two, written out so a mutation
   * that moves ONE of them cannot keep the row consistent.
   */
  const DAY_LENGTHS: Array<
    [string, ClubTimeZone, string, string, string, number]
  > = [
    [
      "Auckland, an ordinary day",
      AUCKLAND,
      "2026-07-01",
      "2026-06-30T12:00:00.000Z",
      "2026-07-01T12:00:00.000Z",
      24,
    ],
    [
      "Auckland, the day NZDT ends",
      AUCKLAND,
      "2026-04-05",
      "2026-04-04T11:00:00.000Z",
      "2026-04-05T12:00:00.000Z",
      25,
    ],
    [
      "Auckland, the day NZDT begins",
      AUCKLAND,
      "2026-09-27",
      "2026-09-26T12:00:00.000Z",
      "2026-09-27T11:00:00.000Z",
      23,
    ],
    [
      "Denver, an ordinary day",
      DENVER,
      "2026-07-01",
      "2026-07-01T06:00:00.000Z",
      "2026-07-02T06:00:00.000Z",
      24,
    ],
    [
      "Denver, the day MDT begins",
      DENVER,
      "2026-03-08",
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:00:00.000Z",
      23,
    ],
    [
      "Denver, the day MDT ends",
      DENVER,
      "2026-11-01",
      "2026-11-01T06:00:00.000Z",
      "2026-11-02T07:00:00.000Z",
      25,
    ],
    [
      "Santiago, the day BEFORE its midnight fall-back",
      SANTIAGO,
      "2026-04-04",
      "2026-04-04T03:00:00.000Z",
      "2026-04-05T04:00:00.000Z",
      25,
    ],
    [
      "Santiago, the day whose own midnight is SKIPPED",
      SANTIAGO,
      "2026-09-06",
      "2026-09-06T04:00:00.000Z",
      "2026-09-07T03:00:00.000Z",
      23,
    ],
    [
      "Beirut, the day whose own midnight is SKIPPED",
      BEIRUT,
      "2026-03-29",
      "2026-03-28T22:00:00.000Z",
      "2026-03-29T21:00:00.000Z",
      23,
    ],
    [
      "Beirut, the day BEFORE its midnight fall-back",
      BEIRUT,
      "2026-10-24",
      "2026-10-23T21:00:00.000Z",
      "2026-10-24T22:00:00.000Z",
      25,
    ],
  ];

  it.each(DAY_LENGTHS)(
    // Only the label is interpolated: `it.each` substitutes positionally, so a
    // second %s would print the zone rather than the hours.
    "%s: the day is 23, 24 or 25 hours long and still exactly one lodge night",
    (_label, zone, day, startIso, endExclusiveIso, realHours) => {
      const date = cd(day);
      const start = startOfClubDay(date, zone);
      const end = endOfClubDayExclusive(date, zone);

      expect(start.toISOString()).toBe(startIso);
      expect(end.toISOString()).toBe(endExclusiveIso);

      // THE HALF THAT IS REAL TIME: 23, 24 or 25 hours actually elapse.
      expect(
        (end.getTime() - start.getTime()) / HOUR_MS,
        `${String(zone)} ${day} elapsed hours`,
      ).toBe(realHours);

      // THE HALF THAT IS CALENDAR ARITHMETIC: unmoved, in every row.
      expect(countClubNights(date, addCalendarDays(date, 1))).toBe(1);
      expect(eachCalendarDate(date, addCalendarDays(date, 1))).toEqual([day]);

      // And the bound really is this day's own: the first instant reads as the
      // day, the millisecond before it does not, and the exclusive end does not.
      expect(clubCalendarDateOf(start, zone)).toBe(day);
      expect(clubCalendarDateOf(new Date(start.getTime() - 1), zone)).not.toBe(day);
      expect(clubCalendarDateOf(new Date(end.getTime() - 1), zone)).toBe(day);
      expect(clubCalendarDateOf(end, zone)).not.toBe(day);
    },
  );

  it("keeps the short and the long day one calendar night apart in both hemispheres", () => {
    /*
      The failure this catches: somebody "simplifies" a day span to
      `start + 86_400_000`. Every row above still starts in the right place, so
      only the 23/25-hour assertions catch it — and this case states the
      consequence in domain terms, that a 23-hour day and a 25-hour day are the
      same one night as an ordinary day.
    */
    for (const [zone, shortDay, longDay, earlier, later, nights] of [
      // Auckland's short day is in September and its long day in April;
      // Denver's are the other way round, which is the hemisphere asymmetry.
      [AUCKLAND, "2026-09-27", "2026-04-05", "2026-04-05", "2026-09-27", 175],
      [DENVER, "2026-03-08", "2026-11-01", "2026-03-08", "2026-11-01", 238],
    ] as Array<[ClubTimeZone, string, string, string, string, number]>) {
      const shortSpan =
        endOfClubDayExclusive(cd(shortDay), zone).getTime() -
        startOfClubDay(cd(shortDay), zone).getTime();
      const longSpan =
        endOfClubDayExclusive(cd(longDay), zone).getTime() -
        startOfClubDay(cd(longDay), zone).getTime();
      expect(longSpan - shortSpan, `${String(zone)} long minus short`).toBe(
        2 * HOUR_MS,
      );
      // And the calendar between them is untouched by either: hand-counted,
      // 5 April to 27 September 2026 is 175 days and 8 March to 1 November 238.
      expect(
        countClubNights(cd(earlier), cd(later)),
        `${String(zone)} ${earlier} -> ${later}`,
      ).toBe(nights);
    }
  });
});

/*
  ===========================================================================
  3. Midnight that does not exist, and midnight that happens twice.
  ===========================================================================
*/
describe("a club wall time inside the spring-forward gap", () => {
  it("is refused by default in the northern hemisphere too, carrying its parts", () => {
    // PREMISE: 02:00-02:59:59.999 on 8 March 2026 never happens in Denver.
    expectTransition(DENVER, "2026-03-08T09:00:00.000Z", -7 * 60, -6 * 60);

    let thrown: unknown = null;
    try {
      instantForClubWallTime(cd("2026-03-08"), { hour: 2, minute: 30 }, DENVER);
    } catch (error) {
      thrown = error;
    }
    expect(
      thrown,
      "02:30 on 2026-03-08 does not exist in America/Denver, so the default policy must throw",
    ).toBeInstanceOf(SkippedClubWallTimeError);
    const skipped = thrown as SkippedClubWallTimeError;
    expect(skipped.date).toBe("2026-03-08");
    expect(skipped.hour).toBe(2);
    expect(skipped.minute).toBe(30);
    expect(skipped.timeZone).toBe("America/Denver");
  });

  it("resolves to the moment the clock jumped, not the request slid forward", () => {
    const moved = instantForClubWallTime(
      cd("2026-03-08"),
      { hour: 2, minute: 30 },
      DENVER,
      { skipped: "nextExistingInstant" },
    );
    // The transition instant, hand-derived: 02:00 MST on 8 March is 09:00Z.
    expect(moved.toISOString()).toBe("2026-03-08T09:00:00.000Z");
    expect(zonedReading(moved, DENVER)).toBe("2026-03-08 03:00:00");
    // The `Temporal`-style "compatible" answer, named so this cannot pass by
    // agreeing with the rule the kernel deliberately does not use.
    expect(moved.toISOString()).not.toBe("2026-03-08T09:30:00.000Z");
  });

  it("still answers for the LAST reading in the gap, to the millisecond", () => {
    /*
      02:59:59.999 is the last club reading Auckland's spring-forward removes.
      The kernel's candidate check compares to the SECOND, and the transition
      search bisects on a second-resolution key, so a reading carrying a
      millisecond remainder is where a search written without flooring
      converges minutes away from the real boundary. The existing suite probes
      whole minutes only.
    */
    expectTransition(AUCKLAND, "2026-09-26T14:00:00.000Z", 12 * 60, 13 * 60);
    const lastSkipped = instantForClubWallTime(
      cd("2026-09-27"),
      { hour: 2, minute: 59, second: 59, millisecond: 999 },
      AUCKLAND,
      { skipped: "nextExistingInstant" },
    );
    expect(lastSkipped.toISOString()).toBe("2026-09-26T14:00:00.000Z");
    expect(zonedReading(lastSkipped, AUCKLAND)).toBe("2026-09-27 03:00:00");
    // The slid-forward answer would keep the remainder and land here.
    expect(lastSkipped.toISOString()).not.toBe("2026-09-26T14:59:59.999Z");
  });

  it("takes midnight itself away in the two zones that transition there", () => {
    /*
      THE CASE THE WHOLE KERNEL EXISTS FOR, stated at its sharpest: on these two
      days the club's own midnight is a reading that never happens, so the
      default policy refuses it and `startOfClubDay` — which asks for the next
      instant that does exist — answers the transition itself.
    */
    for (const [zone, day, transitionIso, reading] of [
      [SANTIAGO, "2026-09-06", "2026-09-06T04:00:00.000Z", "2026-09-06 01:00:00"],
      [BEIRUT, "2026-03-29", "2026-03-28T22:00:00.000Z", "2026-03-29 01:00:00"],
    ] as Array<[ClubTimeZone, string, string, string]>) {
      expect(
        () => instantForClubWallTime(cd(day), { hour: 0 }, zone),
        `${String(zone)} ${day}: midnight does not exist, so the default policy must refuse it`,
      ).toThrow(SkippedClubWallTimeError);
      const start = startOfClubDay(cd(day), zone);
      expect(start.toISOString(), `${String(zone)} ${day}`).toBe(transitionIso);
      expect(zonedReading(start, zone)).toBe(reading);
      // NOON on the very same day needs no policy at all — see INV-DATE-025.
      expect(() =>
        instantForClubWallTime(cd(day), { hour: 12 }, zone),
      ).not.toThrow();
    }
  });
});

describe("a club wall time that happens twice", () => {
  it("offers both occurrences in the northern hemisphere, earliest by default", () => {
    // PREMISE: 01:00-01:59:59.999 on 1 November 2026 happens twice in Denver.
    expectTransition(DENVER, "2026-11-01T08:00:00.000Z", -6 * 60, -7 * 60);

    const earliest = instantForClubWallTime(
      cd("2026-11-01"),
      { hour: 1, minute: 30 },
      DENVER,
      { ambiguous: "earliest" },
    );
    const latest = instantForClubWallTime(
      cd("2026-11-01"),
      { hour: 1, minute: 30 },
      DENVER,
      { ambiguous: "latest" },
    );
    // Hand-derived: 01:30 at UTC-6 is 07:30Z; 01:30 at UTC-7 is 08:30Z.
    expect(earliest.toISOString()).toBe("2026-11-01T07:30:00.000Z");
    expect(latest.toISOString()).toBe("2026-11-01T08:30:00.000Z");
    expect(latest.getTime() - earliest.getTime()).toBe(HOUR_MS);
    // Both really are 01:30 on 1 November in the club's zone.
    expect(zonedReading(earliest, DENVER)).toBe("2026-11-01 01:30:00");
    expect(zonedReading(latest, DENVER)).toBe("2026-11-01 01:30:00");
    // The documented default is `earliest`, so no policy must equal that one.
    expect(
      instantForClubWallTime(
        cd("2026-11-01"),
        { hour: 1, minute: 30 },
        DENVER,
      ).toISOString(),
      "INV-DATE-025: the ambiguous default is the FIRST occurrence",
    ).toBe("2026-11-01T07:30:00.000Z");
  });

  it("offers both occurrences of the FIRST repeated reading in the south", () => {
    // 02:00:00.000 exactly is the first Auckland reading the fall-back repeats;
    // the existing suite probes 02:30, half an hour in.
    expectTransition(AUCKLAND, "2026-04-04T14:00:00.000Z", 13 * 60, 12 * 60);
    const earliest = instantForClubWallTime(
      cd("2026-04-05"),
      { hour: 2 },
      AUCKLAND,
      { ambiguous: "earliest" },
    );
    const latest = instantForClubWallTime(
      cd("2026-04-05"),
      { hour: 2 },
      AUCKLAND,
      { ambiguous: "latest" },
    );
    expect(earliest.toISOString()).toBe("2026-04-04T13:00:00.000Z");
    expect(latest.toISOString()).toBe("2026-04-04T14:00:00.000Z");
    expect(zonedReading(earliest, AUCKLAND)).toBe("2026-04-05 02:00:00");
    expect(zonedReading(latest, AUCKLAND)).toBe("2026-04-05 02:00:00");
  });

  it("repeats the hour BEFORE midnight where the transition is at midnight", () => {
    /*
      Beirut winds 00:00 on 25 October back to 23:00 on the 24th, so the hour
      that happens twice belongs to the PREVIOUS calendar day and midnight
      itself happens exactly once. A resolver that assumed an ambiguity always
      sits on the day it was asked about would put both occurrences on the 25th.
    */
    expectTransition(BEIRUT, "2026-10-24T21:00:00.000Z", 3 * 60, 2 * 60);
    const earliest = instantForClubWallTime(
      cd("2026-10-24"),
      { hour: 23, minute: 30 },
      BEIRUT,
      { ambiguous: "earliest" },
    );
    const latest = instantForClubWallTime(
      cd("2026-10-24"),
      { hour: 23, minute: 30 },
      BEIRUT,
      { ambiguous: "latest" },
    );
    expect(earliest.toISOString()).toBe("2026-10-24T20:30:00.000Z");
    expect(latest.toISOString()).toBe("2026-10-24T21:30:00.000Z");
    expect(latest.getTime() - earliest.getTime()).toBe(HOUR_MS);

    // Midnight on the 25th, by contrast, has exactly ONE answer.
    const midnight = startOfClubDay(cd("2026-10-25"), BEIRUT);
    expect(midnight.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(
      instantForClubWallTime(cd("2026-10-25"), { hour: 0 }, BEIRUT, {
        ambiguous: "latest",
      }).toISOString(),
      "midnight on 2026-10-25 in Asia/Beirut is not ambiguous",
    ).toBe("2026-10-24T22:00:00.000Z");
  });
});

/*
  ===========================================================================
  4. INV-DATE-025: noon exists exactly once, on every transition day.
  ===========================================================================
*/
describe("noon is neither skipped nor ambiguous (INV-DATE-025)", () => {
  /**
   * Every transition day of 2026 in five configured club zones — both
   * hemispheres, two zones whose clocks move at midnight, and one whose offset
   * is not a whole hour.
   */
  const TRANSITION_DAYS: Array<[ClubTimeZone, string]> = [
    [AUCKLAND, "2026-04-04"],
    [AUCKLAND, "2026-04-05"],
    [AUCKLAND, "2026-09-26"],
    [AUCKLAND, "2026-09-27"],
    [CHATHAM, "2026-04-05"],
    [CHATHAM, "2026-09-27"],
    [DENVER, "2026-03-07"],
    [DENVER, "2026-03-08"],
    [DENVER, "2026-10-31"],
    [DENVER, "2026-11-01"],
    [SANTIAGO, "2026-04-04"],
    [SANTIAGO, "2026-04-05"],
    [SANTIAGO, "2026-09-05"],
    [SANTIAGO, "2026-09-06"],
    [BEIRUT, "2026-03-28"],
    [BEIRUT, "2026-03-29"],
    [BEIRUT, "2026-10-24"],
    [BEIRUT, "2026-10-25"],
  ];

  it("resolves to exactly ONE instant, whichever policy is asked for", () => {
    /*
      THE HALF THE EXISTING SUITE DOES NOT ASSERT. Calling the rejecting default
      and checking the reading proves noon is not SKIPPED, and proves nothing
      about ambiguity: an ambiguous reading does not throw, it silently returns
      the earlier of two instants. So the discriminating check is that
      `earliest` and `latest` come back identical — that there is one candidate
      rather than two.
    */
    for (const [zone, day] of TRANSITION_DAYS) {
      const resolved = AMBIGUOUS_POLICIES.map((ambiguous) =>
        instantForClubWallTime(cd(day), { hour: 12 }, zone, {
          ambiguous,
        }).toISOString(),
      );
      expect(
        new Set(resolved).size,
        `INV-DATE-025: noon on ${day} in ${String(zone)} resolved to ${resolved.join(" and ")}`,
      ).toBe(1);
      // And it is not skipped either: the default policy rejects, so reaching
      // here at all is the assertion, and the reading confirms which reading.
      expect(zonedReading(noonOfClubDay(cd(day), zone), zone)).toBe(
        `${day} 12:00:00`,
      );
    }
  });

  it("gives the hand-derived instant on the four midnight-transition days", () => {
    /*
      Spot literals on top of the property above, so a mutation that made every
      zone answer the same wrong-but-consistent instant still fails. Each is
      12:00 at the offset in force on that side of the transition.
    */
    const NOONS: Array<[ClubTimeZone, string, string]> = [
      [SANTIAGO, "2026-04-05", "2026-04-05T16:00:00.000Z"], // 12:00 at UTC-4
      [SANTIAGO, "2026-09-06", "2026-09-06T15:00:00.000Z"], // 12:00 at UTC-3
      [BEIRUT, "2026-03-29", "2026-03-29T09:00:00.000Z"], // 12:00 at UTC+3
      [BEIRUT, "2026-10-25", "2026-10-25T10:00:00.000Z"], // 12:00 at UTC+2
    ];
    for (const [zone, day, iso] of NOONS) {
      expect(noonOfClubDay(cd(day), zone).toISOString(), `${String(zone)} ${day}`).toBe(
        iso,
      );
      expect(clubWallTimeOf(noonOfClubDay(cd(day), zone), zone)).toMatchObject({
        date: day,
        hour: 12,
        minute: 0,
        second: 0,
        millisecond: 0,
      });
    }
  });

  it("is 45 minutes off its neighbour in Pacific/Chatham, on the transition day", () => {
    // A whole-hour assumption anywhere in the resolver would round this away.
    expect(noonOfClubDay(cd("2026-04-05"), CHATHAM).toISOString()).toBe(
      "2026-04-04T23:15:00.000Z", // 12:00 at UTC+12:45
    );
    expect(noonOfClubDay(cd("2026-09-27"), CHATHAM).toISOString()).toBe(
      "2026-09-26T22:15:00.000Z", // 12:00 at UTC+13:45
    );
    expect(
      noonOfClubDay(cd("2026-04-05"), AUCKLAND).getTime() -
        noonOfClubDay(cd("2026-04-05"), CHATHAM).getTime(),
    ).toBe(45 * MINUTE_MS);
  });
});

/*
  ===========================================================================
  5. The stay window: calendar nights and elapsed time DISAGREE, on purpose.
  ===========================================================================
*/
describe("a stay whose noon-to-noon window crosses a transition, a leap day or a year end", () => {
  /**
   * `[label, zone, checkIn, checkOut, arrivalIso, departureIso, elapsedHours,
   * nights, elapsedDaysFloored]`.
   *
   * `nights` and `elapsedDaysFloored` are both hand-written, and the rows where
   * they differ are the whole point: an implementation that derived nights from
   * elapsed time would report 0 nights for a 23-hour stay and 3 for a 4-night
   * one. Rounding rather than flooring hides the first two but not the third.
   */
  const STAYS: Array<
    [string, ClubTimeZone, string, string, string, string, number, number, number]
  > = [
    [
      "Denver, no transition (the control)",
      DENVER,
      "2026-02-10",
      "2026-02-13",
      "2026-02-10T19:00:00.000Z",
      "2026-02-13T19:00:00.000Z",
      72,
      3,
      3,
    ],
    [
      "Denver, one night over the spring-forward",
      DENVER,
      "2026-03-07",
      "2026-03-08",
      "2026-03-07T19:00:00.000Z",
      "2026-03-08T18:00:00.000Z",
      23,
      1,
      0,
    ],
    [
      "Denver, one night over the fall-back",
      DENVER,
      "2026-10-31",
      "2026-11-01",
      "2026-10-31T18:00:00.000Z",
      "2026-11-01T19:00:00.000Z",
      25,
      1,
      1,
    ],
    [
      "Denver, four nights containing the spring-forward",
      DENVER,
      "2026-03-06",
      "2026-03-10",
      "2026-03-06T19:00:00.000Z",
      "2026-03-10T18:00:00.000Z",
      95,
      4,
      3,
    ],
    [
      "Auckland, four nights containing the spring-forward",
      AUCKLAND,
      "2026-09-25",
      "2026-09-29",
      "2026-09-25T00:00:00.000Z",
      "2026-09-28T23:00:00.000Z",
      95,
      4,
      3,
    ],
    [
      "Auckland, five nights containing the fall-back",
      AUCKLAND,
      "2026-04-02",
      "2026-04-07",
      "2026-04-01T23:00:00.000Z",
      "2026-04-07T00:00:00.000Z",
      121,
      5,
      5,
    ],
    [
      "Beirut, one night over a transition AT midnight",
      BEIRUT,
      "2026-03-28",
      "2026-03-29",
      "2026-03-28T10:00:00.000Z",
      "2026-03-29T09:00:00.000Z",
      23,
      1,
      0,
    ],
    [
      "Santiago, one night over a transition AT midnight",
      SANTIAGO,
      "2026-04-04",
      "2026-04-05",
      "2026-04-04T15:00:00.000Z",
      "2026-04-05T16:00:00.000Z",
      25,
      1,
      1,
    ],
    [
      "Auckland, two nights over the leap day",
      AUCKLAND,
      "2028-02-28",
      "2028-03-01",
      "2028-02-27T23:00:00.000Z",
      "2028-02-29T23:00:00.000Z",
      48,
      2,
      2,
    ],
    [
      "Auckland, three nights over the year end",
      AUCKLAND,
      "2026-12-30",
      "2027-01-02",
      "2026-12-29T23:00:00.000Z",
      "2027-01-01T23:00:00.000Z",
      72,
      3,
      3,
    ],
    [
      "Denver, one night over the year end",
      DENVER,
      "2026-12-31",
      "2027-01-01",
      "2026-12-31T19:00:00.000Z",
      "2027-01-01T19:00:00.000Z",
      24,
      1,
      1,
    ],
  ];

  it.each(STAYS)(
    "%s: the calendar night count and the elapsed time disagree",
    (
      _label,
      zone,
      checkIn,
      checkOut,
      arrivalIso,
      departureIso,
      elapsedHours,
      nights,
      elapsedDaysFloored,
    ) => {
      const window = stayWindow(cd(checkIn), cd(checkOut), zone);

      // BOTH HALVES, in the same case, because the point is that they disagree.
      expect(window.nights, `${checkIn} -> ${checkOut} lodge nights`).toBe(nights);
      const elapsedMs = window.departure.getTime() - window.arrival.getTime();
      expect(elapsedMs, `${checkIn} -> ${checkOut} elapsed ms`).toBe(
        elapsedHours * HOUR_MS,
      );
      expect(Math.floor(elapsedMs / DAY_MS)).toBe(elapsedDaysFloored);

      // The endpoints themselves, hand-derived from the offset in force.
      expect(window.arrival.toISOString()).toBe(arrivalIso);
      expect(window.departure.toISOString()).toBe(departureIso);
      expect(zonedReading(window.arrival, zone)).toBe(`${checkIn} 12:00:00`);
      expect(zonedReading(window.departure, zone)).toBe(`${checkOut} 12:00:00`);

      // And the date-only identities are handed straight back, untouched.
      expect(window.checkIn).toBe(checkIn);
      expect(window.checkOut).toBe(checkOut);
    },
  );

  it("names the occupied nights as calendar days, one per night", () => {
    /*
      The list, not the count — because a count can be right while the days are
      wrong. Each is written out by hand, and each range contains a day that a
      24-hour arithmetic would drop or duplicate: a spring-forward, a
      fall-back, a leap day and a year end.
    */
    expect(eachCalendarDate(cd("2026-09-25"), cd("2026-09-29"))).toEqual([
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
    ]);
    expect(eachCalendarDate(cd("2026-03-06"), cd("2026-03-10"))).toEqual([
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
    expect(eachCalendarDate(cd("2028-02-28"), cd("2028-03-01"))).toEqual([
      "2028-02-28",
      "2028-02-29",
    ]);
    expect(eachCalendarDate(cd("2026-12-30"), cd("2027-01-02"))).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
  });

  it("would price a 23-hour stay as zero nights if elapsed time decided it", () => {
    /*
      The consequence in domain terms. `INV-DATE-008` refuses a zero-night
      booking outright, so an elapsed-time night count does not merely mis-price
      the northern spring-forward stay — it makes it unbookable.
    */
    const window = stayWindow(cd("2026-03-07"), cd("2026-03-08"), DENVER);
    const elapsedNights =
      (window.departure.getTime() - window.arrival.getTime()) / DAY_MS;
    expect(Math.floor(elapsedNights)).toBe(0);
    expect(elapsedNights).toBeLessThan(1);
    expect(window.nights).toBe(1);
  });
});

/*
  ===========================================================================
  6. Leap day.
  ===========================================================================
*/
describe("29 February", () => {
  it("exists in 2028 and not in 2026, 2027 or 2100", () => {
    // The premise for every leap case below, and the century rule with it.
    expect(daysInCalendarMonth(2028, 2)).toBe(29);
    expect(daysInCalendarMonth(2026, 2)).toBe(28);
    expect(daysInCalendarMonth(2027, 2)).toBe(28);
    expect(daysInCalendarMonth(2000, 2)).toBe(29);
    expect(daysInCalendarMonth(2100, 2), "2100 is divisible by 100, not 400").toBe(
      28,
    );
    // Not a leap-year property, but the neighbours a month-length bug moves.
    expect(daysInCalendarMonth(2026, 1)).toBe(31);
    expect(daysInCalendarMonth(2026, 4)).toBe(30);
    expect(daysInCalendarMonth(2026, 12)).toBe(31);
  });

  it("cannot be minted as a calendar date in a year that has no such day", () => {
    /*
      A SECOND, INDEPENDENT LEAP RULE, and the reason to check it here. The day
      arithmetic in this module is Hinnant's era formula, which derives leap
      years from the 400-year cycle and never consults `daysInCalendarMonth` —
      so a broken month-length rule leaves night counts perfectly correct and
      only shows up where a date is VALIDATED. `parseCalendarDate` never rolls,
      so the failure mode is a refusal rather than a silent 1 March.
    */
    expect(() => cd("2028-02-29")).not.toThrow();
    expect(() => cd("2026-02-29"), "2026 has no 29 February").toThrow(
      /Not a club calendar date/,
    );
    expect(() => cd("2100-02-29"), "2100 has no 29 February").toThrow(
      /Not a club calendar date/,
    );
    expect(() => cd("2000-02-29"), "2000 does have one").not.toThrow();
    // The neighbouring month ends, which the same rule decides.
    expect(() => cd("2026-04-31")).toThrow(/Not a club calendar date/);
    expect(() => cd("2026-12-31")).not.toThrow();
  });

  it("is a day you can step onto and over", () => {
    expect(addCalendarDays(cd("2028-02-28"), 1)).toBe("2028-02-29");
    expect(addCalendarDays(cd("2028-02-28"), 2)).toBe("2028-03-01");
    expect(addCalendarDays(cd("2028-03-01"), -1)).toBe("2028-02-29");
    // The same two steps in a year that has no 29 February.
    expect(addCalendarDays(cd("2026-02-28"), 1)).toBe("2026-03-01");
    expect(addCalendarDays(cd("2026-03-01"), -1)).toBe("2026-02-28");
  });

  it("is the 366th day a leap year has and the 365th a common year does not", () => {
    expect(countClubNights(cd("2028-01-01"), cd("2029-01-01"))).toBe(366);
    expect(countClubNights(cd("2026-01-01"), cd("2027-01-01"))).toBe(365);
    expect(countClubNights(cd("2100-01-01"), cd("2101-01-01"))).toBe(365);
    expect(countClubNights(cd("2028-02-01"), cd("2028-03-01"))).toBe(29);
    expect(countClubNights(cd("2026-02-01"), cd("2026-03-01"))).toBe(28);
  });

  it("is what a month step CLAMPS to, rather than overflowing into March", () => {
    /*
      The defect: `new Date(2028, 0, 31)` plus a month rolls to 2 March, and the
      booking a member made for the last day of the month silently moves.
      Clamping is the documented behaviour, and 29/30/31 January all land on the
      same day in a leap year — which is also why the operation is not
      reversible, asserted below so nobody "fixes" that later.
    */
    expect(addCalendarMonths(cd("2028-01-29"), 1)).toBe("2028-02-29");
    expect(addCalendarMonths(cd("2028-01-30"), 1)).toBe("2028-02-29");
    expect(addCalendarMonths(cd("2028-01-31"), 1)).toBe("2028-02-29");
    // The same three in a common year clamp one day further.
    expect(addCalendarMonths(cd("2026-01-29"), 1)).toBe("2026-02-28");
    expect(addCalendarMonths(cd("2026-01-30"), 1)).toBe("2026-02-28");
    expect(addCalendarMonths(cd("2026-01-31"), 1)).toBe("2026-02-28");
    // A year either side of 29 February clamps too.
    expect(addCalendarMonths(cd("2028-02-29"), 12)).toBe("2029-02-28");
    expect(addCalendarMonths(cd("2028-02-29"), -12)).toBe("2027-02-28");
    expect(addCalendarMonths(cd("2028-02-29"), 1)).toBe("2028-03-29");
    // Clamping is one-way, on purpose.
    expect(addCalendarMonths(addCalendarMonths(cd("2028-01-31"), 1), -1)).toBe(
      "2028-01-29",
    );
  });

  it("is an ordinary 24-hour club day in a zone with no transition near it", () => {
    // PREMISE: Auckland is on NZDT (+13) either side of 29 February 2028.
    expect(utcOffsetMinutes(new Date("2028-02-28T00:00:00.000Z"), AUCKLAND)).toBe(
      13 * 60,
    );
    expect(utcOffsetMinutes(new Date("2028-03-01T00:00:00.000Z"), AUCKLAND)).toBe(
      13 * 60,
    );
    const start = startOfClubDay(cd("2028-02-29"), AUCKLAND);
    const end = endOfClubDayExclusive(cd("2028-02-29"), AUCKLAND);
    expect(start.toISOString()).toBe("2028-02-28T11:00:00.000Z");
    expect(end.toISOString()).toBe("2028-02-29T11:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(24 * HOUR_MS);
    expect(clubCalendarDateOf(start, AUCKLAND)).toBe("2028-02-29");
  });
});

/*
  ===========================================================================
  7. Month end and year end.
  ===========================================================================
*/
describe("the end of a month and the end of a year", () => {
  it("steps a day from 31 December into the next year and back", () => {
    expect(addCalendarDays(cd("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addCalendarDays(cd("2027-01-01"), -1)).toBe("2026-12-31");
    expect(countClubNights(cd("2026-12-31"), cd("2027-01-01"))).toBe(1);
    // The month ends that a 30/31 mix-up moves.
    expect(addCalendarDays(cd("2026-11-30"), 1)).toBe("2026-12-01");
    expect(addCalendarDays(cd("2026-10-31"), 1)).toBe("2026-11-01");
    expect(addCalendarDays(cd("2026-04-30"), 1)).toBe("2026-05-01");
  });

  it("clamps a month step from a 31-day month to its target's length", () => {
    expect(addCalendarMonths(cd("2026-12-31"), 1)).toBe("2027-01-31");
    expect(addCalendarMonths(cd("2026-12-31"), 2)).toBe("2027-02-28");
    expect(addCalendarMonths(cd("2026-12-31"), 13)).toBe("2028-01-31");
    expect(addCalendarMonths(cd("2026-12-31"), 14)).toBe("2028-02-29");
    expect(addCalendarMonths(cd("2026-10-31"), 1)).toBe("2026-11-30");
    expect(addCalendarMonths(cd("2026-01-31"), 11)).toBe("2026-12-31");
    // Backwards over the year boundary, and over a clamp.
    expect(addCalendarMonths(cd("2027-01-31"), -1)).toBe("2026-12-31");
    expect(addCalendarMonths(cd("2027-01-31"), -2)).toBe("2026-11-30");
  });

  it("finds the first of the month without a Date in the middle", () => {
    /*
      The spelling this replaces is `new Date(y, m, 1)`, which is host-local
      midnight — so on any host west of Greenwich "the first of this month" is
      the PREVIOUS month's last day, and a month grid built on it shifts by a
      whole column with nothing to notice.
    */
    expect(startOfCalendarMonth(cd("2026-12-31"))).toBe("2026-12-01");
    expect(startOfCalendarMonth(cd("2026-12-01"))).toBe("2026-12-01");
    expect(startOfCalendarMonth(cd("2028-02-29"))).toBe("2028-02-01");
    expect(startOfCalendarMonth(cd("2027-01-01"))).toBe("2027-01-01");
    expect(calendarMonthOf(cd("2026-12-31"))).toBe("2026-12");
    expect(calendarMonthOf(cd("2027-01-01"))).toBe("2027-01");
  });

  it("puts the year boundary where the CLUB is, not where UTC is", () => {
    /*
      `INV-DATE-019`'s defect at its most expensive moment: a finance period.
      Truncating an instant's ISO string gives the UTC day, and at a year end
      that does not merely name the wrong day — it books the night into the
      wrong FINANCIAL YEAR, in both directions depending on which side of
      Greenwich the club sits.
    */
    // PREMISE: the offsets that make each of these a year-crossing instant.
    expect(utcOffsetMinutes(new Date("2026-12-31T11:30:00.000Z"), AUCKLAND)).toBe(
      13 * 60,
    );
    expect(utcOffsetMinutes(new Date("2027-01-01T05:00:00.000Z"), DENVER)).toBe(
      -7 * 60,
    );

    // East of Greenwich: UTC still says 2026, the club is already in 2027.
    const aucklandNewYear = new Date("2026-12-31T11:30:00.000Z");
    expect(aucklandNewYear.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(clubCalendarDateOf(aucklandNewYear, AUCKLAND)).toBe("2027-01-01");
    expect(calendarMonthOf(clubCalendarDateOf(aucklandNewYear, AUCKLAND))).toBe(
      "2027-01",
    );

    // West of Greenwich: UTC has rolled into 2027, the club has not.
    const denverNewYearEve = new Date("2027-01-01T05:00:00.000Z");
    expect(denverNewYearEve.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(clubCalendarDateOf(denverNewYearEve, DENVER)).toBe("2026-12-31");
    expect(calendarMonthOf(clubCalendarDateOf(denverNewYearEve, DENVER))).toBe(
      "2026-12",
    );
  });

  it("partitions the year boundary with no gap and no overlap", () => {
    for (const [zone, lastDayStart, newYearStart] of [
      [AUCKLAND, "2026-12-30T11:00:00.000Z", "2026-12-31T11:00:00.000Z"],
      [DENVER, "2026-12-31T07:00:00.000Z", "2027-01-01T07:00:00.000Z"],
    ] as Array<[ClubTimeZone, string, string]>) {
      expect(
        startOfClubDay(cd("2026-12-31"), zone).toISOString(),
        `${String(zone)} 31 December`,
      ).toBe(lastDayStart);
      expect(
        startOfClubDay(cd("2027-01-01"), zone).toISOString(),
        `${String(zone)} 1 January`,
      ).toBe(newYearStart);
      expect(
        endOfClubDayExclusive(cd("2026-12-31"), zone).getTime(),
        `${String(zone)}: the last day of 2026 ends exactly where 2027 begins`,
      ).toBe(startOfClubDay(cd("2027-01-01"), zone).getTime());
      // The last millisecond of the year still belongs to the old year.
      const lastMs = new Date(
        endOfClubDayExclusive(cd("2026-12-31"), zone).getTime() - 1,
      );
      expect(clubCalendarDateOf(lastMs, zone)).toBe("2026-12-31");
      expect(clubWallTimeOf(lastMs, zone)).toMatchObject({
        date: "2026-12-31",
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 999,
      });
    }
  });
});
