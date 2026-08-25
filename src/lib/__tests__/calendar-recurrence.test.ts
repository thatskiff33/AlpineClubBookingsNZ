import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_TIME_ZONE } from "@/config/operational";
import {
  addCalendarDays,
  calendarDateParts,
  calendarDayOfWeek,
  clubCalendarDateOf,
  clubWallTimeOf,
  clubZoneOffsetMs,
  requireCalendarDate,
  requireClubTimeZone,
  requireInstant,
  type CalendarDate,
  type ClubTimeZone,
  type Instant,
} from "@/lib/club-time";
import {
  describeRecurrence,
  generateOccurrenceStarts,
  recurrenceOptionsForDate,
  weekdayOrdinalInMonth,
  type RecurrenceRule,
} from "@/lib/calendar-recurrence";
import { divergentClubZone } from "./helpers/club-time-zone";
import { captureHostTimeZone } from "./helpers/timezone";

/**
 * The zone for the blocks below whose subject is a ZONE-INDEPENDENT rule —
 * day-of-month clamping, the missing-5th-weekday skip, and the exact wording of
 * a label. Those need A zone, not a divergent one, and pinning the house default
 * keeps their fixtures readable. Every block whose subject is zone AUTHORITY uses
 * `divergentClubZone` instead, and CT-1's validator refuses `"UTC"`, so that is
 * not an option here.
 *
 * Fixture instants in those blocks are written at `T00:00:00.000Z`, which is
 * midday-to-early-afternoon in New Zealand, so the club calendar day is the day
 * the string names.
 */
const RULE_ZONE = requireClubTimeZone("Pacific/Auckland");

/**
 * CT-4 group F5 (#2870). Every anchor here is a real INSTANT written as an
 * offset-bearing ISO string, and every expectation is read back through the
 * CLUB's zone. That is the whole change: the generator used to step host-local
 * `Date` components, so the calendar a series walked was the container's (on the
 * server) or the viewer's (in the "Repeat" picker).
 *
 * The suite is deliberately built so that two wrong implementations FAIL it:
 * one that formats through `APP_TIME_ZONE` (the environment's claim) and one
 * that reads the host's own `Date` getters. `divergentClubZone` picks a club zone
 * that diverges from both, so a projection assertion cannot pass by accident;
 * the DST block below pins its zone instead, because "this zone's clocks change
 * on this date" is not something a zone-agnostic chooser can know.
 */

/** Club day-of-month and weekday, the two things every label is derived from. */
function dayAndWeekday(date: CalendarDate): { day: number; weekday: number } {
  return {
    day: calendarDateParts(date).day,
    weekday: calendarDayOfWeek(date),
  };
}

describe("calendarDayOfWeek / weekdayOrdinalInMonth", () => {
  it("reads a calendar date's weekday identically on every host", () => {
    // 21 Jul 2026 is a Tuesday. A calendar day has no zone, so this is the same
    // answer in every process, which is what makes it safe as the grid's and the
    // nth-weekday rule's only weekday source.
    expect(calendarDayOfWeek(requireCalendarDate("2026-07-21"))).toBe(2);
    expect(calendarDayOfWeek(requireCalendarDate("2026-07-19"))).toBe(0);
    expect(calendarDayOfWeek(requireCalendarDate("2026-07-25"))).toBe(6);
  });

  it("counts the weekday's ordinal within its month", () => {
    expect(weekdayOrdinalInMonth(requireCalendarDate("2026-07-07"))).toBe(1);
    expect(weekdayOrdinalInMonth(requireCalendarDate("2026-07-21"))).toBe(3);
    expect(weekdayOrdinalInMonth(requireCalendarDate("2026-07-29"))).toBe(5);
  });
});

