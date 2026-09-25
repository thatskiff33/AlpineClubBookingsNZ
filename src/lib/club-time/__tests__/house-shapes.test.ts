/**
 * The house display shapes: byte-identical to what shipped, zone-correct
 * (CT-2, #2990), and following the club's LOCALE rather than the environment's
 * (#3566, stage 4 of programme #3205).
 *
 * THE RETIRED SPELLINGS BELOW ARE WRITTEN WITH LITERALS. They used to be built
 * from `APP_LOCALE` / `APP_TIME_ZONE`, the constants the pre-kernel formatters
 * read; #3566 made every rendering take the club's format instead, and #3567
 * retires the constants. A literal `"en-NZ"` / `"Pacific/Auckland"` is what they
 * resolve to on the shipped defaults, so the transcription survives both stages
 * and still records exactly what the club was shown.
 */
import { describe, expect, it } from "vitest";

import { addCalendarDays, requireCalendarDate } from "../calendar-date";
import { bindClubTime } from "../bound";
import {
  formatClubInstantCompactDateTime,
  formatClubInstantDateTimeWithSeconds,
  formatClubInstantDayMonth,
  formatClubInstantWeekdayDayMonth,
  formatStayDate,
  formatStayDateOrNull,
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
import { formatCalendarDateShape, formatHouseShape, HOUSE_SHAPES } from "../intl";
import type { ClubDateFormat } from "../types";
import { requireClubTimeZone } from "../zone";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  CLUB_FORMAT_TEST,
  CLUB_FORMAT_TEST_OTHER,
} from "@/lib/__tests__/support/club-format-fixture";

