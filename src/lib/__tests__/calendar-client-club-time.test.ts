import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clubCalendarDateOf,
  clubWallTimeOf,
  formatClubInstantTime,
  formatClubMonthYear,
  requireCalendarDate,
  requireClubTimeZone,
  requireInstant,
  startOfCalendarMonth,
  startOfClubDay,
  type CalendarDate,
} from "@/lib/club-time";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import {
  buildMonthGrid,
  formatDayKeyLong,
  formatEventDateLong,
  formatEventTime,
  formatInstantTime,
  isSameCalendarMonth,
  isoEndFromDateTimeInputs,
  isoFromDateTimeInputs,
  monthGridRange,
  toDateInputValue,
  toTimeInputValue,
  weekdayLabels,
} from "@/lib/calendar-client";
import { divergentClubZone } from "./helpers/club-time-zone";
import { captureHostTimeZone, withTimeZone } from "./helpers/timezone";

/**
 * CT-4 group F5 (#2870): the month calendar's own helpers, split by the two
 * temporal kinds they hold.
 *
 * The grid, the headings and the day labels are CALENDAR DATES and take no zone —
 * so the tests for them are plain and the same on every host. The fetch window,
 * the day/time inputs and the event times are INSTANTS, so those tests use
 * `divergentClubZone`: a club zone that answers differently from both
 * `APP_TIME_ZONE` (which is what a provider-blind implementation reaches) and the
 * host's own clock (which is what the host-local getters this replaces reached).
 */

const RULE_ZONE = requireClubTimeZone("Pacific/Auckland");

function makeEvent(overrides: Partial<CalendarEventDTO> = {}): CalendarEventDTO {
  return {
    id: "evt",
    title: "Event",
    location: null,
    details: null,
    allDay: false,
    startsAt: "2026-04-16T10:30:00.000Z",
    endsAt: null,
    isMeeting: false,
    seriesId: null,
    detachedFromSeries: false,
    recurrence: null,
    ...overrides,
  };
}

describe("the grid is calendar dates, and needs no zone", () => {
  it("starts weeks on Monday", () => {
    expect(weekdayLabels()).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
  });

  it("finds the first day of a month", () => {
    expect(startOfCalendarMonth(requireCalendarDate("2026-04-16"))).toBe(
      "2026-04-01",
    );
    expect(startOfCalendarMonth(requireCalendarDate("2026-04-01"))).toBe(
      "2026-04-01",
    );
  });

  it("builds 42 cells, Monday-first, spilling into the neighbouring months", () => {
    // 1 Apr 2026 is a Wednesday, so the grid opens on Monday 30 March.
    const grid = buildMonthGrid(requireCalendarDate("2026-04-01"));
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe("2026-03-30");
    expect(grid[2]).toBe("2026-04-01");
    expect(grid[41]).toBe("2026-05-10");
    // Consecutive days throughout, with no repeats or gaps.
    expect(new Set(grid).size).toBe(42);
  });

  it("opens on the 1st when the 1st is itself a Monday", () => {
    // 1 Jun 2026 is a Monday.
    expect(buildMonthGrid(requireCalendarDate("2026-06-01"))[0]).toBe(
      "2026-06-01",
    );
  });

  it("knows which cells belong to the displayed month", () => {
    const april = requireCalendarDate("2026-04-01");
    expect(isSameCalendarMonth(requireCalendarDate("2026-04-30"), april)).toBe(
      true,
    );
    expect(isSameCalendarMonth(requireCalendarDate("2026-03-31"), april)).toBe(
      false,
    );
    expect(isSameCalendarMonth(requireCalendarDate("2027-04-01"), april)).toBe(
      false,
    );
  });

  it("titles the month from the calendar date, so a club west of Greenwich is not a month early", () => {
    /*
      The defect this closes. `formatMonthTitle` built `Date.UTC(year, month, 1)`
      and read it through an `APP_TIME_ZONE`-pinned formatter, which is the
      identity only for a club EAST of Greenwich: for `America/Denver` the
      encoding of 1 April 2026 reads back as 31 March, so the heading over an
      April grid said "March 2026". `formatClubMonthYear` takes a calendar date
      and pins UTC over its own encoding, so it is the identity everywhere.
    */
    expect(formatClubMonthYear(requireCalendarDate("2026-04-01"))).toBe(
      "April 2026",
    );
    expect(formatClubMonthYear(requireCalendarDate("2026-12-01"))).toBe(
      "December 2026",
    );
  });

  it("labels a day key long, and shows the raw text for a malformed one", () => {
    expect(formatDayKeyLong("2026-04-16")).toBe("Thursday, 16 April 2026");
    // A blank dialog is worse than the stored text (see ClubTimeProvider's note
    // on choosing a decoder in a client render).
    expect(formatDayKeyLong("2026-4-16")).toBe("2026-4-16");
    expect(formatDayKeyLong("")).toBe("");
  });
});