describe("generateOccurrenceStarts — the club's calendar, not the host's", () => {
  /*
    An anchor whose CLUB calendar day differs from the day both wrong
    implementations would read. The 10:30 UTC hour is what makes that possible at
    all: three calendar days exist on earth at once only while the UTC hour is
    10, so at any other hour `APP_TIME_ZONE`'s day and the host's can be the only
    two there are. `divergentClubZone`'s docblock carries the measurement.
  */
  const anchor = requireInstant("2026-07-21T10:30:00.000Z");
  let zone: ClubTimeZone;
  let anchorDate: CalendarDate;

  beforeEach(() => {
    const chosen = divergentClubZone((z) => clubCalendarDateOf(anchor, z));
    zone = chosen.zone;
    anchorDate = chosen.expected;
  });

  it("returns the anchor instant itself as the first occurrence", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      { frequency: "WEEKLY", interval: 1, endMode: "count", count: 3 },
      zone,
    );
    expect(starts[0].toISOString()).toBe(anchor.toISOString());
  });

  it("steps weekly on the CLUB calendar day the anchor falls on", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      { frequency: "WEEKLY", interval: 1, endMode: "count", count: 4 },
      zone,
    );
    expect(starts).toHaveLength(4);
    expect(starts.map((s) => clubCalendarDateOf(s, zone))).toEqual([
      anchorDate,
      addCalendarDays(anchorDate, 7),
      addCalendarDays(anchorDate, 14),
      addCalendarDays(anchorDate, 21),
    ]);
  });

  it("repeats monthly on the CLUB day-of-month, not the host's", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      { frequency: "MONTHLY_DAY_OF_MONTH", interval: 1, endMode: "count", count: 3 },
      zone,
    );
    const expectedDay = calendarDateParts(anchorDate).day;
    for (const start of starts) {
      expect(calendarDateParts(clubCalendarDateOf(start, zone)).day).toBe(
        expectedDay,
      );
    }
    // …and really is three consecutive months of the club's calendar.
    expect(
      starts.map((s) => clubCalendarDateOf(s, zone).slice(0, 7)),
    ).toEqual([
      anchorDate.slice(0, 7),
      addCalendarDays(anchorDate, 31).slice(0, 7),
      addCalendarDays(anchorDate, 62).slice(0, 7),
    ]);
  });

  it("repeats on the CLUB's nth weekday", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      {
        frequency: "MONTHLY_NTH_WEEKDAY",
        interval: 1,
        endMode: "count",
        count: 6,
      },
      zone,
    );
    expect(starts).toHaveLength(6);
    const expected = {
      weekday: calendarDayOfWeek(anchorDate),
      nth: weekdayOrdinalInMonth(anchorDate),
    };
    for (const start of starts) {
      const day = clubCalendarDateOf(start, zone);
      expect({
        weekday: calendarDayOfWeek(day),
        nth: weekdayOrdinalInMonth(day),
      }).toEqual(expected);
    }
  });

  it("keeps the anchor's CLUB wall-clock time on every occurrence", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      { frequency: "WEEKLY", interval: 1, endMode: "count", count: 4 },
      zone,
    );
    const anchorWall = clubWallTimeOf(anchor, zone);
    for (const start of starts) {
      const wall = clubWallTimeOf(start, zone);
      expect({ hour: wall.hour, minute: wall.minute }).toEqual({
        hour: anchorWall.hour,
        minute: anchorWall.minute,
      });
    }
  });

  it("stops on the club day the inclusive `until` names", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      {
        frequency: "WEEKLY",
        interval: 1,
        endMode: "until",
        // Three weeks after the anchor, at the same time of day — the fourth
        // occurrence's own club day, so it is included and the fifth is not.
        until: requireInstant("2026-08-11T10:30:00.000Z").toISOString(),
      },
      zone,
    );
    const lastAllowed = clubCalendarDateOf(
      requireInstant("2026-08-11T10:30:00.000Z"),
      zone,
    );
    expect(starts.length).toBeGreaterThan(0);
    for (const start of starts) {
      expect(
        clubCalendarDateOf(start, zone) <= lastAllowed,
        `${start.toISOString()} is past the until day ${lastAllowed}`,
      ).toBe(true);
    }
    // The very next weekly step really is past the bound, so the assertion above
    // is not vacuously satisfied by a series that stopped early.
    expect(
      addCalendarDays(clubCalendarDateOf(starts[starts.length - 1], zone), 7) >
        lastAllowed,
    ).toBe(true);
  });

  it("honours an interval of 2 (fortnightly)", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      { frequency: "WEEKLY", interval: 2, endMode: "count", count: 3 },
      zone,
    );
    expect(starts.map((s) => clubCalendarDateOf(s, zone))).toEqual([
      anchorDate,
      addCalendarDays(anchorDate, 14),
      addCalendarDays(anchorDate, 28),
    ]);
  });

  it("caps an open-ended daily rule at the safety ceiling", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      { frequency: "DAILY", interval: 1, endMode: "never" },
      zone,
    );
    expect(starts.length).toBeLessThanOrEqual(366);
    expect(starts.length).toBeGreaterThan(0);
  });

  it("stops rather than minting a day outside the calendar range", () => {
    // Not reachable from a request — the route's schema caps `interval` at 52 —
    // but this function is exported, and the host-local version it replaces
    // pushed Invalid Dates into the rows instead of stopping.
    const starts = generateOccurrenceStarts(
      anchor,
      {
        frequency: "MONTHLY_DAY_OF_MONTH",
        interval: 100_000,
        endMode: "count",
        count: 10,
      },
      zone,
    );
    expect(starts).toHaveLength(1);
    expect(starts[0].toISOString()).toBe(anchor.toISOString());
  });
});