/** The shipped default — what `APP_LOCALE` resolved to before #3566. */
const NZ: ClubDateFormat = CLUB_FORMAT_TEST;
/** A club that is NOT on the default, and whose dates read differently. */
const CH: ClubDateFormat = CLUB_FORMAT_TEST_OTHER;
/** The literal the retired transcriptions are built from (see the module doc). */
const RETIRED_LOCALE = "en-NZ";
const RETIRED_ZONE = "Pacific/Auckland";

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
      `formatNZDate(x) === formatClubInstantDate(x, zone, NZ)` compared the kernel
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
      new Intl.DateTimeFormat(RETIRED_LOCALE, { timeZone: RETIRED_ZONE, ...options });
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
      expect(formatClubInstantDate(instant, AUCKLAND, NZ), at).toBe(
        oldDate.format(instant),
      );
      expect(formatClubInstantDateTime(instant, AUCKLAND, NZ), at).toBe(
        oldDateTime.format(instant),
      );
      expect(formatClubInstantLongDate(instant, AUCKLAND, NZ), at).toBe(
        oldLongDate.format(instant),
      );
      expect(formatClubInstantTime(instant, AUCKLAND, NZ), at).toBe(
        oldTime.format(instant),
      );
      expect(formatClubInstantMonthYear(instant, AUCKLAND, NZ), at).toBe(
        oldMonthYear.format(instant),
      );
      expect(formatClubInstantWeekdayDate(instant, AUCKLAND, NZ), at).toBe(
        oldWeekdayDate.format(instant),
      );
      day = addCalendarDays(day, 1);
    }
  });

  it("the frozen comparison is not vacuous: the six shapes really differ", () => {
    // A sweep of six equalities passes perfectly if the six shapes are the same
    // shape. They are not, and this is what says so.
    const rendered = new Set([
      formatClubInstantDate(INSTANT, AUCKLAND, NZ),
      formatClubInstantDateTime(INSTANT, AUCKLAND, NZ),
      formatClubInstantLongDate(INSTANT, AUCKLAND, NZ),
      formatClubInstantTime(INSTANT, AUCKLAND, NZ),
      formatClubInstantMonthYear(INSTANT, AUCKLAND, NZ),
      formatClubInstantWeekdayDate(INSTANT, AUCKLAND, NZ),
    ]);
    expect(rendered.size).toBe(6);
  });

  it("renders the shapes this repository has always rendered", () => {
    expect(formatClubInstantDate(INSTANT, AUCKLAND, NZ)).toBe("16 Apr 2026");
    expect(formatClubInstantDateTime(INSTANT, AUCKLAND, NZ)).toMatch(
      /^16 Apr 2026, 2:30\spm$/,
    );
    expect(formatClubInstantLongDate(INSTANT, AUCKLAND, NZ)).toBe("16 April 2026");
    expect(formatClubInstantTime(INSTANT, AUCKLAND, NZ)).toMatch(/^2:30\spm$/);
    expect(formatClubInstantMonthYear(INSTANT, AUCKLAND, NZ)).toBe("April 2026");
    expect(formatClubInstantWeekdayDate(INSTANT, AUCKLAND, NZ)).toBe(
      "Thu, 16 Apr 2026",
    );
  });

  it("keeps the long form distinct from the medium one (INV-DATE-016)", () => {
    expect(formatClubInstantLongDate(INSTANT, AUCKLAND, NZ)).not.toBe(
      formatClubInstantDate(INSTANT, AUCKLAND, NZ),
    );
    expect(formatClubLongDate(cd("2026-04-16"), NZ)).not.toBe(
      formatClubDate(cd("2026-04-16"), NZ),
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
    new Intl.DateTimeFormat(RETIRED_LOCALE, { timeZone: "UTC", ...options });

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
      expect(formatClubShortMonth(date, NZ), date).toBe(
        oldShortMonth.format(encoded),
      );
      expect(formatClubLongWeekdayDate(date, NZ), date).toBe(
        oldLongWeekdayDate.format(encoded),
      );
      expect(formatClubDayMonth(date, NZ), date).toBe(oldDayMonth.format(encoded));
      expect(formatClubShortMonthYear(date, NZ), date).toBe(
        oldShortMonthYear.format(encoded),
      );
      expect(formatClubLongWeekday(date, NZ), date).toBe(oldLongWeekday.format(encoded));
      date = addCalendarDays(date, 1);
    }
  });

  it("renders the strings the retired call sites rendered", () => {
    expect(formatClubLongWeekdayDate(cd("2026-04-16"), NZ)).toBe(
      "Thursday, 16 April 2026",
    );
    expect(formatClubDayMonth(cd("2026-04-16"), NZ)).toBe("16 Apr");
    expect(formatClubShortMonthYear(cd("2026-04-16"), NZ)).toBe("Apr 2026");
    expect(formatClubLongWeekday(cd("2026-04-16"), NZ)).toBe("Thursday");
    expect(formatClubShortMonth(cd("2026-04-16"), NZ)).toBe("Apr");
    // en-NZ abbreviates September to FOUR characters while every other month
    // takes three, so a shape or a consumer that assumed a fixed width is wrong
    // here and nowhere else. `season-label.test.ts` carries the label-width half.
    expect(formatClubShortMonth(cd("2026-09-16"), NZ)).toBe("Sept");
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
      formatClubLongWeekdayDate(day, NZ),
      formatClubDayMonth(day, NZ),
      formatClubShortMonthYear(day, NZ),
      formatClubLongWeekday(day, NZ),
      formatClubShortMonth(day, NZ),
      formatClubDate(day, NZ),
      formatClubLongDate(day, NZ),
      formatClubMonthYear(day, NZ),
      formatClubWeekdayDate(day, NZ),
      formatClubWeekday(day, NZ),
      formatClubWeekdayDay(day, NZ),
      formatClubWeekdayDayMonth(day, NZ),
      formatClubLongWeekdayDayMonth(day, NZ),
    ];
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("is NOT the composed form, and the composition is what would drift", () => {
    /*
      `longWeekdayDayMonth` plus the year is byte-identical for `en-NZ` — which is
      exactly why four authors were tempted by it, and exactly why this case
      exists. It is a coincidence of THIS locale's punctuation, not a property:
      the club's locale is a setting, and a locale that ordered the pair differently
      would silently change every day button in the product. So the equality is
      pinned as a coincidence rather than relied on as a rule.
    */
    const day = cd("2026-04-16");
    const composed = `${formatClubLongWeekdayDayMonth(day, NZ)} ${day.slice(0, 4)}`;
    expect(formatClubLongWeekdayDate(day, NZ)).toBe("Thursday, 16 April 2026");
    expect(composed, "en-NZ happens to agree; the shape is still declared whole").toBe(
      "Thursday, 16 April 2026",
    );
    // And the declared shape asks Intl rather than assembling, which is the
    // difference a non-en-NZ locale would expose.
    expect(formatClubLongWeekdayDate(day, NZ)).not.toBe(
      formatClubLongWeekdayDayMonth(day, NZ),
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
        formatClubLongWeekdayDate(cd("2026-04-16"), NZ),
        formatClubDayMonth(cd("2026-04-16"), NZ),
        formatClubShortMonthYear(cd("2026-04-16"), NZ),
        formatClubLongWeekday(cd("2026-04-16"), NZ),
        formatClubShortMonth(cd("2026-04-16"), NZ),
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
      expect(formatClubLongWeekdayDate(cd(day), NZ), day).toContain(day.slice(0, 4));
      expect(formatClubDayMonth(cd(day), NZ), day).toContain(
        String(Number(day.slice(8, 10))),
      );
      expect(formatClubShortMonthYear(cd(day), NZ), day).toContain(day.slice(0, 4));
      expect(formatClubShortMonth(cd(day), NZ), day).toBe(expectedShortMonth[day]);
    }
  });
});