/**
 * The grid arithmetic must be indifferent to the PROCESS's own zone.
 *
 * This is the half of the claim CI cannot check by running the suite once
 * (#2870, owner decision 3): with `TZ` unset the runner resolves UTC, which is
 * exactly what the calendar-date formatters pin, so a helper that read the host
 * instead would be indistinguishable from a correct one. `withTimeZone` moves
 * the process's zone for the duration of a call, which is enough to catch the
 * arithmetic — `calendarDayOfWeek` reads its encoding per call, so a `getDay()`
 * for a `getUTCDay()` shifts the whole grid by a day on any host behind UTC.
 *
 * It does NOT catch a module-level formatter built with the wrong pin, because
 * that is constructed at import and a runtime pin cannot move it. The hostile
 * process/browser-zone proof over a re-imported module graph is CT-6's (#2991).
 */
describe("the grid is indifferent to the HOST's zone", () => {
  const HOSTILE_HOSTS = [
    "America/Denver",
    "America/Los_Angeles",
    "Pacific/Honolulu",
    "Pacific/Kiritimati",
    "Asia/Tokyo",
    "UTC",
  ];

  it("builds the same 42 cells whatever zone the process is in", () => {
    const april = requireCalendarDate("2026-04-01");
    const reference = buildMonthGrid(april);
    for (const host of HOSTILE_HOSTS) {
      expect(
        withTimeZone(host, () => buildMonthGrid(april)),
        `the month grid changed under a process pinned to ${host}`,
      ).toEqual(reference);
    }
  });

  it("labels a day key the same whatever zone the process is in", () => {
    for (const host of HOSTILE_HOSTS) {
      expect(
        withTimeZone(host, () => formatDayKeyLong("2026-04-16")),
        `the day label changed under a process pinned to ${host}`,
      ).toBe("Thursday, 16 April 2026");
    }
  });
});

/**
 * The other half of the same claim, and the one CI genuinely cannot check by
 * running the suite once.
 *
 * A calendar-date formatter is pinned at MODULE LOAD, so `withTimeZone` above
 * cannot move it — and `APP_TIME_ZONE` is read at load too. Owner decision 3 on
 * #2870 measured exactly this gap: a formatter that dropped its `"UTC"` pin for
 * the environment's zone killed 0 of 193 assertions with `TZ` unset and 0 at
 * `TZ=UTC`, because a host at or east of Greenwich makes the wrong pin an
 * identity. The accepted limit was that such a formatter would not be caught.
 *
 * It is caught here, for this subsystem, by re-importing the module under a
 * behind-UTC environment zone: `vi.resetModules()` plus a dynamic import
 * re-evaluates `@/config/operational`, so `APP_TIME_ZONE` really becomes
 * `America/Denver` for that copy of the module. A `"UTC"` pin is unaffected; an
 * `APP_TIME_ZONE` pin renders the day BEFORE the one it was handed, because the
 * value it is reading is a UTC-midnight encoding.
 *
 * This is not the whole of CT-6's hostile-zone proof (#2991) — it covers this
 * module's two calendar-date shapes and nothing else — but it is the shape that
 * proof will take, and the gap it closes is a real one for any club west of
 * Greenwich.
 */
