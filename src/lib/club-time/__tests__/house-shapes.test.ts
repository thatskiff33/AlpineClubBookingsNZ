/**
 * The house display shapes: byte-identical to what shipped, and zone-correct
 * (CT-2, #2990).
 */
import { describe, expect, it } from "vitest";

import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import { addCalendarDays, requireCalendarDate } from "../calendar-date";
import {
  formatClubDate,
  formatClubDayMonth,
  formatClubInstantDate,
  formatClubInstantDateTime,
  formatClubInstantLongDate,
  formatClubInstantMonthYear,
  formatClubInstantTime,
  formatClubInstantWeekdayDate,
  formatClubLongDate,
  formatClubLongWeekday,
  formatClubLongWeekdayDate,
  formatClubLongWeekdayDayMonth,
  formatClubMonthYear,
  formatClubShortMonth,
  formatClubShortMonthYear,
  formatClubWeekday,
  formatClubWeekdayDate,
  formatClubWeekdayDay,
  formatClubWeekdayDayMonth,
} from "../format";
import { requireClubTimeZone } from "../zone";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

const cd = requireCalendarDate;
const AUCKLAND = requireClubTimeZone("Pacific/Auckland");
const DENVER = requireClubTimeZone("America/Denver");

// 02:30 UTC on 16 April 2026 is 14:30 the same day in Auckland and 20:30 the
// PREVIOUS day in Denver, so every assertion below fails if a formatter loses
// its zone argument.
const INSTANT = new Date("2026-04-16T02:30:00.000Z");

describe("the six shapes are byte-identical to the helpers they replace", () => {
  it("matches the frozen formatters the retired adapter held, on 400 instants", () => {
    /*
      THE OLD SPELLING IS WRITTEN OUT BY HAND, and since #3123 that is the ONLY
      surviving record of it. These are the six frozen `Intl.DateTimeFormat`
      constants `src/lib/nzst-date.ts` held before CT-2 (#2990) made it delegate,
      transcribed from `git show` of the pre-delegation file, so the comparison is
      against what actually shipped to the club for years.

      IT WAS WRITTEN OUT BY HAND BEFORE THE DELETION TOO, for a reason that still
      explains the shape of this case. While the adapter existed and delegated,
      `formatNZDate(x) === formatClubInstantDate(x, zone)` compared the kernel
      with itself and asserted nothing at all — the strongest-looking evidence in
      this file, and a tautology. #3123 then deleted the adapter outright, which
      is why this case cannot be re-expressed through it and why these constants
      must stay: they are the club's rendering history, and the only thing that
      would catch the kernel drifting away from it.

      Six shapes over 400 consecutive days, both sides of both New Zealand
      transitions, at a time of day that differs between the club's zone and UTC.
      The lodge-display half of the file does the same thing for its three
      shapes, and for the same reason.
    */
    const zoned = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(APP_LOCALE, { timeZone: APP_TIME_ZONE, ...options });
    const oldDate = zoned({ dateStyle: "medium" });
    const oldDateTime = zoned({ dateStyle: "medium", timeStyle: "short" });
    const oldLongDate = zoned({ dateStyle: "long" });
    const oldTime = zoned({ timeStyle: "short" });
    const oldMonthYear = zoned({ month: "long", year: "numeric" });
    const oldWeekdayDate = zoned({
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });

    let day = cd("2026-01-01");
    for (let step = 0; step < 400; step += 1) {
      // 02:30Z is 14:30 or 15:30 in Auckland and the PREVIOUS evening in Denver,
      // so a lost zone argument moves the date as well as the time.
      const instant = new Date(`${day}T02:30:00.000Z`);
      const at = `${day} 02:30Z`;
      expect(formatClubInstantDate(instant, AUCKLAND), at).toBe(
        oldDate.format(instant),
      );
      expect(formatClubInstantDateTime(instant, AUCKLAND), at).toBe(
        oldDateTime.format(instant),
      );
      expect(formatClubInstantLongDate(instant, AUCKLAND), at).toBe(
        oldLongDate.format(instant),
      );
      expect(formatClubInstantTime(instant, AUCKLAND), at).toBe(
        oldTime.format(instant),
      );
      expect(formatClubInstantMonthYear(instant, AUCKLAND), at).toBe(
        oldMonthYear.format(instant),
      );
      expect(formatClubInstantWeekdayDate(instant, AUCKLAND), at).toBe(
        oldWeekdayDate.format(instant),
      );
      day = addCalendarDays(day, 1);
    }
  });

  it("the frozen comparison is not vacuous: the six shapes really differ", () => {
    // A sweep of six equalities passes perfectly if the six shapes are the same
    // shape. They are not, and this is what says so.
    const rendered = new Set([
      formatClubInstantDate(INSTANT, AUCKLAND),
      formatClubInstantDateTime(INSTANT, AUCKLAND),
      formatClubInstantLongDate(INSTANT, AUCKLAND),
      formatClubInstantTime(INSTANT, AUCKLAND),
      formatClubInstantMonthYear(INSTANT, AUCKLAND),
      formatClubInstantWeekdayDate(INSTANT, AUCKLAND),
    ]);
    expect(rendered.size).toBe(6);
  });

  it("renders the shapes this repository has always rendered", () => {
    expect(formatClubInstantDate(INSTANT, AUCKLAND)).toBe("16 Apr 2026");
    expect(formatClubInstantDateTime(INSTANT, AUCKLAND)).toMatch(
      /^16 Apr 2026, 2:30\spm$/,
    );
    expect(formatClubInstantLongDate(INSTANT, AUCKLAND)).toBe("16 April 2026");
    expect(formatClubInstantTime(INSTANT, AUCKLAND)).toMatch(/^2:30\spm$/);
    expect(formatClubInstantMonthYear(INSTANT, AUCKLAND)).toBe("April 2026");
    expect(formatClubInstantWeekdayDate(INSTANT, AUCKLAND)).toBe(
      "Thu, 16 Apr 2026",
    );
  });

  it("keeps the long form distinct from the medium one (INV-DATE-016)", () => {
    expect(formatClubInstantLongDate(INSTANT, AUCKLAND)).not.toBe(
      formatClubInstantDate(INSTANT, AUCKLAND),
    );
    expect(formatClubLongDate(cd("2026-04-16"))).not.toBe(
      formatClubDate(cd("2026-04-16")),
    );
  });
});

