import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_TIME_ZONE } from "@/config/operational";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatCalendarDayOnly,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  getTodayDateOnly,
  isDateOnlyString,
  endOfDateOnlyForTimeZone,
  parseDateOnly,
  startOfDateOnlyForTimeZone,
  todayDateOnlyForTimeZone,
} from "@/lib/date-only";

describe("date-only helpers", () => {
  it("parses a date-only string as UTC midnight", () => {
    expect(parseDateOnly("2026-04-16").toISOString()).toBe(
      "2026-04-16T00:00:00.000Z"
    );
  });

  it("formats Prisma-style date-only values without timezone drift", () => {
    expect(formatDateOnly(new Date("2026-04-16T00:00:00.000Z"))).toBe(
      "2026-04-16"
    );
  });

  it("builds a lodge-night key from calendar parts (0-based month), zero-padded", () => {
    // #2474: the canonical client encoding of a lodge night. A pure function of
    // its integer parts, so it carries no browser-timezone dependency at all —
    // the property the whole migration turns on.
    expect(formatCalendarDayOnly(2026, 3, 30)).toBe("2026-04-30");
    expect(formatCalendarDayOnly(2026, 0, 1)).toBe("2026-01-01");
    expect(formatCalendarDayOnly(2026, 11, 9)).toBe("2026-12-09");
  });

  it("formats instants as New Zealand date-only values", () => {
    expect(
      formatDateOnlyForTimeZone(
        new Date("2026-04-29T12:00:00.000Z"),
        "Pacific/Auckland"
      )
    ).toBe("2026-04-30");
  });

  it("builds exact New Zealand calendar day boundaries", () => {
    expect(
      startOfDateOnlyForTimeZone("2026-04-30", "Pacific/Auckland").toISOString()
    ).toBe("2026-04-29T12:00:00.000Z");
    expect(
      endOfDateOnlyForTimeZone("2026-04-30", "Pacific/Auckland").toISOString()
    ).toBe("2026-04-30T11:59:59.999Z");
  });

  it("stays LOUD for the one day whose next day does not exist (#2990)", () => {
    /*
      `/admin/audit-log?to=9999-12-31` really reaches here: that route validates
      `to` with a bare `YYYY-MM-DD` regex, and `9999-12-31` passes it. The
      exclusive end of that day falls in the year 10000, which no `CalendarDate`
      can hold, so the kernel refuses.

      An Invalid Date is what this helper has always returned for an input it
      cannot answer, and what it returned for this input before CT-2 — Prisma
      then refuses to serialise it and the operator sees the query fail. The
      alternative, briefly live on this branch, was an upper bound in the YEAR
      999: the audit log came back EMPTY while the filter still said
      "to 9999-12-31", which is the worst of the three answers because nothing
      says anything is wrong.
    */
    expect(
      Number.isNaN(endOfDateOnlyForTimeZone("9999-12-31", "Pacific/Auckland").getTime()),
    ).toBe(true);
    // And it is the LAST day that is special, not the neighbourhood.
    expect(
      endOfDateOnlyForTimeZone("9999-12-30", "Pacific/Auckland").toISOString(),
    ).toBe("9999-12-30T10:59:59.999Z");
    // The inclusive lower bound of that same last day still answers normally.
    expect(
      startOfDateOnlyForTimeZone("9999-12-31", "Pacific/Auckland").toISOString(),
    ).toBe("9999-12-30T11:00:00.000Z");
  });

  it("adds days in UTC so lodge dates stay aligned with @db.Date values", () => {
    expect(
      addDaysDateOnly(parseDateOnly("2026-04-16"), 1).toISOString()
    ).toBe("2026-04-17T00:00:00.000Z");
  });

  it("iterates date-only ranges without dropping the last day of the month", () => {
    const dates = eachDateOnlyInRange(
      parseDateOnly("2026-04-01"),
      parseDateOnly("2026-05-01")
    ).map(formatDateOnly);

    expect(dates).toHaveLength(30);
    expect(dates[0]).toBe("2026-04-01");
    expect(dates.at(-1)).toBe("2026-04-30");
    expect(dates).not.toContain("2026-03-31");
  });

  it("derives today's NZ date as a date-only value", () => {
    expect(formatDateOnly(getTodayDateOnly("Pacific/Auckland"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
  });

  it("rejects impossible or malformed date-only strings", () => {
    expect(isDateOnlyString("not-a-date")).toBe(false);
    expect(isDateOnlyString("2026-02-31")).toBe(false);
    expect(Number.isNaN(parseDateOnly("2026-02-31").getTime())).toBe(true);
  });
});

// Regression coverage for issue #1878 (finding F8): the removed NZST
// "today"/"tomorrow" helpers built `new Date(`${y}-${m}-${d}T00:00:00`)`
// — no timezone suffix, so the string parsed in the server's LOCAL zone. Under
// the production TZ=Pacific/Auckland pin that instant is NZ-local midnight,
// which is still the PREVIOUS calendar day in UTC — the value every Prisma
// @db.Date comparison actually sees. Crons must instead use the date-only
// helper family, which pins the NZ calendar date to UTC midnight.
describe("NZ cron date boundary (#1878)", () => {
  const nzIntlDate = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Pacific/Auckland",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

  it("getTodayDateOnly serializes to the Intl-derived NZ calendar date, not the previous UTC day", () => {
    // Capture the NZ date before and after the call so the assertion stays
    // deterministic even if NZ midnight rolls over mid-test.
    const nzBefore = nzIntlDate();
    const today = getTodayDateOnly("Pacific/Auckland");
    const nzAfter = nzIntlDate();

    expect([nzBefore, nzAfter]).toContain(today.toISOString().slice(0, 10));
    // Prisma derives the @db.Date comparand from the UTC date part, so the
    // helper must sit exactly at UTC midnight of that NZ calendar date.
    expect(today.toISOString().slice(10)).toBe("T00:00:00.000Z");
  });

  it("addDaysDateOnly(getTodayDateOnly(), 1) is UTC midnight of the next NZ calendar date", () => {
    const today = getTodayDateOnly("Pacific/Auckland");
    const tomorrow = addDaysDateOnly(today, 1);

    expect(tomorrow.getTime() - today.getTime()).toBe(86_400_000);
    expect(tomorrow.toISOString().slice(10)).toBe("T00:00:00.000Z");
    expect(formatDateOnly(tomorrow)).toBe(
      formatDateOnly(addDaysDateOnly(parseDateOnly(formatDateOnly(today)), 1))
    );
  });

  it("documents the removed construction's shift: NZ-local midnight is the previous UTC day", () => {
    // The old helper produced NZ-local midnight under the production TZ pin.
    // That instant, expressed deterministically via startOfDateOnlyForTimeZone,
    // serializes one day earlier than the NZ calendar date it represents:
    const nzLocalMidnight = startOfDateOnlyForTimeZone(
      "2026-07-08",
      "Pacific/Auckland"
    );
    expect(nzLocalMidnight.toISOString()).toBe("2026-07-07T12:00:00.000Z");
    expect(nzLocalMidnight.toISOString().slice(0, 10)).toBe("2026-07-07");
    // The date-only family keeps the same calendar day at UTC midnight.
    expect(parseDateOnly("2026-07-08").toISOString()).toBe(
      "2026-07-08T00:00:00.000Z"
    );
  });
});

describe("todayDateOnlyForTimeZone", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the NZ (NZST) calendar date after NZ midnight even when UTC is still the previous day", () => {
    // 2026-07-07T13:00:00Z is 2026-07-08 01:00 in Pacific/Auckland (NZST, +12),
    // so a UTC (or any browser trailing NZ) clock would report 2026-07-07.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T13:00:00.000Z"));

    expect(todayDateOnlyForTimeZone("Pacific/Auckland")).toBe("2026-07-08");
    // Sanity: the naive browser/UTC seed would have produced the earlier day.
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-07");
  });

  it("honours NZDT (daylight saving, +13) when deriving the club date", () => {
    // 2026-01-05T11:30:00Z is 2026-01-06 00:30 in Pacific/Auckland (NZDT, +13).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T11:30:00.000Z"));

    expect(todayDateOnlyForTimeZone("Pacific/Auckland")).toBe("2026-01-06");
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-01-05");
  });

  it("keeps the shared UTC calendar day when NZ has not yet rolled over", () => {
    // 2026-07-07T09:00:00Z is 2026-07-07 21:00 in Pacific/Auckland: same day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T09:00:00.000Z"));

    expect(todayDateOnlyForTimeZone("Pacific/Auckland")).toBe("2026-07-07");
  });

  it("derives a valid date-only string for the environment's configured zone", () => {
    // This case used to exercise the helper's DEFAULT argument. #3123 deletes
    // that default so an unnamed zone becomes a compile error, and
    // `APP_TIME_ZONE` is what the default resolved to — so it is named here.
    // It still resolves from the ambient TZ env, so the assertion is on the
    // SHAPE rather than on a specific zone, to stay robust across CI clock
    // configurations. The club-zone answers are pinned by the three cases
    // above; this one is only about the environment fallback.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T13:00:00.000Z"));

    expect(todayDateOnlyForTimeZone(APP_TIME_ZONE)).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
  });
});

// The lodge-night identity that #2474 pins across every browser zone lives in
// `booking-calendar-timezone.test.tsx` (the migrated component surface). The
// `localCalendarDayToDateOnly` bridge these tests used to cover was deleted with
// the local-midnight encoding it existed to patch.