describe("generateOccurrenceStarts — day-of-month clamping", () => {
  it("clamps the 31st into shorter months instead of rolling over", () => {
    const zone = RULE_ZONE;
    const starts = generateOccurrenceStarts(
      requireInstant("2027-01-31T00:00:00.000Z"),
      { frequency: "MONTHLY_DAY_OF_MONTH", interval: 1, endMode: "count", count: 3 },
      zone,
    );
    expect(starts.map((s) => clubCalendarDateOf(s, zone))).toEqual([
      "2027-01-31",
      "2027-02-28", // Feb clamps to 28
      "2027-03-31",
    ]);
  });

  it("skips a month with no 5th weekday rather than sliding into the next", () => {
    const zone = RULE_ZONE;
    // 31 Jul 2026 is the 5th Friday of July.
    const starts = generateOccurrenceStarts(
      requireInstant("2026-07-31T00:00:00.000Z"),
      {
        frequency: "MONTHLY_NTH_WEEKDAY",
        interval: 1,
        endMode: "count",
        count: 3,
      },
      zone,
    );
    for (const start of starts) {
      const day = clubCalendarDateOf(start, zone);
      expect(calendarDayOfWeek(day)).toBe(5);
      expect(weekdayOrdinalInMonth(day)).toBe(5);
    }
    // August 2026 has only four Fridays; the series jumps it.
    expect(starts.map((s) => clubCalendarDateOf(s, zone))).not.toContain(
      expect.stringContaining("2026-08"),
    );
  });
});

/**
 * The DST leg, and the one block that pins its club zone rather than choosing
 * one.
 *
 * The property under test is "a 7pm series stays a 7pm series across the CLUB
 * zone's own clock change", which needs a zone whose transition dates are known —
 * so `America/Denver` is named, and the premise that makes the assertion
 * meaningful is asserted rather than assumed: the club zone must not be the
 * environment's claim (which would let an `APP_TIME_ZONE` implementation pass),
 * and the HOST's offset must be constant across the window (otherwise a
 * host-local implementation would shift in step with the club and also pass).
 *
 * A premise failure here is a FAILURE, never a skip (owner decision, #2870).
 */
describe("generateOccurrenceStarts — DST in the club's zone", () => {
  const CLUB_ZONE = "America/Denver";
  // 1 Nov 2026 is the US fall-back Sunday; Denver goes UTC-6 -> UTC-7 at 02:00.
  const anchor = requireInstant("2026-10-21T01:00:00.000Z"); // 20 Oct, 19:00 Denver
  const zone = requireClubTimeZone(CLUB_ZONE);

  beforeEach(() => {
    expect(
      APP_TIME_ZONE,
      `This block proves the CLUB's zone drives the series, so the club zone must not be the one APP_TIME_ZONE already claims. APP_TIME_ZONE is ${APP_TIME_ZONE} — set TZ to something other than ${CLUB_ZONE} (or unset it). See docs/TESTING.md rule 6.`,
    ).not.toBe(CLUB_ZONE);
    const hostBefore = anchor.getTimezoneOffset();
    const hostAfter = new Date(
      anchor.getTime() + 21 * 24 * 60 * 60 * 1000,
    ).getTimezoneOffset();
    expect(
      hostBefore,
      `This block proves the series follows the CLUB zone's clock change and not the host's, so the HOST's offset has to stay put across the window. This process's offset moves from ${hostBefore} to ${hostAfter} minutes, which would let a host-local implementation pass. Run with TZ unset, or with a zone that has no transition between ${anchor.toISOString()} and three weeks later.`,
    ).toBe(hostAfter);
  });

  it("keeps 19:00 club time on every occurrence across the transition", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      { frequency: "WEEKLY", interval: 1, endMode: "count", count: 4 },
      zone,
    );
    expect(starts).toHaveLength(4);
    for (const start of starts) {
      const wall = clubWallTimeOf(start, zone);
      expect(
        { date: wall.date, hour: wall.hour, minute: wall.minute },
        `${start.toISOString()} is not 19:00 club time`,
      ).toEqual({ date: wall.date, hour: 19, minute: 0 });
    }
  });

  it("really did cross the transition, so the assertion above is not vacuous", () => {
    const starts = generateOccurrenceStarts(
      anchor,
      { frequency: "WEEKLY", interval: 1, endMode: "count", count: 4 },
      zone,
    );
    const offsets = new Set(
      starts.map((start) => clubZoneOffsetMs(start, zone)),
    );
    expect(
      offsets.size,
      "The four-week window must contain the club zone's clock change, or nothing here is being tested. Check that 1 Nov 2026 is still the US fall-back date in this runtime's tz data.",
    ).toBe(2);
    // A fixed-24-hour stepper would have kept one offset and moved the wall
    // clock; this one moves the offset and keeps the wall clock.
    const spans = starts
      .slice(1)
      .map((start, i) => start.getTime() - starts[i].getTime());
    expect(new Set(spans).size).toBe(2);
  });
});

