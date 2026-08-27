import { describe, expect, it } from "vitest";

import { requireClubTimeZone } from "@/lib/club-time";
import { seasonYearOfCalendarDate } from "@/lib/financial-year";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  classifyXeroWireTemporal,
  xeroCalendarDate,
  xeroCalendarDateAsDateOnly,
  xeroCalendarDateText,
  xeroDocumentDateForClubToday,
  xeroDocumentDateFromDateOnlyColumn,
  xeroDocumentDateFromInstant,
  xeroDocumentDatesFromColumnAndInstant,
  xeroInstant,
} from "@/lib/xero-provider-dates";

/**
 * The Xero temporal boundary (CT-5, #2869).
 *
 * THE POINT OF THIS SUITE, in one sentence: one Xero field, four wire shapes,
 * three host zones — twelve readings that must all be the same calendar day.
 *
 * The defect it exists to prevent is not hypothetical. `Invoice.date` is TYPED
 * `string` by `xero-node` and is a `Date` at runtime whenever the classic
 * Accounting API answers with Microsoft-JSON, so `new Date(invoice.date)` was
 * correct for one shape and wrong for another — and for the offset-less
 * `"2019-03-11T00:00:00"` shape it resolved in the SERVER's zone, which under
 * the `TZ=Pacific/Auckland` pin in the Dockerfile stored `Member.joinedDate` a
 * day early.
 *
 * EVERY ASSERTION RUNS UNDER THREE HOST ZONES, one behind UTC and one ahead, so
 * a reading that quietly depends on the container cannot pass. A suite pinned
 * only to this machine's zone would have passed against the defective code.
 */

/** One zone behind UTC, one ahead, and UTC itself. */
const HOST_ZONES = ["UTC", "America/Denver", "Pacific/Auckland"];

function onEveryHostZone(assert: (hostZone: string) => void): void {
  for (const hostZone of HOST_ZONES) {
    withTimeZone(hostZone, () => assert(hostZone));
  }
}

/**
 * The four shapes Xero can send for ONE date-only field, all naming 11 March
 * 2019. `/Date(1552262400000+0000)/` is that day's UTC midnight in epoch
 * milliseconds, which is how the classic Accounting API encodes a date-only
 * value; the SDK turns the same payload into the `Date` above it.
 */
const ELEVENTH_OF_MARCH = [
  ["a plain calendar date", "2019-03-11", "calendar-date"],
  ["an offset-less date-time", "2019-03-11T00:00:00", "offset-less-date-time"],
  ["an offset-bearing instant", "2019-03-11T00:00:00Z", "offset-bearing-instant"],
  ["a Microsoft-JSON string", "/Date(1552262400000+0000)/", "microsoft-json"],
  ["a Date the SDK built", new Date("2019-03-11T00:00:00.000Z"), "sdk-date"],
] as const;

