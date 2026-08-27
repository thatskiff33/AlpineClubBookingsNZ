import { describe, expect, it } from "vitest";

import { requireClubTimeZone } from "@/lib/club-time";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  getBookingInvoiceDueDate,
  getBookingInvoiceIssueDate,
} from "@/lib/xero-invoice-helpers";

/**
 * `Booking.createdAt` is a `DateTime` instant; `Booking.checkIn` is a `@db.Date`
 * lodge night. The two need opposite treatment, and treating them the same way
 * was the defect (#2697): a booking made in the New Zealand morning falls on the
 * PREVIOUS UTC day, so Xero received a due date one day early (INV-DATE-019).
 *
 * The instants below are chosen so that a wrong zone FAILS them. A merely
 * "divergent" instant is not enough — 21:30Z sits ~9.5h into a 12h window, so it
 * passes under any zone from about UTC+10 upwards, including zones with no
 * daylight saving at all.
 *
 * WHAT CT-5 (#2869) CHANGED HERE, and why the suite is stronger for it. The club
 * zone used to arrive through `APP_TIME_ZONE`, so this file opened with a
 * premise guard asserting `APP_TIME_ZONE === "Pacific/Auckland"` — a check that
 * only ever failed when somebody set `TZ`, and nothing in this repository or on
 * CI ever does. The zone is now an ARGUMENT, so the club's zone is stated in the
 * test and the host's is varied around it: every case below runs under three
 * host zones and must give one answer.
 */
const CLUB_ZONE = requireClubTimeZone("Pacific/Auckland");

/** Host zones the same assertion must survive. */
const HOST_ZONES = ["UTC", "America/Denver", "Pacific/Auckland"];

function onEveryHostZone(assert: () => void): void {
  for (const hostZone of HOST_ZONES) {
    withTimeZone(hostZone, assert);
  }
}

describe("getBookingInvoiceDueDate", () => {
  it("dates the first instant of a club day to that club day (NZST, UTC+12)", () => {
    // 2026-06-15 00:00:00 in Pacific/Auckland — the very start of the club day,
    // while UTC is still on the 14th. A zone shallower than +12 (Brisbane, +10)
    // returns 2026-06-14 and fails, so this pins the offset, not merely "ahead".
    const createdAt = new Date("2026-06-14T12:00:00.000Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-06-14");
    onEveryHostZone(() =>
      expect(getBookingInvoiceDueDate({ createdAt }, CLUB_ZONE)).toBe("2026-06-15"),
    );
  });

  it("dates the last divergent instant of a club day to that club day", () => {
    // 2026-06-15 11:59:59.999 NZST — the last moment before UTC catches up.
    const createdAt = new Date("2026-06-14T23:59:59.999Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-06-14");
    onEveryHostZone(() =>
      expect(getBookingInvoiceDueDate({ createdAt }, CLUB_ZONE)).toBe("2026-06-15"),
    );
  });

  it("is unchanged at the first instant where both calendars agree", () => {
    // 2026-06-15 12:00 NZST — UTC has rolled over to the 15th too.
    const createdAt = new Date("2026-06-15T00:00:00.000Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-06-15");
    onEveryHostZone(() =>
      expect(getBookingInvoiceDueDate({ createdAt }, CLUB_ZONE)).toBe("2026-06-15"),
    );
  });

  it("proves the daylight-saving offset, not merely a positive one (NZDT, UTC+13)", () => {
    // 2026-01-15 00:30 in Pacific/Auckland, which is UTC+13 in January. A fixed
    // +12 zone with no daylight saving returns 2026-01-14 and fails, so this
    // test genuinely pins NZDT rather than passing anywhere east of UTC.
    const createdAt = new Date("2026-01-14T11:30:00.000Z");

    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-01-14");
    onEveryHostZone(() =>
      expect(getBookingInvoiceDueDate({ createdAt }, CLUB_ZONE)).toBe("2026-01-15"),
    );
  });

  it("accepts a serialised instant as well as a Date", () => {
    expect(
      getBookingInvoiceDueDate({ createdAt: "2026-06-14T12:00:00.000Z" }, CLUB_ZONE),
    ).toBe("2026-06-15");
  });
});

describe("getBookingInvoiceIssueDate", () => {
  // These are round-trip tests, not guards: a UTC-midnight value read in a zone
  // AHEAD of UTC gives the same calendar day either way, so they would also pass
  // if this helper were (wrongly) routed through the club zone. The test that
  // actually discriminates the two receivers lives in
  // xero-invoice-helpers-zone-behind-utc.test.ts, which puts the club behind UTC.
  it("reads a date-only lodge night back as the day it encodes", () => {
    onEveryHostZone(() =>
      expect(
        getBookingInvoiceIssueDate({ checkIn: new Date("2026-06-15T00:00:00.000Z") }),
      ).toBe("2026-06-15"),
    );
  });

  it("reads a date-only lodge night back the same way in the NZDT half of the year", () => {
    onEveryHostZone(() =>
      expect(
        getBookingInvoiceIssueDate({ checkIn: new Date("2026-01-15T00:00:00.000Z") }),
      ).toBe("2026-01-15"),
    );
  });
});