describe("the day label does not follow the ENVIRONMENT's zone either", () => {
  const hostTimeZone = captureHostTimeZone();

  afterEach(() => {
    hostTimeZone.restore();
    vi.resetModules();
  });

  async function dayLabelUnderEnvironmentZone(
    environmentZone: string,
  ): Promise<{ appTimeZone: string; label: string }> {
    process.env.TZ = environmentZone;
    vi.resetModules();
    const operational = await import("@/config/operational");
    const calendarClient = await import("@/lib/calendar-client");
    return {
      appTimeZone: operational.APP_TIME_ZONE,
      label: calendarClient.formatDayKeyLong("2026-04-16"),
    };
  }

  it("renders the stored day for a club whose environment zone is behind UTC", async () => {
    const behind = await dayLabelUnderEnvironmentZone("America/Denver");
    // The premise: the re-import really did move the environment's zone. Without
    // this the assertion below would be checking nothing.
    expect(
      behind.appTimeZone,
      "the re-imported module graph did not pick up the pinned TZ, so this assertion proves nothing",
    ).toBe("America/Denver");
    expect(behind.label).toBe("Thursday, 16 April 2026");
  });

  it("renders the same day for an environment zone far ahead of UTC", async () => {
    const ahead = await dayLabelUnderEnvironmentZone("Pacific/Kiritimati");
    expect(ahead.appTimeZone).toBe("Pacific/Kiritimati");
    expect(ahead.label).toBe("Thursday, 16 April 2026");
  });
});

describe("monthGridRange — the club's day boundaries, not the browser's", () => {
  it("spans the whole grid from the club's first instant to its last", () => {
    const monthStart = requireCalendarDate("2026-04-01");
    const grid = buildMonthGrid(monthStart);
    const { zone } = divergentClubZone((z) =>
      startOfClubDay(grid[0], z).toISOString(),
    );
    const { from, to } = monthGridRange(monthStart, zone);

    expect(from.toISOString()).toBe(startOfClubDay(grid[0], zone).toISOString());
    // `to` is inclusive, so it is one millisecond before the club day AFTER the
    // last cell — the route compares it with `startsAt: { lte: to }`.
    expect(to.getTime()).toBe(
      startOfClubDay(
        requireCalendarDate("2026-05-11"),
        zone,
      ).getTime() - 1,
    );
    // Every cell of the grid really is inside the window.
    for (const day of grid) {
      const dayStart = startOfClubDay(day, zone);
      expect(dayStart.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(dayStart.getTime()).toBeLessThanOrEqual(to.getTime());
    }
  });

  it("asks for a window a host-local implementation would not have asked for", () => {
    const monthStart = requireCalendarDate("2026-04-01");
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => startOfClubDay(requireCalendarDate("2026-03-30"), z).toISOString(),
    );
    const { from } = monthGridRange(monthStart, zone);
    expect(from.toISOString()).toBe(expected);
    expect(from.toISOString()).not.toBe(environmentAnswer);
    expect(from.toISOString()).not.toBe(hostAnswer);
  });
});