/**
 * The `LONG_WEEKDAY` pin, and why it needs its own block.
 *
 * A calendar-date formatter is built at MODULE LOAD, pinned to `"UTC"` because
 * that is an identity over the UTC-midnight encoding rather than a projection.
 * Nothing in a normal run can tell that pin from `APP_TIME_ZONE`: this repository
 * resolves `Pacific/Auckland` for `APP_TIME_ZONE`, and reading a UTC-midnight
 * encoding anywhere east of Greenwich gives back the same day. Owner decision 3
 * on #2870 recorded that class as uncatchable by running the suite once.
 *
 * A review lens then measured the consequence precisely: swapping this file's
 * pin to `APP_TIME_ZONE` killed 0 of 124, while the identical swap in
 * `calendar-client.ts` killed 1 — because that file had the re-imported-graph
 * block below and this one did not. `LONG_WEEKDAY` is also the bare long-weekday
 * shape reported as MISSING from `HOUSE_SHAPES`, so it is the newest formatter in
 * the subsystem and was the only one with nothing guarding it.
 *
 * `vi.resetModules()` plus a dynamic import re-evaluates `@/config/operational`,
 * so `APP_TIME_ZONE` really becomes a behind-UTC zone for that copy of the
 * module. A `"UTC"` pin is unmoved by that; an `APP_TIME_ZONE` pin renders the
 * day BEFORE the one it was handed, which turns Tuesday into Monday.
 *
 * This is not the whole of CT-6's hostile-zone proof (#2991) — it covers this
 * module's one shape — but it is the shape that proof will take.
 */
describe("the weekday labels do not follow the ENVIRONMENT's zone", () => {
  const hostTimeZone = captureHostTimeZone();

  afterEach(() => {
    hostTimeZone.restore();
    vi.resetModules();
  });

  async function labelsUnderEnvironmentZone(environmentZone: string): Promise<{
    appTimeZone: string;
    weekly: string | undefined;
    described: string;
  }> {
    process.env.TZ = environmentZone;
    vi.resetModules();
    const operational = await import("@/config/operational");
    const recurrence = await import("@/lib/calendar-recurrence");
    const kernel = await import("@/lib/club-time");
    // 21 Jul 2026 is a Tuesday. Both entry points read the same formatter, so
    // both are checked — the picker a manager chooses from, and the summary
    // rendered beside a stored series.
    const date = kernel.requireCalendarDate("2026-07-21");
    return {
      appTimeZone: operational.APP_TIME_ZONE,
      weekly: recurrence
        .recurrenceOptionsForDate(date)
        .find((o) => o.value === "WEEKLY")?.label,
      described: recurrence.describeRecurrence(
        { frequency: "MONTHLY_NTH_WEEKDAY", interval: 1, endMode: "never" },
        kernel.requireInstant("2026-07-21T00:00:00.000Z"),
        kernel.requireClubTimeZone("Pacific/Auckland"),
      ),
    };
  }

  it("names Tuesday for a club whose environment zone is behind UTC", async () => {
    const behind = await labelsUnderEnvironmentZone("America/Denver");
    // The premise: the re-import really moved the environment's zone. Without
    // this the assertions below would be proving nothing.
    expect(
      behind.appTimeZone,
      "the re-imported module graph did not pick up the pinned TZ, so this assertion proves nothing",
    ).toBe("America/Denver");
    expect(behind.weekly).toBe("Weekly on Tuesday");
    expect(behind.described).toBe("Monthly on the 3rd Tuesday");
  });

  it("names Tuesday for an environment zone far ahead of UTC too", async () => {
    const ahead = await labelsUnderEnvironmentZone("Pacific/Kiritimati");
    expect(ahead.appTimeZone).toBe("Pacific/Kiritimati");
    expect(ahead.weekly).toBe("Weekly on Tuesday");
    expect(ahead.described).toBe("Monthly on the 3rd Tuesday");
  });
});

