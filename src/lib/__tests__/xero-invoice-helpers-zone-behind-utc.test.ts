import { describe, expect, it } from "vitest";

import { requireClubTimeZone } from "@/lib/club-time";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  getBookingInvoiceDueDate,
  getBookingInvoiceIssueDate,
} from "@/lib/xero-invoice-helpers";

/**
 * The one test that can actually tell the two Xero invoice date helpers apart.
 *
 * In New Zealand — a zone AHEAD of UTC — a `@db.Date` value stored at UTC
 * midnight reads back as the same calendar day whether you truncate it or run it
 * through the club zone. So no NZ-based test can prove that
 * `getBookingInvoiceIssueDate` is deliberately NOT zone-converted; it would pass
 * just as happily if someone "tidied" it to use the club-timezone helper and
 * quietly broke the date-only contract (INV-DATE-010).
 *
 * Put the club BEHIND UTC and the two helpers diverge, which is exactly the
 * distinction #2697 turns on:
 *
 *   - `checkIn` is a lodge night. Its UTC midnight is the ENCODING of a calendar
 *     day, so it must read back as that day in every club zone.
 *   - `createdAt` is a real instant. Its calendar day is whatever the club's
 *     clock said at that moment, which in a zone behind UTC is the day before
 *     (INV-DATE-019).
 *
 * This also covers the case the repository actually ships for: it is a template
 * other clubs fork and configure, so a non-NZ club zone is a supported
 * configuration, not a hypothetical.
 *
 * CT-5 (#2869) made the club zone an ARGUMENT rather than `APP_TIME_ZONE`, so
 * this file no longer needs to mock `@/config/operational` and re-import the
 * module under a fresh registry — it states the club zone and varies the HOST's
 * around it, which is the property the epic actually promises.
 */
const CLUB_BEHIND_UTC = requireClubTimeZone("Pacific/Niue"); // UTC-11, no DST

const HOST_ZONES = ["UTC", "Pacific/Auckland", "America/Denver"];

describe("the two receivers diverge once the club zone is behind UTC", () => {
  it("keeps a date-only lodge night on the day it encodes", () => {
    for (const hostZone of HOST_ZONES) {
      withTimeZone(hostZone, () => {
        // Truncation, deliberately: the stored value MEANS 15 June, in any zone.
        expect(
          getBookingInvoiceIssueDate({ checkIn: new Date("2026-06-15T00:00:00.000Z") }),
          `read on ${hostZone}`,
        ).toBe("2026-06-15");
      });
    }
  });

  it("moves a real instant onto the club's calendar day", () => {
    for (const hostZone of HOST_ZONES) {
      withTimeZone(hostZone, () => {
        // The same wall-clock input, read as an instant: 2026-06-15T00:00Z is
        // 13:00 on 14 June in Pacific/Niue. A club there made the booking on the
        // 14th, so that is the day the invoice is due.
        expect(
          getBookingInvoiceDueDate(
            { createdAt: new Date("2026-06-15T00:00:00.000Z") },
            CLUB_BEHIND_UTC,
          ),
          `read on ${hostZone}`,
        ).toBe("2026-06-14");
      });
    }
  });
});