describe("classifyXeroWireTemporal", () => {
  it.each(ELEVENTH_OF_MARCH)("names %s", (_label, value, shape) => {
    onEveryHostZone(() => expect(classifyXeroWireTemporal(value)).toBe(shape));
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("names %s absent", (_label, value) => {
    expect(classifyXeroWireTemporal(value)).toBe("absent");
  });

  it.each([
    ["a name", "not-a-date"],
    ["an Invalid Date", new Date(Number.NaN)],
    ["an object", { date: "2019-03-11" }],
    ["a boolean", true],
  ])("names %s unreadable", (_label, value) => {
    expect(classifyXeroWireTemporal(value)).toBe("unreadable");
  });
});

describe("a Xero date-only field", () => {
  it.each(ELEVENTH_OF_MARCH)(
    "reads %s as the same calendar day on every host zone",
    (label, value) => {
      onEveryHostZone((hostZone) =>
        expect(xeroCalendarDate(value), `${label} read on ${hostZone}`).toBe(
          "2019-03-11",
        ),
      );
    },
  );

  it.each(ELEVENTH_OF_MARCH)(
    "crosses a JSON boundary as exactly ten characters, from %s",
    (label, value) => {
      onEveryHostZone((hostZone) =>
        expect(xeroCalendarDateText(value), `${label} on ${hostZone}`).toBe(
          "2019-03-11",
        ),
      );
    },
  );

  it.each(ELEVENTH_OF_MARCH)(
    "encodes to UTC midnight for a date-only column, from %s",
    (label, value) => {
      onEveryHostZone((hostZone) =>
        expect(
          xeroCalendarDateAsDateOnly(value)?.toISOString(),
          `${label} on ${hostZone}`,
        ).toBe("2019-03-11T00:00:00.000Z"),
      );
    },
  );

  // THE ANCHOR CASE. Under `TZ=Pacific/Auckland` the old `new Date(...)` read
  // this exact string as 2019-03-10T11:00:00Z, so the calendar day it stored
  // was the 10th. The assertion is the day, not the instant, because the day is
  // what the field means.
  it("does not resolve an offset-less date-time in the host's zone", () => {
    withTimeZone("Pacific/Auckland", () => {
      expect(new Date("2019-03-11T00:00:00").toISOString().slice(0, 10)).toBe(
        "2019-03-10",
      );
      expect(xeroCalendarDate("2019-03-11T00:00:00")).toBe("2019-03-11");
    });
  });

  it.each([
    ["a day that does not exist", "2019-02-30"],
    ["a US-ordered date", "03/11/2019"],
    ["a name", "not-a-date"],
    ["an Invalid Date", new Date(Number.NaN)],
    ["nothing at all", null],
  ])("refuses %s rather than inventing a day", (_label, value) => {
    expect(xeroCalendarDate(value)).toBeNull();
    expect(xeroCalendarDateAsDateOnly(value)).toBeNull();
  });

  // `new Date("2019-02-30")` is 2 March. A provider typo must not become a real,
  // plausible, WRONG day two days later with nothing to notice.
  it("does not roll an impossible day forward the way new Date does", () => {
    expect(new Date("2019-02-30T00:00:00Z").toISOString().slice(0, 10)).toBe(
      "2019-03-02",
    );
    expect(xeroCalendarDate("2019-02-30")).toBeNull();
  });
});

describe("a Xero instant field", () => {
  it("keeps an offset-bearing instant exactly", () => {
    onEveryHostZone(() =>
      expect(xeroInstant("2019-03-11T20:12:34.567Z")?.toISOString()).toBe(
        "2019-03-11T20:12:34.567Z",
      ),
    );
  });

  // `updatedDateUTC` is named and documented by the provider as UTC, so an
  // offset-less value is read AS UTC — the zone comes from the field's own
  // contract, which is the classification the epic asks each integration to do.
  // The kernel's `parseInstant` refuses this shape precisely because it has no
  // field to consult.
  it("reads an offset-less UTC-named timestamp as UTC, not as the host's clock", () => {
    onEveryHostZone((hostZone) =>
      expect(
        xeroInstant("2019-03-11T20:12:34")?.toISOString(),
        `read on ${hostZone}`,
      ).toBe("2019-03-11T20:12:34.000Z"),
    );
  });

  it("keeps the millisecond a Date-to-string round trip would drop", () => {
    const provider = new Date("2019-03-11T20:12:34.567Z");
    expect(xeroInstant(provider)?.getTime()).toBe(provider.getTime());
    // What the previous `new Date(value.toString())` did instead:
    expect(new Date(provider.toString()).getTime()).not.toBe(provider.getTime());
  });

  it("reads a Microsoft-JSON instant from its epoch", () => {
    onEveryHostZone(() =>
      expect(xeroInstant("/Date(1552335154567+1300)/")?.toISOString()).toBe(
        "2019-03-11T20:12:34.567Z",
      ),
    );
  });

  it("refuses what it cannot read", () => {
    expect(xeroInstant(null)).toBeNull();
    expect(xeroInstant("not-a-date")).toBeNull();
    expect(xeroInstant(new Date(Number.NaN))).toBeNull();
  });
});

describe("the outbound document dates", () => {
  const CLUB = requireClubTimeZone("Pacific/Auckland");
  const CLUB_BEHIND_UTC = requireClubTimeZone("America/Denver");

  it("reads a @db.Date column in UTC, because that is the encoding", () => {
    onEveryHostZone(() =>
      expect(
        xeroDocumentDateFromDateOnlyColumn(new Date("2026-04-16T00:00:00.000Z")),
      ).toBe("2026-04-16"),
    );
  });

  it("reads an instant in the club's calendar, not the host's", () => {
    // 2026-04-16T00:30Z is still 15 April in Denver and already 16 April (12:30)
    // in Auckland. The answer must follow the CLUB, whatever the container says.
    const instant = new Date("2026-04-16T00:30:00.000Z");
    onEveryHostZone((hostZone) => {
      expect(xeroDocumentDateFromInstant(instant, CLUB), hostZone).toBe(
        "2026-04-16",
      );
      expect(
        xeroDocumentDateFromInstant(instant, CLUB_BEHIND_UTC),
        hostZone,
      ).toBe("2026-04-15");
    });
  });

  // The frozen clock is 2026-07-01T00:00:00.000Z — midday in New Zealand, and
  // still 30 June in Denver. A club west of Greenwich therefore gets a
  // different "today", which is what stops this being tautological.
  it("dates 'today' by the club's calendar", () => {
    onEveryHostZone((hostZone) => {
      expect(xeroDocumentDateForClubToday(CLUB), hostZone).toBe("2026-07-01");
      expect(xeroDocumentDateForClubToday(CLUB_BEHIND_UTC), hostZone).toBe(
        "2026-06-30",
      );
    });
  });
});

describe("an invoice's issue and due dates together", () => {
  const CLUB = requireClubTimeZone("Pacific/Auckland");
  const CLUB_BEHIND_UTC = requireClubTimeZone("America/Denver");

  // THE ASYMMETRY IS THE POINT, and it is the thing a reader is most likely to
  // "tidy" away: one date takes no zone at all and the other requires one.
  // Truncating the instant to its UTC day instead is the #2834 defect — a group
  // settlement invoice raised at 09:00 NZ on 1 July carried a due date of
  // 30 June.
  it("reads the column in UTC and the instant in the club's calendar", () => {
    const checkIn = new Date("2026-04-16T00:00:00.000Z");
    const createdAt = new Date("2026-07-01T21:00:00.000Z"); // 09:00 on 2 July, NZ

    onEveryHostZone((hostZone) => {
      expect(
        xeroDocumentDatesFromColumnAndInstant(checkIn, createdAt, CLUB),
        hostZone,
      ).toEqual({ issueDate: "2026-04-16", dueDate: "2026-07-02" });
    });
  });

  it("follows the club west of Greenwich, not the container", () => {
    const checkIn = new Date("2026-04-16T00:00:00.000Z");
    const createdAt = new Date("2026-07-01T21:00:00.000Z");

    onEveryHostZone((hostZone) => {
      expect(
        xeroDocumentDatesFromColumnAndInstant(
          checkIn,
          createdAt,
          CLUB_BEHIND_UTC,
        ),
        hostZone,
      ).toEqual({ issueDate: "2026-04-16", dueDate: "2026-07-01" });
    });
  });

  it("agrees with the two single-value helpers it composes", () => {
    // So the pair cannot drift from the derivations it exists to keep together.
    const checkIn = new Date("2026-04-16T00:00:00.000Z");
    const createdAt = new Date("2026-07-01T21:00:00.000Z");

    onEveryHostZone((hostZone) => {
      expect(
        xeroDocumentDatesFromColumnAndInstant(checkIn, createdAt, CLUB),
        hostZone,
      ).toEqual({
        issueDate: xeroDocumentDateFromDateOnlyColumn(checkIn),
        dueDate: xeroDocumentDateFromInstant(createdAt, CLUB),
      });
    });
  });
});

describe("the season a Xero invoice belongs to", () => {
  // The retired `getSeasonYearForYearEndMonth` read the HOST's calendar
  // components, so handing it a Xero invoice date made the boundary move with the
  // container. This module used to carry its own `seasonYearOfCalendarDate(date,
  // seasonStartMonth)`; CT-4 group F1 (#2870) converged it onto the one in
  // `@/lib/financial-year`, whose second argument is the financial YEAR-END month.
  // Two same-named functions differing only in that argument was a silent
  // off-by-one-month waiting for the first caller to import the wrong one, so the
  // arguments here move from 4/1 (season start) to 3/12 (year end).
  it("puts the first day of a season in that season, on every host zone", () => {
    onEveryHostZone((hostZone) => {
      const first = xeroCalendarDate("2026-04-01");
      expect(first, hostZone).not.toBeNull();
      expect(seasonYearOfCalendarDate(first!, 3), hostZone).toBe(2026);
    });
  });

  it("puts the last day before a season in the previous one", () => {
    const last = xeroCalendarDate("2026-03-31");
    expect(seasonYearOfCalendarDate(last!, 3)).toBe(2025);
  });

  it("handles a January season start (a December year-end)", () => {
    expect(seasonYearOfCalendarDate(xeroCalendarDate("2026-01-01")!, 12)).toBe(2026);
    expect(seasonYearOfCalendarDate(xeroCalendarDate("2025-12-31")!, 12)).toBe(2025);
  });
});
