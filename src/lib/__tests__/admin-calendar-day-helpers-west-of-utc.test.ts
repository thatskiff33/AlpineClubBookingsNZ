/**
 * The two admin calendar-day formatters, in a club WEST of UTC (CT-4, #2870;
 * `INV-DATE-019`, `INV-CONFIG-002`).
 *
 * ## Why a second file rather than more cases in the first one
 *
 * `admin-family-group-ui-helpers.test.ts` and `admin-member-detail-helpers.test.ts`
 * run under the shipped configuration, where the environment's zone resolved to
 * `Pacific/Auckland`. That zone cannot see the defect these helpers exist to
 * close. A `@db.Date` column holds a calendar day encoded as UTC midnight;
 * projecting that into a zone AHEAD of Greenwich lands on club midday, the SAME
 * day, so New Zealand agrees with the truth and a projection looks correct.
 * Projecting it into a zone BEHIND Greenwich lands on the previous evening and
 * names the day before.
 *
 * `member-age-west-of-utc.test.ts` is the precedent. This file used to mock the
 * environment constant `APP_TIME_ZONE` to `America/Denver`; that constant was
 * deleted in #3567 and nothing reads the environment's zone any more, so the
 * mock is gone.
 *
 * ## What each mutant does here
 *
 * Both helpers are correct today by taking no zone whatsoever:
 *
 * - reverting either helper to `formatNZDate` / `formatMemberDateNz`, which read
 *   `APP_TIME_ZONE` (since deleted), moved every assertion below back one day
 *   in a Denver deployment;
 * - passing the value through the club's bound zone — the CT-4 shape of the same
 *   mistake — does the same for any club west of Greenwich.
 *
 * ## What it costs when they are wrong
 *
 * `formatFamilyGroupCalendarDay` renders a declared date of birth on the screen
 * that APPROVES a family-group request and writes a member record. A day early
 * moves a birthday across a year boundary, and the day decides an age tier,
 * which decides a price band.
 *
 * `formatMemberCalendarDay` renders `stats.lastStay` — the `_max` of a member's
 * booking `checkOut`, a lodge night — in the member page's history preview. The
 * summary strip three lines above it decodes the same value correctly, so a
 * projection here shows one member's last stay on two different days on one
 * screen.
 */

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { describe, expect, it } from "vitest";


import { formatFamilyGroupCalendarDay } from "@/lib/admin-family-group-ui-helpers";
import {
  formatMemberCalendarDay,
  formatMemberHistoryPreview,
} from "@/lib/admin-member-detail-helpers";

/**
 * The premise, asserted rather than assumed. If this zone ever stopped being
 * behind Greenwich at these instants, every assertion below would still pass
 * while proving nothing — which is the exact failure mode this epic keeps
 * finding, so it is checked out loud instead.
 */
function dayInConfiguredZone(iso: string): string {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: "America/Denver",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

describe("the configured zone really is west of UTC at these instants", () => {
  it("reads a UTC-midnight day as the previous evening", () => {
    expect(dayInConfiguredZone("2018-01-01T00:00:00.000Z")).toBe("31 Dec 2017");
    expect(dayInConfiguredZone("2026-07-04T00:00:00.000Z")).toBe("3 Jul 2026");
  });
});

describe("formatFamilyGroupCalendarDay keeps the STORED day west of UTC", () => {
  it("renders a New Year's Day date of birth as 1 January, not 31 December", () => {
    expect(
      formatFamilyGroupCalendarDay("2018-01-01T00:00:00.000Z", CLUB_FORMAT_TEST),
      "INV-DATE-019: this is the UTC-midnight encoding of a @db.Date column. " +
        "Projecting it through the configured zone names 31 Dec 2017, which " +
        "moves a declared date of birth across a year boundary on the screen " +
        "that approves it.",
    ).toBe("1 Jan 2018");
  });

  it("renders the bare spelling of that same day identically", () => {
    expect(formatFamilyGroupCalendarDay("2018-01-01", CLUB_FORMAT_TEST)).toBe("1 Jan 2018");
  });
});

describe("formatMemberCalendarDay keeps the STORED lodge night west of UTC", () => {
  it("renders a stored check-out as its own day, not the evening before", () => {
    expect(
      formatMemberCalendarDay("2026-07-04T00:00:00.000Z", CLUB_FORMAT_TEST),
      "INV-DATE-019: `stats.lastStay` is the `_max` of a member's booking " +
        "checkOut, a @db.Date lodge night. The summary strip on the same page " +
        "decodes it as the stored day, so a projection here puts one member's " +
        "last stay on two different days three lines apart.",
    ).toBe("4 Jul 2026");
  });

  it("renders the bare spelling of that same day identically", () => {
    expect(formatMemberCalendarDay("2026-07-04", CLUB_FORMAT_TEST)).toBe("4 Jul 2026");
  });

  it("returns the caller's fallback for a value it cannot read", () => {
    // It degrades rather than throwing, because these values are fed straight
    // from an API payload into a rendered row and a throw in that position
    // blanks the whole page.
    expect(formatMemberCalendarDay("not-a-date", CLUB_FORMAT_TEST)).toBe("—");
    expect(formatMemberCalendarDay("", CLUB_FORMAT_TEST, "unknown")).toBe("unknown");
  });

  it("carries through to the member page's history preview line", () => {
    // The call site the straddle was actually on: the preview and the summary
    // strip render the same `stats.lastStay`.
    expect(
      formatMemberHistoryPreview({
        totalBookings: 12,
        lastStay: "2026-07-04T00:00:00.000Z",
      }, CLUB_FORMAT_TEST),
    ).toBe("12 bookings · last stay 4 Jul 2026");
  });
});