describe("the five shapes CT-4 added, and the local formatters four of them retire", () => {
  /*
    FOUR OF THE FIVE EXISTED AS A LOCAL `Intl.DateTimeFormat` FIRST, with a
    comment saying the kernel had no such shape. So the strongest evidence
    available is the same as for the six originals: the old options written out BY
    HAND here — not imported, which would compare the kernel with itself — and
    swept over 400 consecutive days that cross both New Zealand transitions and a
    leap year.

    `shortMonth` IS THE EXCEPTION AND THE COMPARISON MEANS SOMETHING WEAKER FOR
    IT. It retired a hard-coded `"(Apr-Mar)"` STRING on the subscriptions page
    rather than a local formatter, so there is no shipped `Intl` spelling to
    compare against — only the options the shape declares. Its sweep therefore
    pins that a bare `{ month: "short" }` under a `"UTC"` pin is what it renders,
    which is what stops it drifting into a sliced `shortMonthYear` later.

    Every one is a CALENDAR-DATE shape, so the comparison feeds the old formatter
    the UTC-midnight encoding under a `"UTC"` pin, which is what the call sites
    they replace did.
  */
  const pinnedUtc = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(APP_LOCALE, { timeZone: "UTC", ...options });

  it("reproduces each retired local formatter byte for byte, over 400 days", () => {
    // booking-calendar.tsx, booking-editor.tsx, and the kiosk/chore-sheet pages.
    const oldLongWeekdayDate = pinnedUtc({
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    // guest-night-grid.tsx, and the dashboard's tight slots.
    const oldDayMonth = pinnedUtc({ day: "numeric", month: "short" });
    // finance chart axes.
    const oldShortMonthYear = pinnedUtc({ month: "short", year: "numeric" });
    // the calendar subsystem's recurrence labels.
    const oldLongWeekday = pinnedUtc({ weekday: "long" });
    // the membership season label — no shipped formatter to compare against, so
    // this pins the declared shape rather than reproducing a retired one.
    const oldShortMonth = pinnedUtc({ month: "short" });

    let date = cd("2026-01-01");
    for (let step = 0; step < 400; step += 1) {
      const encoded = new Date(`${date}T00:00:00.000Z`);
      expect(formatClubShortMonth(date), date).toBe(
        oldShortMonth.format(encoded),
      );
      expect(formatClubLongWeekdayDate(date), date).toBe(
        oldLongWeekdayDate.format(encoded),
      );
      expect(formatClubDayMonth(date), date).toBe(oldDayMonth.format(encoded));
      expect(formatClubShortMonthYear(date), date).toBe(
        oldShortMonthYear.format(encoded),
      );
      expect(formatClubLongWeekday(date), date).toBe(oldLongWeekday.format(encoded));
      date = addCalendarDays(date, 1);
    }
  });

  it("renders the strings the retired call sites rendered", () => {
    expect(formatClubLongWeekdayDate(cd("2026-04-16"))).toBe(
      "Thursday, 16 April 2026",
    );
    expect(formatClubDayMonth(cd("2026-04-16"))).toBe("16 Apr");
    expect(formatClubShortMonthYear(cd("2026-04-16"))).toBe("Apr 2026");
    expect(formatClubLongWeekday(cd("2026-04-16"))).toBe("Thursday");
    expect(formatClubShortMonth(cd("2026-04-16"))).toBe("Apr");
    // en-NZ abbreviates September to FOUR characters while every other month
    // takes three, so a shape or a consumer that assumed a fixed width is wrong
    // here and nowhere else. `season-label.test.ts` carries the label-width half.
    expect(formatClubShortMonth(cd("2026-09-16"))).toBe("Sept");
  });

  it("the sweep is not vacuous: all five shapes really differ", () => {
    /*
      Five equalities pass perfectly if the five shapes are the same shape. They
      must also differ from the SIX that already existed, because a new shape that
      silently duplicated `longWeekdayDayMonth` or `monthYear` would satisfy every
      assertion above while adding nothing. `shortMonth` is the one most at risk
      of that: a sliced `shortMonthYear` is a month name too.
    */
    const day = cd("2026-04-16");
    const rendered = [
      formatClubLongWeekdayDate(day),
      formatClubDayMonth(day),
      formatClubShortMonthYear(day),
      formatClubLongWeekday(day),
      formatClubShortMonth(day),
      formatClubDate(day),
      formatClubLongDate(day),
      formatClubMonthYear(day),
      formatClubWeekdayDate(day),
      formatClubWeekday(day),
      formatClubWeekdayDay(day),
      formatClubWeekdayDayMonth(day),
      formatClubLongWeekdayDayMonth(day),
    ];
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("is NOT the composed form, and the composition is what would drift", () => {
    /*
      `longWeekdayDayMonth` plus the year is byte-identical for `en-NZ` — which is
      exactly why four authors were tempted by it, and exactly why this case
      exists. It is a coincidence of THIS locale's punctuation, not a property:
      `APP_LOCALE` is configurable, and a locale that ordered the pair differently
      would silently change every day button in the product. So the equality is
      pinned as a coincidence rather than relied on as a rule.
    */
    const day = cd("2026-04-16");
    const composed = `${formatClubLongWeekdayDayMonth(day)} ${day.slice(0, 4)}`;
    expect(formatClubLongWeekdayDate(day)).toBe("Thursday, 16 April 2026");
    expect(composed, "en-NZ happens to agree; the shape is still declared whole").toBe(
      "Thursday, 16 April 2026",
    );
    // And the declared shape asks Intl rather than assembling, which is the
    // difference a non-en-NZ locale would expose.
    expect(formatClubLongWeekdayDate(day)).not.toBe(
      formatClubLongWeekdayDayMonth(day),
    );
  });

  it("cannot be moved by the host machine's timezone", () => {
    // The premise first: two host zones that resolve the same prove nothing.
    expect(
      withTimeZone("America/Los_Angeles", () =>
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBe("America/Los_Angeles");

    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () => [
        formatClubLongWeekdayDate(cd("2026-04-16")),
        formatClubDayMonth(cd("2026-04-16")),
        formatClubShortMonthYear(cd("2026-04-16")),
        formatClubLongWeekday(cd("2026-04-16")),
        formatClubShortMonth(cd("2026-04-16")),
      ]);
    expect(answersIn("UTC")).toEqual(answersIn("America/Los_Angeles"));
    expect(answersIn("UTC")).toEqual([
      "Thursday, 16 April 2026",
      "16 Apr",
      "Apr 2026",
      "Thursday",
      "Apr",
    ]);
  });

  it("survives a day a club zone would have moved", () => {
    // 2026-04-05 ends NZDT, 2026-03-08 is Havana's midnight jump, 2028-02-29 is a
    // leap day. A shape that secretly projected through a zone would slip on one.
    // `shortMonth` is the shape with the least to hold on to — no year and no day
    // to check — so its expectation is spelled out per day, and 2026-09-27 is the
    // four-character month at the same time.
    const expectedShortMonth: Record<string, string> = {
      "2026-03-08": "Mar",
      "2026-04-05": "Apr",
      "2026-09-27": "Sept",
      "2028-02-29": "Feb",
    };
    for (const day of ["2026-03-08", "2026-04-05", "2026-09-27", "2028-02-29"]) {
      expect(formatClubLongWeekdayDate(cd(day)), day).toContain(day.slice(0, 4));
      expect(formatClubDayMonth(cd(day)), day).toContain(
        String(Number(day.slice(8, 10))),
      );
      expect(formatClubShortMonthYear(cd(day)), day).toContain(day.slice(0, 4));
      expect(formatClubShortMonth(cd(day)), day).toBe(expectedShortMonth[day]);
    }
  });
});

describe("the zone argument is load-bearing", () => {
  it("renders the same instant differently for a behind-UTC club", () => {
    expect(formatClubInstantDate(INSTANT, DENVER)).toBe("15 Apr 2026");
    expect(formatClubInstantWeekdayDate(INSTANT, DENVER)).toBe("Wed, 15 Apr 2026");
    expect(formatClubInstantTime(INSTANT, DENVER)).toMatch(/^8:30\spm$/);
  });

  it("keeps the memo keyed on the zone, not only on the shape", () => {
    /*
      The single most likely implementation slip in `intl.ts`: a memo keyed on
      the shape alone returns the FIRST zone's formatter for every later zone,
      which looks perfect on a one-club installation. Asking Auckland first and
      Denver second is what makes it visible.
    */
    const auckland = formatClubInstantDate(INSTANT, AUCKLAND);
    const denver = formatClubInstantDate(INSTANT, DENVER);
    const aucklandAgain = formatClubInstantDate(INSTANT, AUCKLAND);
    expect(auckland).not.toBe(denver);
    expect(aucklandAgain).toBe(auckland);
  });
});

describe("a calendar date is formatted WITHOUT a zone, and cannot move", () => {
  it("renders the day that was asked for", () => {
    expect(formatClubDate(cd("2026-04-16"))).toBe("16 Apr 2026");
    expect(formatClubLongDate(cd("2026-04-16"))).toBe("16 April 2026");
    expect(formatClubMonthYear(cd("2026-04-16"))).toBe("April 2026");
    expect(formatClubWeekdayDate(cd("2026-04-16"))).toBe("Thu, 16 Apr 2026");
    expect(formatClubWeekday(cd("2026-04-16"))).toBe("Thu");
    expect(formatClubWeekdayDay(cd("2026-04-16"))).toBe("Thu 16");
    expect(formatClubWeekdayDay(cd("2026-04-06"))).toBe("Mon 6");
    expect(formatClubWeekdayDayMonth(cd("2026-04-16"))).toBe("Thu, 16 Apr");
    expect(formatClubLongWeekdayDayMonth(cd("2026-04-16"))).toBe(
      "Thursday, 16 April",
    );
  });

  it("reproduces the lobby-display labels these replace, byte for byte", () => {
    /*
      The lobby boards built "Fri 10" by handing a UTC-midnight `Date` to a
      club-zone-pinned `Intl.DateTimeFormat` and appending `getUTCDate()`. That
      is correct only for a club east of Greenwich; the kernel reaches the same
      strings with no zone at all. Both are compared here so a shape drift is
      caught, and the OLD spelling is written out rather than imported because
      the modules it lived in no longer contain it.
    */
    const oldWeekday = new Intl.DateTimeFormat(APP_LOCALE, {
      timeZone: APP_TIME_ZONE,
      weekday: "short",
    });
    const oldShort = new Intl.DateTimeFormat(APP_LOCALE, {
      timeZone: APP_TIME_ZONE,
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    const oldLong = new Intl.DateTimeFormat(APP_LOCALE, {
      timeZone: APP_TIME_ZONE,
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    let date = cd("2026-01-01");
    for (let step = 0; step < 400; step += 1) {
      const encoded = new Date(`${date}T00:00:00Z`);
      expect(formatClubWeekday(date), date).toBe(oldWeekday.format(encoded));
      expect(formatClubWeekdayDay(date), date).toBe(
        `${oldWeekday.format(encoded)} ${encoded.getUTCDate()}`,
      );
      expect(formatClubWeekdayDayMonth(date), date).toBe(oldShort.format(encoded));
      expect(formatClubLongWeekdayDayMonth(date), date).toBe(
        oldLong.format(encoded),
      );
      date = addCalendarDays(date, 1);
    }
  });

  it("is identical under both host timezones", () => {
    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () => [
        formatClubDate(cd("2026-04-16")),
        formatClubLongDate(cd("2026-04-16")),
        formatClubMonthYear(cd("2026-04-16")),
        formatClubWeekdayDate(cd("2026-04-16")),
        formatClubWeekdayDay(cd("2026-04-16")),
        formatClubWeekdayDayMonth(cd("2026-04-16")),
        formatClubLongWeekdayDayMonth(cd("2026-04-16")),
      ]);
    expect(answersIn("UTC")).toEqual(answersIn("America/Los_Angeles"));
  });

  it("survives a day a club zone would have moved", () => {
    /*
      2026-04-05 is the day NZDT ends, and 2026-03-08 is the day Havana's clocks
      jump at midnight. A calendar-date formatter that secretly projected through
      one of those zones would slip; one that does not cannot.
    */
    for (const day of ["2026-03-08", "2026-04-05", "2026-09-27", "2028-02-29"]) {
      expect(formatClubDate(cd(day)).slice(-4)).toBe(day.slice(0, 4));
      expect(formatClubWeekdayDay(cd(day))).toContain(
        String(Number(day.slice(8, 10))),
      );
    }
  });
});
