/**
 * Member age in a club WEST of UTC (#2872, CT-3; INV-DATE-010, INV-DATE-026).
 *
 * `member-age.test.ts` covers the arithmetic and the club-day default in the
 * shipped zone, Pacific/Auckland. This file exists because that zone cannot see
 * the defect it pins: a stored date of birth is `DateTime @db.Date` — a calendar
 * day encoded as UTC midnight — and the helper used to resolve a `Date` or an
 * ISO string by PROJECTING it into the club zone. Projecting UTC midnight into a
 * zone AHEAD of Greenwich lands on club midday, the same day, so New Zealand
 * agrees with the truth and the projection looks correct. Projecting it into a
 * zone BEHIND Greenwich lands on the previous evening, and the age is then
 * derived from the wrong day.
 *
 * WHAT THAT COSTS. The parsed birthday moves one day EARLIER, so the member
 * reads a year OLDER for the single day before their real birthday. These labels
 * sit on the family-suggestion strip and the Family Group identity strips, which
 * an administrator reads while confirming WHICH person an identity-sensitive
 * action applies to — the one place a wrong age is not cosmetic.
 *
 * The config module is mocked to `America/Denver` for this file only. Against
 * truncation these assertions hold; against the projection the first two fail by
 * a year, which is the discrimination this file exists to provide.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import {
  calculateMemberAgeParts,
  formatMemberIdentityAge,
} from "@/lib/member-age";

/** A New Year's Day birthday, stored the way a `@db.Date` column serialises. */
const NEW_YEARS_DAY_BIRTH = new Date("2007-01-01T00:00:00.000Z");

describe("member age reads the STORED day, not the club-zone reading of it", () => {
  it("is 18 on the day before an 1 January birthday, not 19", () => {
    expect(
      formatMemberIdentityAge(NEW_YEARS_DAY_BIRTH, "2025-12-31"),
      "INV-DATE-026: projecting the UTC-midnight encoding into a zone behind " +
        "Greenwich reads the birthday as 31 December, so this member ages up a " +
        "day early and the strip shows an administrator the wrong year.",
    ).toBe("18 years");
  });

  it("turns 19 on the birthday itself, and not before", () => {
    expect(formatMemberIdentityAge(NEW_YEARS_DAY_BIRTH, "2026-01-01")).toBe(
      "19 years",
    );
  });

  it("keeps the years-and-months band on the stored day too", () => {
    // A toddler, where the months half of the label is shown as well. The day
    // before the monthly anniversary is one completed month fewer.
    expect(
      calculateMemberAgeParts(new Date("2024-01-01T00:00:00.000Z"), "2026-06-30"),
    ).toEqual({ years: 2, months: 5 });
    expect(
      calculateMemberAgeParts(new Date("2024-01-01T00:00:00.000Z"), "2026-07-01"),
    ).toEqual({ years: 2, months: 6 });
  });

  it("agrees between a Date, its ISO string and a bare date-only string", () => {
    // The three shapes one stored value takes on its way to a screen. Only the
    // first two went through the projection, so in this zone they used to
    // disagree with the third — the "two representations always agree" property
    // the old comment claimed is the one truncation actually delivers.
    expect(formatMemberIdentityAge(NEW_YEARS_DAY_BIRTH, "2025-12-31")).toBe(
      "18 years",
    );
    expect(
      formatMemberIdentityAge("2007-01-01T00:00:00.000Z", "2025-12-31"),
    ).toBe("18 years");
    expect(formatMemberIdentityAge("2007-01-01", "2025-12-31")).toBe("18 years");
  });
});

describe('"today" is still the CLUB calendar day, which is a different question', () => {
  it("takes the default reference date from the club zone, not from UTC", () => {
    // The suite-wide frozen instant is 2026-07-01T00:00:00.000Z, which in Denver
    // is still 30 June. A member born on 1 July has not had their birthday yet
    // THERE, so 18 is the right answer and 19 would mean the default had been
    // "fixed" into a UTC reading along with the date-of-birth half. The two
    // halves are deliberately different: a birthday has no zone, and "what day
    // is it" has nothing else.
    expect(formatMemberIdentityAge("2007-07-01")).toBe("18 years");
    expect(formatMemberIdentityAge("2007-06-30")).toBe("19 years");
  });
});