describe("the form inputs round-trip through CLUB civil time", () => {
  const iso = "2026-04-16T10:30:00.000Z";

  it("shows the club's calendar day in the date input", () => {
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => clubCalendarDateOf(requireInstant(iso), z) as string,
    );
    expect(toDateInputValue(iso, zone)).toBe(expected);
    expect(toDateInputValue(iso, zone)).not.toBe(environmentAnswer);
    expect(toDateInputValue(iso, zone)).not.toBe(hostAnswer);
  });

  it("shows the club's wall clock in the time input", () => {
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => {
        const wall = clubWallTimeOf(requireInstant(iso), z);
        return `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
      },
    );
    expect(toTimeInputValue(iso, zone)).toBe(expected);
    expect(toTimeInputValue(iso, zone)).not.toBe(environmentAnswer);
    expect(toTimeInputValue(iso, zone)).not.toBe(hostAnswer);
  });

  it("reads a submitted date + time as CLUB wall time, and round-trips", () => {
    const { zone } = divergentClubZone(
      (z) => clubCalendarDateOf(requireInstant(iso), z) as string,
    );
    const submitted = isoFromDateTimeInputs("2026-04-16", zone, "19:00");
    expect(submitted).not.toBeNull();
    const back = requireInstant(submitted as string);
    const wall = clubWallTimeOf(back, zone);
    expect({ date: wall.date, hour: wall.hour, minute: wall.minute }).toEqual({
      date: "2026-04-16",
      hour: 19,
      minute: 0,
    });
    // The host would have read the same wall clock as a different moment.
    expect(submitted).not.toBe(new Date("2026-04-16T19:00").toISOString());
  });

  it("defaults an all-day submit to the first instant of the club day", () => {
    const { zone } = divergentClubZone((z) =>
      startOfClubDay(requireCalendarDate("2026-04-16"), z).toISOString(),
    );
    expect(isoFromDateTimeInputs("2026-04-16", zone)).toBe(
      startOfClubDay(requireCalendarDate("2026-04-16"), zone).toISOString(),
    );
  });

  it("treats an omitted OR EMPTY time as midnight", () => {
    // `""` is what a cleared `<input type="time">` holds, and "no time given"
    // and "time cleared" are the same request. A `??` here made the empty case
    // return null; the sole caller's `|| "00:00"` hid it, and this is exported.
    const midnight = startOfClubDay(
      requireCalendarDate("2026-04-16"),
      RULE_ZONE,
    ).toISOString();
    expect(isoFromDateTimeInputs("2026-04-16", RULE_ZONE)).toBe(midnight);
    expect(isoFromDateTimeInputs("2026-04-16", RULE_ZONE, "")).toBe(midnight);
  });

  it("refuses a malformed date or time instead of inventing a moment", () => {
    expect(isoFromDateTimeInputs("", RULE_ZONE, "19:00")).toBeNull();
    expect(isoFromDateTimeInputs("2026-4-16", RULE_ZONE, "19:00")).toBeNull();
    expect(isoFromDateTimeInputs("2026-02-30", RULE_ZONE, "19:00")).toBeNull();
    expect(isoFromDateTimeInputs("2026-04-16", RULE_ZONE, "25:00")).toBeNull();
    expect(isoFromDateTimeInputs("2026-04-16", RULE_ZONE, "nope")).toBeNull();
  });

  it("hands back an empty input value for an instant it cannot read", () => {
    expect(toDateInputValue("not-an-instant", RULE_ZONE)).toBe("");
    expect(toTimeInputValue("not-an-instant", RULE_ZONE)).toBe("");
  });
});

/**
 * The spring-forward gap, where every wall-clock reading inside one hour resolves
 * to the same instant.
 *
 * A correctness lens measured that resolving both ends of a timed event
 * independently stored a ZERO-LENGTH event for a time inside the gap —
 * "3:00 am – 3:00 am" — where the host-local version this migration replaced
 * stored thirty minutes. It is a regression the migration introduced, one hour of
 * one day a year, and `isoEndFromDateTimeInputs` exists to close it.
 *
 * The zone is PINNED here rather than chosen. The property is "this zone's clocks
 * jump over 02:00 on this date", which no zone-agnostic chooser can know, and the
 * premise that makes it meaningful is asserted instead: the gap has to be real.
 */
describe("a timed event inside a spring-forward gap keeps its length", () => {
  // 27 September 2026 is the New Zealand spring-forward Sunday: 02:00 -> 03:00,
  // so no reading from 02:00 to 02:59 exists.
  const GAP_DAY = "2026-09-27";

  function wall(iso: string): string {
    const w = clubWallTimeOf(requireInstant(iso), RULE_ZONE);
    return `${w.date} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  }
  function minutesBetween(startIso: string, endIso: string): number {
    return (
      (requireInstant(endIso).getTime() - requireInstant(startIso).getTime()) /
      60000
    );
  }

  it("has a real gap on the fixture day, or nothing below is being tested", () => {
    // Both readings collapsing onto one instant IS the premise. If this ever
    // stops holding — a tz-data change, a different zone — the assertions after
    // it would pass for the wrong reason.
    const at0200 = isoFromDateTimeInputs(GAP_DAY, RULE_ZONE, "02:00");
    const at0230 = isoFromDateTimeInputs(GAP_DAY, RULE_ZONE, "02:30");
    expect(at0200).not.toBeNull();
    expect(at0200).toBe(at0230);
    expect(wall(at0200 as string)).toBe("2026-09-27 03:00");
  });

  it("stores the typed duration when BOTH ends fall inside the gap", () => {
    const start = isoFromDateTimeInputs(GAP_DAY, RULE_ZONE, "02:00") as string;
    const end = isoEndFromDateTimeInputs(
      GAP_DAY,
      RULE_ZONE,
      "02:00",
      "02:30",
    ) as string;
    expect(minutesBetween(start, end)).toBe(30);
    expect(wall(end)).toBe("2026-09-27 03:30");
    // The naive resolution — the one this replaces — would have been zero.
    expect(end).not.toBe(isoFromDateTimeInputs(GAP_DAY, RULE_ZONE, "02:30"));
  });

  it("holds for a gap reading that is not on the hour", () => {
    const start = isoFromDateTimeInputs(GAP_DAY, RULE_ZONE, "02:15") as string;
    const end = isoEndFromDateTimeInputs(
      GAP_DAY,
      RULE_ZONE,
      "02:15",
      "02:45",
    ) as string;
    expect(minutesBetween(start, end)).toBe(30);
  });

  it("keeps the EXACT typed end when it survives the transition", () => {
    /*
      The trade this makes, pinned so it cannot be undone by "simplifying" the
      helper into a duration-first one. 01:30 to 03:30 spans two hours of wall
      clock and one hour of real time; the officer typed 03:30 and must get
      03:30, not the 04:30 a duration-first version would store.
    */
    const end = isoEndFromDateTimeInputs(
      GAP_DAY,
      RULE_ZONE,
      "01:30",
      "03:30",
    ) as string;
    expect(wall(end)).toBe("2026-09-27 03:30");
    expect(end).toBe(isoFromDateTimeInputs(GAP_DAY, RULE_ZONE, "03:30"));
  });

  it("changes nothing on an ordinary day", () => {
    for (const [startTime, endTime] of [
      ["09:00", "10:30"],
      ["00:00", "23:59"],
      ["19:00", "19:01"],
    ] as const) {
      expect(
        isoEndFromDateTimeInputs("2026-09-26", RULE_ZONE, startTime, endTime),
      ).toBe(isoFromDateTimeInputs("2026-09-26", RULE_ZONE, endTime));
    }
  });

  it("leaves a deliberately zero-length event alone, and one that ends early", () => {
    // The same time typed twice is what the officer asked for, so it is not
    // repaired into something else — this helper refuses nothing.
    expect(
      isoEndFromDateTimeInputs("2026-09-26", RULE_ZONE, "09:00", "09:00"),
    ).toBe(isoFromDateTimeInputs("2026-09-26", RULE_ZONE, "09:00"));
    // An end before the start is left to fail the route's own range check,
    // exactly as before, rather than being silently turned into a duration.
    expect(
      isoEndFromDateTimeInputs("2026-09-26", RULE_ZONE, "10:00", "09:00"),
    ).toBe(isoFromDateTimeInputs("2026-09-26", RULE_ZONE, "09:00"));
  });

  it("refuses a malformed date or either malformed time", () => {
    expect(isoEndFromDateTimeInputs("2026-9-26", RULE_ZONE, "09:00", "10:00")).toBeNull();
    expect(isoEndFromDateTimeInputs("2026-09-26", RULE_ZONE, "nope", "10:00")).toBeNull();
    expect(isoEndFromDateTimeInputs("2026-09-26", RULE_ZONE, "09:00", "25:00")).toBeNull();
  });
});

describe("event labels read the club's clock", () => {
  it("formats a chip time in club time, and says so for an all-day event", () => {
    const { zone, expected, environmentAnswer, hostAnswer } = divergentClubZone(
      (z) => formatClubInstantTime(requireInstant("2026-04-16T10:30:00.000Z"), z),
    );
    const label = formatEventTime(makeEvent(), zone);
    expect(label).toBe(expected);
    // Both wrong answers really are different labels, so the assertion above is
    // discriminating: a chip built from `APP_TIME_ZONE` or from the host's own
    // `getHours()` would read as one of these.
    expect(label).not.toBe(environmentAnswer);
    expect(label).not.toBe(hostAnswer);
    expect(formatEventTime(makeEvent({ allDay: true }), zone)).toBe("All day");
  });

  it("formats a heading from the club calendar day the event starts on", () => {
    const { zone, expected } = divergentClubZone(
      (z) =>
        clubCalendarDateOf(
          requireInstant("2026-04-16T10:30:00.000Z"),
          z,
        ) as CalendarDate,
    );
    expect(formatEventDateLong(makeEvent(), zone)).toBe(
      formatDayKeyLong(expected),
    );
  });

  it("shows the raw value rather than throwing on an unusable instant", () => {
    // `Intl.format` throws a RangeError on an invalid Date, and an unhandled
    // throw in a client render blanks the screen behind an error boundary.
    expect(formatInstantTime("not-an-instant", RULE_ZONE)).toBe("not-an-instant");
    expect(formatEventDateLong(makeEvent({ startsAt: "nope" }), RULE_ZONE)).toBe(
      "nope",
    );
  });

  it("renders the house time shape for a club-time instant", () => {
    // 10:30Z on 16 Apr 2026 is 22:30 in New Zealand (UTC+12 in April).
    expect(formatInstantTime("2026-04-16T10:30:00.000Z", RULE_ZONE)).toBe(
      "10:30 pm",
    );
  });
});