describe("the zone argument is load-bearing", () => {
  it("renders the same instant differently for a behind-UTC club", () => {
    expect(formatClubInstantDate(INSTANT, DENVER, NZ)).toBe("15 Apr 2026");
    expect(formatClubInstantWeekdayDate(INSTANT, DENVER, NZ)).toBe("Wed, 15 Apr 2026");
    expect(formatClubInstantTime(INSTANT, DENVER, NZ)).toMatch(/^8:30\spm$/);
  });

  it("keeps the memo keyed on the zone, not only on the shape", () => {
    /*
      The single most likely implementation slip in `intl.ts`: a memo keyed on
      the shape alone returns the FIRST zone's formatter for every later zone,
      which looks perfect on a one-club installation. Asking Auckland first and
      Denver second is what makes it visible.
    */
    const auckland = formatClubInstantDate(INSTANT, AUCKLAND, NZ);
    const denver = formatClubInstantDate(INSTANT, DENVER, NZ);
    const aucklandAgain = formatClubInstantDate(INSTANT, AUCKLAND, NZ);
    expect(auckland).not.toBe(denver);
    expect(aucklandAgain).toBe(auckland);
  });
});

describe("a calendar date is formatted WITHOUT a zone, and cannot move", () => {
  it("renders the day that was asked for", () => {
    expect(formatClubDate(cd("2026-04-16"), NZ)).toBe("16 Apr 2026");
    expect(formatClubLongDate(cd("2026-04-16"), NZ)).toBe("16 April 2026");
    expect(formatClubMonthYear(cd("2026-04-16"), NZ)).toBe("April 2026");
    expect(formatClubWeekdayDate(cd("2026-04-16"), NZ)).toBe("Thu, 16 Apr 2026");
    expect(formatClubWeekday(cd("2026-04-16"), NZ)).toBe("Thu");
    expect(formatClubWeekdayDay(cd("2026-04-16"), NZ)).toBe("Thu 16");
    expect(formatClubWeekdayDay(cd("2026-04-06"), NZ)).toBe("Mon 6");
    expect(formatClubWeekdayDayMonth(cd("2026-04-16"), NZ)).toBe("Thu, 16 Apr");
    expect(formatClubLongWeekdayDayMonth(cd("2026-04-16"), NZ)).toBe(
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
    const oldWeekday = new Intl.DateTimeFormat(RETIRED_LOCALE, {
      timeZone: RETIRED_ZONE,
      weekday: "short",
    });
    const oldShort = new Intl.DateTimeFormat(RETIRED_LOCALE, {
      timeZone: RETIRED_ZONE,
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    const oldLong = new Intl.DateTimeFormat(RETIRED_LOCALE, {
      timeZone: RETIRED_ZONE,
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    let date = cd("2026-01-01");
    for (let step = 0; step < 400; step += 1) {
      const encoded = new Date(`${date}T00:00:00Z`);
      expect(formatClubWeekday(date, NZ), date).toBe(oldWeekday.format(encoded));
      expect(formatClubWeekdayDay(date, NZ), date).toBe(
        `${oldWeekday.format(encoded)} ${encoded.getUTCDate()}`,
      );
      expect(formatClubWeekdayDayMonth(date, NZ), date).toBe(oldShort.format(encoded));
      expect(formatClubLongWeekdayDayMonth(date, NZ), date).toBe(
        oldLong.format(encoded),
      );
      date = addCalendarDays(date, 1);
    }
  });

  it("is identical under both host timezones", () => {
    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () => [
        formatClubDate(cd("2026-04-16"), NZ),
        formatClubLongDate(cd("2026-04-16"), NZ),
        formatClubMonthYear(cd("2026-04-16"), NZ),
        formatClubWeekdayDate(cd("2026-04-16"), NZ),
        formatClubWeekdayDay(cd("2026-04-16"), NZ),
        formatClubWeekdayDayMonth(cd("2026-04-16"), NZ),
        formatClubLongWeekdayDayMonth(cd("2026-04-16"), NZ),
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
      expect(formatClubDate(cd(day), NZ).slice(-4)).toBe(day.slice(0, 4));
      expect(formatClubWeekdayDay(cd(day), NZ)).toContain(
        String(Number(day.slice(8, 10))),
      );
    }
  });
});

describe("#3566: the two stamps the stray formatters held, byte for byte", () => {
  /*
    `compactDateTime` retired TWO identical local formatters — the stuck-states
    "generated at" stamp (built from `APP_LOCALE`) and the health dashboard's
    (built from the recorded locale) — and `dateTimeSeconds` retired the audit
    log's. Their options are transcribed here by hand, for the reason the six
    originals are: importing them would compare the kernel with itself.
  */
  const compact = new Intl.DateTimeFormat(RETIRED_LOCALE, {
    timeZone: RETIRED_ZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const withSeconds = new Intl.DateTimeFormat(RETIRED_LOCALE, {
    timeZone: RETIRED_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

  it("reproduces both over 400 instants", () => {
    let day = cd("2026-01-01");
    for (let step = 0; step < 400; step += 1) {
      const instant = new Date(`${day}T02:30:07.000Z`);
      expect(formatClubInstantCompactDateTime(instant, AUCKLAND, NZ), day).toBe(
        compact.format(instant),
      );
      expect(formatClubInstantDateTimeWithSeconds(instant, AUCKLAND, NZ), day).toBe(
        withSeconds.format(instant),
      );
      day = addCalendarDays(day, 1);
    }
  });

  it("are two new shapes, not a re-spelling of an existing one", () => {
    const stamps = new Set([
      formatClubInstantCompactDateTime(INSTANT, AUCKLAND, NZ),
      formatClubInstantDateTimeWithSeconds(INSTANT, AUCKLAND, NZ),
      formatClubInstantDateTime(INSTANT, AUCKLAND, NZ),
    ]);
    expect(stamps.size).toBe(3);
  });
});

/**
 * THE LOCALE IS LOAD-BEARING (#3566). Every assertion above would pass just as
 * happily if the kernel ignored `format` and read `APP_LOCALE` again, because on
 * the shipped defaults the two agree. This sweep is the one that fails then: it
 * renders every shape for de-CH, compares it with a de-CH transcription, and
 * requires the answer to differ from en-NZ.
 *
 * MUTATION-PROVEN when written: putting `APP_LOCALE` back into
 * `club-time/intl.ts`'s `displayFormatter` made the de-CH sweep fail on its
 * first instant, and restoring it cleared the failure.
 */
describe("#3566: a club on another locale reads its dates in that locale", () => {
  const INSTANT_SHAPES = [
    ["date", formatClubInstantDate],
    ["dateTime", formatClubInstantDateTime],
    ["longDate", formatClubInstantLongDate],
    ["time", formatClubInstantTime],
    ["monthYear", formatClubInstantMonthYear],
    ["weekdayDate", formatClubInstantWeekdayDate],
    ["dayMonth", formatClubInstantDayMonth],
    ["weekdayDayMonth", formatClubInstantWeekdayDayMonth],
    ["compactDateTime", formatClubInstantCompactDateTime],
    ["dateTimeSeconds", formatClubInstantDateTimeWithSeconds],
  ] as const;
  const CALENDAR_SHAPES = [
    ["date", formatClubDate],
    ["longDate", formatClubLongDate],
    ["monthYear", formatClubMonthYear],
    ["shortMonthYear", formatClubShortMonthYear],
    ["shortMonth", formatClubShortMonth],
    ["weekdayDate", formatClubWeekdayDate],
    ["weekday", formatClubWeekday],
    ["longWeekday", formatClubLongWeekday],
    ["dayMonth", formatClubDayMonth],
    ["weekdayDayMonth", formatClubWeekdayDayMonth],
    ["longWeekdayDayMonth", formatClubLongWeekdayDayMonth],
    ["longWeekdayDate", formatClubLongWeekdayDate],
  ] as const;

  it("renders every instant shape as de-CH writes it, over 400 instants", () => {
    let day = cd("2026-01-01");
    for (let step = 0; step < 400; step += 1) {
      const instant = new Date(`${day}T02:30:07.000Z`);
      for (const [shape, render] of INSTANT_SHAPES) {
        // The reference is a de-CH `Intl` built HERE from the declared options,
        // not the kernel: the options themselves are pinned against the
        // retired en-NZ transcriptions above, so what this compares is the
        // locale plumbing, and a kernel that ignored `format` fails it.
        expect(render(instant, AUCKLAND, CH), `${shape} ${day}`).toBe(
          new Intl.DateTimeFormat("de-CH", {
            timeZone: RETIRED_ZONE,
            ...HOUSE_SHAPES[shape],
          }).format(instant),
        );
      }
      day = addCalendarDays(day, 1);
    }
    // And the de-CH answer is really de-CH, not the default under another name.
    expect(formatClubInstantDate(INSTANT, AUCKLAND, CH)).toBe(
      new Intl.DateTimeFormat("de-CH", {
        timeZone: RETIRED_ZONE,
        dateStyle: "medium",
      }).format(INSTANT),
    );
    expect(formatClubInstantTime(INSTANT, AUCKLAND, CH)).toBe("14:30");
  });

  it("differs from en-NZ for every shape", () => {
    // MARCH, deliberately: "April" is spelled the same in German and English,
    // so an April sweep would let the month-only shapes pass vacuously.
    // "März" / "Mär." and a Monday ("Montag" / "Mo.") differ in every shape.
    const march = new Date("2026-03-16T02:30:07.000Z");
    for (const [shape, render] of INSTANT_SHAPES) {
      expect(render(march, AUCKLAND, CH), shape).not.toBe(
        render(march, AUCKLAND, NZ),
      );
    }
    for (const [shape, render] of CALENDAR_SHAPES) {
      const day = cd("2026-03-16");
      expect(render(day, CH), shape).not.toBe(render(day, NZ));
    }
  });

  it("renders every calendar shape as de-CH writes it, with no zone", () => {
    const transcribe = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("de-CH", { timeZone: "UTC", ...options });
    const day = cd("2026-04-16");
    const encoded = new Date(`${day}T00:00:00.000Z`);
    expect(formatClubDate(day, CH)).toBe(
      transcribe({ dateStyle: "medium" }).format(encoded),
    );
    expect(formatClubLongWeekdayDate(day, CH)).toBe(
      transcribe({
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(encoded),
    );
    for (const [shape, render] of CALENDAR_SHAPES) {
      expect(render(day, CH), shape).toBe(
        transcribe(HOUSE_SHAPES[shape]).format(encoded),
      );
    }
  });

  it("keeps the memo keyed on the LOCALE, not only on the zone and shape", () => {
    // The first locale asked for must not win for the life of the process.
    const nz = formatClubInstantDateTime(INSTANT, AUCKLAND, NZ);
    const ch = formatClubInstantDateTime(INSTANT, AUCKLAND, CH);
    const nzAgain = formatClubInstantDateTime(INSTANT, AUCKLAND, NZ);
    expect(ch).not.toBe(nz);
    expect(nzAgain).toBe(nz);
    expect(formatClubDate(cd("2026-04-16"), CH)).not.toBe(
      formatClubDate(cd("2026-04-16"), NZ),
    );
  });

  it("refuses a format with no locale rather than rendering in the host's", () => {
    // Type-checks only through a cast — the partial object an untyped boundary
    // could hand in. `new Intl.DateTimeFormat(undefined, …)` would not throw.
    const noLocale = {} as unknown as ClubDateFormat;
    expect(() => formatClubInstantDate(INSTANT, AUCKLAND, noLocale)).toThrow(
      /INV-CONFIG-006.*locale/,
    );
    expect(() => formatClubDate(cd("2026-04-16"), { locale: " " })).toThrow(
      /locale/,
    );
    // And nothing bad was memoised by the refusals.
    expect(formatClubInstantDate(INSTANT, AUCKLAND, NZ)).toBe("16 Apr 2026");
  });
});

describe("#3566: the bound API carries the format", () => {
  it("delegates every bound rendering to its explicit counterpart, per locale", () => {
    for (const format of [NZ, CH]) {
      const bound = bindClubTime(AUCKLAND, format);
      expect(bound.format).toEqual({ locale: format.locale });
      expect(bound.instantDate(INSTANT)).toBe(
        formatClubInstantDate(INSTANT, AUCKLAND, format),
      );
      expect(bound.instantDateTime(INSTANT)).toBe(
        formatClubInstantDateTime(INSTANT, AUCKLAND, format),
      );
      expect(bound.instantLongDate(INSTANT)).toBe(
        formatClubInstantLongDate(INSTANT, AUCKLAND, format),
      );
      expect(bound.instantTime(INSTANT)).toBe(
        formatClubInstantTime(INSTANT, AUCKLAND, format),
      );
      expect(bound.instantMonthYear(INSTANT)).toBe(
        formatClubInstantMonthYear(INSTANT, AUCKLAND, format),
      );
      expect(bound.instantWeekdayDate(INSTANT)).toBe(
        formatClubInstantWeekdayDate(INSTANT, AUCKLAND, format),
      );
    }
  });

  it("copies the locale down rather than keeping the caller's object", () => {
    // A `ClubFormat` carries the currency too, which no date depends on; and a
    // caller mutating the object it handed in must not re-price the binding.
    const handed = { currencyCode: "NZD", locale: "en-NZ" };
    const bound = bindClubTime(AUCKLAND, handed);
    handed.locale = "de-CH";
    expect(bound.format).toEqual({ locale: "en-NZ" });
    expect(Object.isFrozen(bound.format)).toBe(true);
  });
});

/**
 * THE FORMAT IS REQUIRED, AT THE TYPE LEVEL (#3566, owner decision 1): no
 * one-argument overload and no ambient default, the shape the money kernel took
 * in #3565. Each line below MUST fail to type-check; `@ts-expect-error` makes the
 * failure the passing state and turns a re-added optional parameter into a
 * compile error (TS2578, unused directive) under `tsc -p tsconfig.test.json`.
 *
 * MUTATION-PROVEN when written: widening `formatClubDate`'s `format` to
 * `format?: ClubDateFormat` made its directive here report TS2578 "Unused
 * '@ts-expect-error' directive", and restoring it cleared the error.
 */
describe("#3566: the format argument is required, and the compiler is the census", () => {
  it("refuses every spelling without the club's format", () => {
    const day = cd("2026-04-16");
    const calls: Array<() => unknown> = [
      // @ts-expect-error — formatClubDate(date) has no one-argument form (#3566)
      () => formatClubDate(day),
      // @ts-expect-error — formatClubLongDate(date) has no one-argument form (#3566)
      () => formatClubLongDate(day),
      // @ts-expect-error — formatClubMonthYear(date) has no one-argument form (#3566)
      () => formatClubMonthYear(day),
      // @ts-expect-error — formatClubShortMonthYear(date) has no one-argument form (#3566)
      () => formatClubShortMonthYear(day),
      // @ts-expect-error — formatClubShortMonth(date) has no one-argument form (#3566)
      () => formatClubShortMonth(day),
      // @ts-expect-error — formatClubWeekdayDate(date) has no one-argument form (#3566)
      () => formatClubWeekdayDate(day),
      // @ts-expect-error — formatClubWeekday(date) has no one-argument form (#3566)
      () => formatClubWeekday(day),
      // @ts-expect-error — formatClubLongWeekday(date) has no one-argument form (#3566)
      () => formatClubLongWeekday(day),
      // @ts-expect-error — formatClubDayMonth(date) has no one-argument form (#3566)
      () => formatClubDayMonth(day),
      // @ts-expect-error — formatClubWeekdayDay(date) has no one-argument form (#3566)
      () => formatClubWeekdayDay(day),
      // @ts-expect-error — formatClubWeekdayDayMonth(date) has no one-argument form (#3566)
      () => formatClubWeekdayDayMonth(day),
      // @ts-expect-error — formatClubLongWeekdayDayMonth(date) has no one-argument form (#3566)
      () => formatClubLongWeekdayDayMonth(day),
      // @ts-expect-error — formatClubLongWeekdayDate(date) has no one-argument form (#3566)
      () => formatClubLongWeekdayDate(day),
      // @ts-expect-error — formatStayDate(value) has no one-argument form (#3566)
      () => formatStayDate("2026-04-16"),
      // @ts-expect-error — formatStayDateOrNull(value) has no one-argument form (#3566)
      () => formatStayDateOrNull("2026-04-16"),
      // @ts-expect-error — formatClubInstantDate(instant, zone) needs the format (#3566)
      () => formatClubInstantDate(INSTANT, AUCKLAND),
      // @ts-expect-error — formatClubInstantDateTime(instant, zone) needs the format (#3566)
      () => formatClubInstantDateTime(INSTANT, AUCKLAND),
      // @ts-expect-error — formatClubInstantLongDate(instant, zone) needs the format (#3566)
      () => formatClubInstantLongDate(INSTANT, AUCKLAND),
      // @ts-expect-error — formatClubInstantTime(instant, zone) needs the format (#3566)
      () => formatClubInstantTime(INSTANT, AUCKLAND),
      // @ts-expect-error — formatClubInstantMonthYear(instant, zone) needs the format (#3566)
      () => formatClubInstantMonthYear(INSTANT, AUCKLAND),
      // @ts-expect-error — formatClubInstantWeekdayDate(instant, zone) needs the format (#3566)
      () => formatClubInstantWeekdayDate(INSTANT, AUCKLAND),
      // @ts-expect-error — formatClubInstantDayMonth(instant, zone) needs the format (#3566)
      () => formatClubInstantDayMonth(INSTANT, AUCKLAND),
      // @ts-expect-error — formatClubInstantWeekdayDayMonth(instant, zone) needs the format (#3566)
      () => formatClubInstantWeekdayDayMonth(INSTANT, AUCKLAND),
      // @ts-expect-error — formatClubInstantCompactDateTime(instant, zone) needs the format (#3566)
      () => formatClubInstantCompactDateTime(INSTANT, AUCKLAND),
      // @ts-expect-error — formatClubInstantDateTimeWithSeconds(instant, zone) needs the format (#3566)
      () => formatClubInstantDateTimeWithSeconds(INSTANT, AUCKLAND),
      // @ts-expect-error — formatHouseShape(shape, instant, zone) needs the format (#3566)
      () => formatHouseShape("date", INSTANT, AUCKLAND),
      // @ts-expect-error — formatCalendarDateShape(shape, date) needs the format (#3566)
      () => formatCalendarDateShape("date", day),
      // @ts-expect-error — bindClubTime(zone) has no one-argument form (#3566)
      () => bindClubTime(AUCKLAND),
    ];
    // The directives are the assertion; the closures are never called.
    expect(calls).toHaveLength(28);
  });
});