describe("recurrenceOptionsForDate", () => {
  it("labels a calendar day from that day, with no zone at all", () => {
    // 21 Jul 2026 is the 3rd Tuesday. A calendar day is a Tuesday everywhere on
    // earth, so this needs — and takes — no zone.
    const opts = recurrenceOptionsForDate(requireCalendarDate("2026-07-21"));
    expect(opts[0].value).toBe("NONE");
    expect(opts.find((o) => o.value === "WEEKLY")?.label).toBe(
      "Weekly on Tuesday",
    );
    expect(opts.find((o) => o.value === "MONTHLY_DAY_OF_MONTH")?.label).toBe(
      "Monthly on day 21",
    );
    expect(opts.find((o) => o.value === "MONTHLY_NTH_WEEKDAY")?.label).toBe(
      "Monthly on the 3rd Tuesday",
    );
  });

  it("cannot contradict itself, because both halves come from one day", () => {
    // The defect this shape removes: a weekday read in one frame beside a day
    // number read in another produced "Monthly on day 16 … the 3rd Tuesday"
    // where the 16th was a Wednesday.
    for (const day of ["2026-07-01", "2026-07-15", "2026-12-31"]) {
      const date = requireCalendarDate(day);
      const opts = recurrenceOptionsForDate(date);
      const { day: dayNumber, weekday } = dayAndWeekday(date);
      const weekdayName = opts
        .find((o) => o.value === "WEEKLY")!
        .label.replace("Weekly on ", "");
      expect(
        opts.find((o) => o.value === "MONTHLY_DAY_OF_MONTH")?.label,
      ).toBe(`Monthly on day ${dayNumber}`);
      expect(
        opts.find((o) => o.value === "MONTHLY_NTH_WEEKDAY")?.label,
      ).toContain(weekdayName);
      // The weekday name really is this day's, not a neighbour's.
      expect(calendarDayOfWeek(date)).toBe(weekday);
    }
  });
});

describe("describeRecurrence", () => {
  const anchor = requireInstant("2026-07-21T10:30:00.000Z");

  it("describes the pattern from the CLUB's day, not the environment's or the host's", () => {
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => dayAndWeekday(clubCalendarDateOf(anchor, z)),
    );
    const summary = describeRecurrence(
      { frequency: "MONTHLY_DAY_OF_MONTH", interval: 1, endMode: "never" },
      anchor,
      zone,
    );
    expect(summary).toBe(`Monthly on day ${expected.day}`);
    // The two wrong answers are genuinely different strings, so the assertion
    // above is a discriminating one rather than a coincidence.
    expect(summary).not.toBe(`Monthly on day ${environmentAnswer.day}`);
    expect(summary).not.toBe(`Monthly on day ${hostAnswer.day}`);
  });

  it("summarises interval and weekday", () => {
    expect(
      describeRecurrence(
        { frequency: "WEEKLY", interval: 1, endMode: "never" },
        requireInstant("2026-07-21T00:00:00.000Z"),
        RULE_ZONE,
      ),
    ).toBe("Weekly on Tuesday");
    expect(
      describeRecurrence(
        { frequency: "WEEKLY", interval: 2, endMode: "never" },
        requireInstant("2026-07-21T00:00:00.000Z"),
        RULE_ZONE,
      ),
    ).toBe("Every 2 weeks on Tuesday");
  });

  it("renders the `until` day in club time and survives a malformed one", () => {
    const zone = RULE_ZONE;
    const anchorUtc: Instant = requireInstant("2026-07-21T00:00:00.000Z");
    expect(
      describeRecurrence(
        {
          frequency: "WEEKLY",
          interval: 1,
          endMode: "until",
          until: "2026-08-11T00:00:00.000Z",
        },
        anchorUtc,
        zone,
      ),
    ).toBe("Weekly on Tuesday, until 11 Aug 2026");
    // A throw here would blank the whole "Repeat" picker behind an error
    // boundary, so the raw value is shown instead (#2264).
    expect(
      describeRecurrence(
        {
          frequency: "WEEKLY",
          interval: 1,
          endMode: "until",
          until: "not-a-date",
        },
        anchorUtc,
        zone,
      ),
    ).toBe("Weekly on Tuesday, until not-a-date");
  });

  it("counts occurrences when the rule ends on a count", () => {
    const rule: RecurrenceRule = {
      frequency: "DAILY",
      interval: 1,
      endMode: "count",
      count: 5,
    };
    expect(
      describeRecurrence(rule, requireInstant("2026-07-21T00:00:00.000Z"), RULE_ZONE),
    ).toBe("Daily, 5 times");
  });
});
