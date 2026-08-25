/**
 * Instants, their projection into club time, and the clock seam (CT-2, #2990).
 */
import { describe, expect, it, vi } from "vitest";

import { addCalendarDays, requireCalendarDate } from "../calendar-date";
import { clubToday, fixedClubClock, systemClubClock } from "../clock";
import {
  calendarDateOfDateOnlyInstant,
  calendarDateOfSerialisedDbDate,
  calendarDateOfSerialisedDbDateOrNull,
  clubCalendarDateOf,
  clubWallTimeOf,
  clubZoneOffsetMs,
  dateOnlyInstantOf,
  isInstant,
  parseInstant,
  requireInstant,
} from "../instant";
import { requireClubTimeZone } from "../zone";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "@/lib/__tests__/helpers/clock";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

const cd = requireCalendarDate;
const AUCKLAND = requireClubTimeZone("Pacific/Auckland");
const CHATHAM = requireClubTimeZone("Pacific/Chatham");
const DENVER = requireClubTimeZone("America/Denver");
const LOS_ANGELES = requireClubTimeZone("America/Los_Angeles");

describe("parsing an instant", () => {
  it("accepts a value that really pins a moment", () => {
    expect(parseInstant("2026-04-16T02:30:00Z")?.toISOString()).toBe(
      "2026-04-16T02:30:00.000Z",
    );
    expect(parseInstant("2026-04-16T14:30:00+12:00")?.toISOString()).toBe(
      "2026-04-16T02:30:00.000Z",
    );
    expect(parseInstant("2026-04-16T14:30:00+1200")?.toISOString()).toBe(
      "2026-04-16T02:30:00.000Z",
    );
    expect(parseInstant(0)?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(parseInstant(new Date("2026-04-16T02:30:00Z"))?.toISOString()).toBe(
      "2026-04-16T02:30:00.000Z",
    );
  });

  it("REFUSES an ISO string with no offset, in every host zone", () => {
    /*
      `"2026-04-16T00:00:00"` names a wall-clock reading, not a moment, and
      JavaScript resolves it in whichever zone happens to be reading it. That is
      the provider-boundary hazard the epic asks every integration to classify,
      and the kernel refuses to guess rather than producing a different answer on
      a developer's laptop and on a UTC container.
    */
    for (const hostZone of ["UTC", "America/Los_Angeles"]) {
      withTimeZone(hostZone, () => {
        expect(parseInstant("2026-04-16T00:00:00"), hostZone).toBeNull();
        expect(parseInstant("2026-04-16"), hostZone).toBeNull();
        expect(parseInstant("16 April 2026"), hostZone).toBeNull();
      });
    }
    expect(() => requireInstant("2026-04-16T00:00:00")).toThrow(
      /must carry Z or a UTC offset/,
    );
  });

  it("REFUSES an impossible date instead of rolling it forward", () => {
    /*
      `new Date("2026-02-30T00:00:00Z")` is 2 MARCH: JavaScript's ISO parser
      normalises a day-of-month that does not exist rather than refusing it. This
      is the provider boundary, so a partner system's off-by-one or typo would
      have become a real, plausible, wrong moment two days later with nothing to
      notice — and `parseCalendarDate` refuses exactly that shape in capitals two
      modules away. The two parsers now agree about what a date is.
    */
    expect(parseInstant("2026-02-30T00:00:00Z")).toBeNull();
    expect(parseInstant("2026-02-29T00:00:00Z")).toBeNull(); // 2026 is not a leap year
    expect(parseInstant("2026-04-31T12:00:00+12:00")).toBeNull();
    expect(parseInstant("2026-00-10T00:00:00Z")).toBeNull();
    expect(() => requireInstant("2026-02-30T00:00:00Z")).toThrow(/2026-02-30/);
    // The days either side of the refusal still parse, so it is not a blanket ban.
    expect(parseInstant("2026-02-28T00:00:00Z")?.toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(parseInstant("2028-02-29T00:00:00Z")?.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("refuses a value that is not a moment at all", () => {
    expect(parseInstant(new Date(NaN))).toBeNull();
    expect(parseInstant(Number.NaN)).toBeNull();
    expect(parseInstant(Number.POSITIVE_INFINITY)).toBeNull();
    expect(isInstant(new Date(NaN))).toBe(false);
    expect(isInstant("2026-04-16T02:30:00Z")).toBe(false);
  });
});

describe("projecting an instant into club time", () => {
  it("reads the club's calendar day, not the UTC one, near midnight", () => {
    // 11:30Z on 15 April is 23:30 the same day in Auckland; 12:30Z is 00:30 on
    // the SIXTEENTH. Both are 15 April in UTC.
    expect(
      clubCalendarDateOf(new Date("2026-04-15T11:30:00Z"), AUCKLAND),
    ).toBe("2026-04-15");
    expect(
      clubCalendarDateOf(new Date("2026-04-15T12:30:00Z"), AUCKLAND),
    ).toBe("2026-04-16");
    // And a club behind UTC reads the PREVIOUS day at an instant UTC calls
    // tomorrow.
    expect(clubCalendarDateOf(new Date("2026-04-16T02:30:00Z"), DENVER)).toBe(
      "2026-04-15",
    );
  });

  it("reports the whole wall-clock reading, milliseconds included", () => {
    expect(
      clubWallTimeOf(new Date("2026-04-16T02:30:45.123Z"), AUCKLAND),
    ).toEqual({
      date: "2026-04-16",
      hour: 14,
      minute: 30,
      second: 45,
      millisecond: 123,
    });
  });

  it("reports a sub-hour offset correctly", () => {
    // Chatham is +12:45 in NZST and +13:45 in NZDT.
    expect(clubZoneOffsetMs(new Date("2026-07-01T00:00:00Z"), CHATHAM)).toBe(
      12 * 3_600_000 + 45 * 60_000,
    );
    expect(clubZoneOffsetMs(new Date("2026-01-01T00:00:00Z"), CHATHAM)).toBe(
      13 * 3_600_000 + 45 * 60_000,
    );
  });

  it("reports the SAME offset for an instant carrying milliseconds", () => {
    /*
      `Intl` reports whole seconds. An offset probe that subtracts the raw
      instant rather than a second-aligned one comes back short by the
      millisecond remainder — a silently wrong number that breaks every search
      built on it, and one that only shows up on an instant whose milliseconds
      are non-zero.
    */
    const whole = clubZoneOffsetMs(new Date("2026-07-01T00:00:00.000Z"), AUCKLAND);
    for (const ms of [1, 123, 500, 999]) {
      expect(
        clubZoneOffsetMs(new Date(`2026-07-01T00:00:00.${String(ms).padStart(3, "0")}Z`), AUCKLAND),
        `${ms} ms`,
      ).toBe(whole);
    }
  });
});

describe("the calendar day a SERIALISED @db.Date carries", () => {
  it("reads both shapes a serialised date column arrives in", () => {
    // The JSON form Prisma produces, and the bare day a client sends back.
    expect(calendarDateOfSerialisedDbDate("2026-07-01T00:00:00.000Z")).toBe(
      "2026-07-01",
    );
    expect(calendarDateOfSerialisedDbDate("2026-07-01")).toBe("2026-07-01");
    expect(calendarDateOfSerialisedDbDate("2026-07-01T00:00:00Z")).toBe(
      "2026-07-01",
    );
  });

  it("agrees with the Date-taking inverse on every day of a year", () => {
    /*
      The two spellings this replaces, compared against each other over a full
      year including both New Zealand transitions. `calendarDateOfDateOnlyInstant`
      is the independent oracle: it goes through a `Date` and reads `getUTC*`,
      where this reads the string prefix, so agreement is evidence rather than a
      tautology.
    */
    let date = cd("2026-01-01");
    for (let step = 0; step < 400; step += 1) {
      const serialised = `${date}T00:00:00.000Z`;
      expect(calendarDateOfSerialisedDbDate(serialised), serialised).toBe(
        calendarDateOfDateOnlyInstant(new Date(serialised)),
      );
      expect(calendarDateOfSerialisedDbDate(date), date).toBe(date);
      date = addCalendarDays(date, 1);
    }
  });

  it("refuses a value whose day does not exist, and never rolls it", () => {
    // The same no-rolling rule the calendar parser holds: `2026-02-30` is a
    // refusal, not 2 March. A typo must not become a plausible wrong night.
    expect(() => calendarDateOfSerialisedDbDate("2026-02-30T00:00:00.000Z")).toThrow(
      /Not a club calendar date/,
    );
    expect(() => calendarDateOfSerialisedDbDate("2026-13-01")).toThrow();
    expect(() => calendarDateOfSerialisedDbDate("not-a-date")).toThrow();
    expect(() => calendarDateOfSerialisedDbDate("2026-7-1")).toThrow();
    expect(() => calendarDateOfSerialisedDbDate("")).toThrow();
  });

  it("cannot be moved by the host machine's timezone", () => {
    /*
      The property that matters: this decode consults no clock and no zone, so a
      behind-UTC host reads the same day. The premise — that the two host zones
      really differ — is asserted first, because a vacuous host-zone pair is how a
      guard in this repository stayed green while its defect was restored.
    */
    expect(
      withTimeZone("America/Los_Angeles", () =>
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBe("America/Los_Angeles");

    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () => [
        calendarDateOfSerialisedDbDate("2026-07-01T00:00:00.000Z"),
        calendarDateOfSerialisedDbDate("2026-01-01T00:00:00.000Z"),
        calendarDateOfSerialisedDbDateOrNull("2026-12-31T00:00:00.000Z"),
      ]);
    expect(answersIn("UTC")).toEqual(answersIn("America/Los_Angeles"));
    expect(answersIn("UTC")).toEqual(["2026-07-01", "2026-01-01", "2026-12-31"]);
  });

  it("answers null rather than throwing, for the client-render case", () => {
    /*
      A throw out of a client render blanks the screen; two public token landing
      pages carried a local `try`/`catch` for exactly that. The null-safe form
      also absorbs the absent case, so a nullable column needs no guard.
    */
    expect(calendarDateOfSerialisedDbDateOrNull(null)).toBeNull();
    expect(calendarDateOfSerialisedDbDateOrNull(undefined)).toBeNull();
    expect(calendarDateOfSerialisedDbDateOrNull("")).toBeNull();
    expect(calendarDateOfSerialisedDbDateOrNull("2026-02-30")).toBeNull();
    expect(calendarDateOfSerialisedDbDateOrNull("garbage")).toBeNull();
    expect(calendarDateOfSerialisedDbDateOrNull("2026-07-01T00:00:00.000Z")).toBe(
      "2026-07-01",
    );
  });

  it("agrees with the throwing form wherever the throwing form answers", () => {
    // Two functions that could drift into disagreeing about what a day is. The
    // ONLY difference between them is the failure mode.
    for (const value of [
      "2026-07-01",
      "2026-07-01T00:00:00.000Z",
      "0001-01-01T00:00:00.000Z",
      "9999-12-31",
    ]) {
      expect(calendarDateOfSerialisedDbDateOrNull(value), value).toBe(
        calendarDateOfSerialisedDbDate(value),
      );
    }
  });

  it("reads a stored day, not an instant, and says so by example", () => {
    /*
      THE ONE INPUT ON WHICH THE TWO OLD SPELLINGS DISAGREE, pinned so the
      docblock's claim is checkable. An offset-bearing string is not a `@db.Date`
      serialisation, and reparsing one would project it into UTC — 30 June for a
      value whose own day is 1 July. Reading the prefix cannot be moved that way.
    */
    const offsetBearing = "2026-07-01T12:00:00+13:00";
    expect(calendarDateOfSerialisedDbDate(offsetBearing)).toBe("2026-07-01");
    expect(
      calendarDateOfDateOnlyInstant(new Date(offsetBearing)),
      "the reparsing spelling projects into UTC and lands a day earlier",
    ).toBe("2026-06-30");
  });
});

describe("the Prisma @db.Date encoding", () => {
  it("round-trips a calendar day through UTC midnight", () => {
    const encoded = dateOnlyInstantOf(cd("2026-04-16"));
    expect(encoded.toISOString()).toBe("2026-04-16T00:00:00.000Z");
    expect(calendarDateOfDateOnlyInstant(encoded)).toBe("2026-04-16");
  });

  it("decodes in UTC, not in club time (INV-DATE-019, INV-DATE-026)", () => {
    /*
      The column stores an ENCODING, not a moment (INV-DATE-010), and the encoding
      is defined in UTC. Reading it in a club's zone is the defect from the other
      direction: for America/Denver, `2026-04-05T00:00:00Z` is 4 April.

      The decode itself is INV-DATE-019's first exact boundary with INV-DATE-026 —
      cite those and not INV-DATE-010, which this case's name used to (#3080).
    */
    const encoded = dateOnlyInstantOf(cd("2026-04-05"));
    expect(calendarDateOfDateOnlyInstant(encoded)).toBe("2026-04-05");
    expect(clubCalendarDateOf(encoded, DENVER)).toBe("2026-04-04");
  });

  it("is LOUD about a value the calendar-date range cannot hold", () => {
    /*
      `utcDateOnlyString` used to read the year through `Intl`, which describes
      the proleptic year 0 as "1" unless it is also asked for an era — so
      `calendarDateOfDateOnlyInstant(dateOnlyInstantOf("0000-05-01"))` came back
      as "0001-05-01", one year out and silent. It reads `getUTCFullYear()` now,
      so a `@db.Date` holding something outside the range fails where it is
      decoded rather than one year later in a report.
    */
    const yearZero = new Date("0000-05-01T00:00:00.000Z");
    expect(yearZero.getUTCFullYear()).toBe(0);
    expect(() => calendarDateOfDateOnlyInstant(yearZero)).toThrow(
      /Not a club calendar date/,
    );
    expect(calendarDateOfDateOnlyInstant(new Date("0001-05-01T00:00:00.000Z"))).toBe(
      "0001-05-01",
    );
    /*
      The zone-projecting half has the same exposure from the other direction:
      `Intl` reports proleptic year 0 as "1" and year -1 as "2" unless it is also
      asked for an era, so a pre-common-era instant projected into a named zone
      would come back as a plausible CE day. It is refused rather than described.
    */
    for (const zone of [AUCKLAND, DENVER]) {
      expect(() => clubCalendarDateOf(yearZero, zone)).toThrow(RangeError);
      expect(() => clubWallTimeOf(yearZero, zone)).toThrow(RangeError);
      expect(clubCalendarDateOf(new Date("0001-05-01T12:00:00.000Z"), zone)).toMatch(
        /^0001-0[45]-\d{2}$/,
      );
    }
  });

  it("round-trips every day of a leap year", () => {
    let date = cd("2028-01-01");
    for (let step = 0; step < 366; step += 1) {
      expect(calendarDateOfDateOnlyInstant(dateOnlyInstantOf(date))).toBe(date);
      const next = new Date(`${date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      date = cd(next.toISOString().slice(0, 10));
    }
  });
});

describe("the day-only projection agrees with the full wall-clock one", () => {
  /*
    `clubCalendarDateOf` takes its own three-field `Intl` shape rather than
    building the hour, minute and second that `clubWallTimeOf` needs and throwing
    them away — measured at 6.34 us against 3.34 us for the `date-only.ts` helper
    it replaces, 1.90x, at 45 non-test call sites in the capacity, pricing and
    finance loops; the narrower path is 3.35 us. Two projections of the same fact
    can drift, so they are pinned together here, including across a transition
    and at the far side of the world from the host.
  */
  it("gives the same day as clubWallTimeOf on every day of a DST year", () => {
    for (const zone of [AUCKLAND, DENVER, CHATHAM]) {
      for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 6 * 3_600_000) {
        const instant = new Date(ms);
        expect(
          clubCalendarDateOf(instant, zone),
          `${zone} ${instant.toISOString()}`,
        ).toBe(clubWallTimeOf(instant, zone).date);
      }
    }
  });

  it("is unaffected by the host machine's timezone", () => {
    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () => [
        clubCalendarDateOf(new Date("2026-04-15T11:30:00Z"), AUCKLAND),
        clubCalendarDateOf(new Date("2026-04-15T12:30:00Z"), AUCKLAND),
        clubCalendarDateOf(new Date("2026-04-16T02:30:00Z"), DENVER),
      ]);
    expect(answersIn("UTC")).toEqual(answersIn("America/Los_Angeles"));
    expect(answersIn("UTC")).toEqual(["2026-04-15", "2026-04-16", "2026-04-15"]);
  });
});

describe("the clock seam", () => {
  it("is deterministic under the repository's frozen clock", () => {
    expect(new Date().toISOString()).toBe(FROZEN_TEST_CLOCK_BASE_ISO);
    expect(clubToday(AUCKLAND)).toBe("2026-07-01");
    expect(clubToday(CHATHAM)).toBe("2026-07-01");
  });

  it("gives a club BEHIND UTC the previous day at that same instant", () => {
    /*
      The frozen instant is midday in New Zealand, chosen so UTC and NZ agree on
      the date. It does not make a behind-UTC club agree, and that is what stops
      "the club's day is not the UTC day" from being a tautology.
    */
    expect(clubToday(DENVER)).toBe("2026-06-30");
    expect(clubToday(LOS_ANGELES)).toBe("2026-06-30");
  });

  it("reads whatever clock it is given", () => {
    const clock = fixedClubClock(new Date("2026-12-31T11:30:00Z"));
    expect(clubToday(AUCKLAND, clock)).toBe("2027-01-01");
    expect(clubToday(DENVER, clock)).toBe("2026-12-31");
  });

  it("uses the host clock only through systemClubClock", () => {
    vi.setSystemTime(new Date("2026-03-08T04:30:00Z"));
    try {
      expect(systemClubClock.nowInstant().toISOString()).toBe(
        "2026-03-08T04:30:00.000Z",
      );
      expect(clubToday(AUCKLAND)).toBe("2026-03-08");
    } finally {
      vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
    }
  });

  it("is unaffected by the host machine's timezone", () => {
    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () => [
        clubToday(AUCKLAND),
        clubToday(DENVER),
        clubToday(CHATHAM),
      ]);
    expect(answersIn("UTC")).toEqual(answersIn("America/Los_Angeles"));
    expect(answersIn("UTC")).toEqual(["2026-07-01", "2026-06-30", "2026-07-01"]);
  });
});
