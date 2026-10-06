/**
 * `formatStayDate` / `formatStayDateOrNull` (#3507) — the west-of-Greenwich
 * case the helper's docblock describes, made executable.
 *
 * A `@db.Date` is encoded as UTC midnight. Read as a MOMENT through a zone
 * behind Greenwich, that instant falls on the evening of the previous day, so
 * the stay renders a day early (CT-4, #2870; `INV-DATE-010`). Read as the
 * calendar day it encodes, no zone is consulted and nothing can move it. Both
 * routes are exercised here against the same instant so the difference is a
 * measured string rather than a sentence in a comment.
 *
 * Fixtures sit relative to the frozen test clock (`2026-07-01T00:00:00.000Z`);
 * nothing here reads the real calendar.
 */

import { describe, expect, it } from "vitest";

import { formatClubInstantDate, formatStayDate, formatStayDateOrNull } from "../format";
import { calendarDateOfSerialisedDbDateOrNull } from "../instant";
import { requireClubTimeZone } from "../zone";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

/** A stored lodge night — 16 August 2026 — exactly as Prisma serialises it. */
const SERIALISED_STAY = "2026-08-16T00:00:00.000Z";
const EXPECTED = "16 Aug 2026";

const VANCOUVER = requireClubTimeZone("America/Vancouver");
const AUCKLAND = requireClubTimeZone("Pacific/Auckland");

describe("formatStayDate keeps the stored lodge night west of Greenwich (INV-DATE-010)", () => {
  it("reads the encoded day, so a club behind Greenwich sees the night it booked", () => {
    expect(formatStayDate(SERIALISED_STAY, CLUB_FORMAT_TEST)).toBe(EXPECTED);
    expect(formatStayDate(new Date(SERIALISED_STAY), CLUB_FORMAT_TEST)).toBe(EXPECTED);
  });

  it("is the route that differs from reading the same instant through a zone", () => {
    const instant = new Date(SERIALISED_STAY);
    // The defect the helper exists to make unwritable: UTC midnight on the 16th
    // is 5 pm on the 15th in Vancouver, and the identity only in a zone at or
    // ahead of Greenwich — which is why it went unnoticed in New Zealand.
    expect(formatClubInstantDate(instant, VANCOUVER, CLUB_FORMAT_TEST)).toBe("15 Aug 2026");
    expect(formatClubInstantDate(instant, AUCKLAND, CLUB_FORMAT_TEST)).toBe(EXPECTED);
    expect(formatStayDate(instant, CLUB_FORMAT_TEST)).toBe(EXPECTED);
  });

  it("does not depend on the host's zone either", () => {
    for (const hostZone of ["America/Vancouver", "Pacific/Honolulu", "Pacific/Auckland"]) {
      expect(withTimeZone(hostZone, () => formatStayDate(SERIALISED_STAY, CLUB_FORMAT_TEST))).toBe(EXPECTED);
      expect(withTimeZone(hostZone, () => formatStayDate(new Date(SERIALISED_STAY), CLUB_FORMAT_TEST))).toBe(
        EXPECTED,
      );
    }
  });

  it("accepts the bare yyyy-MM-dd spelling a route may already have encoded", () => {
    expect(formatStayDate("2026-08-16", CLUB_FORMAT_TEST)).toBe(EXPECTED);
  });

  it("throws for a value that is not a calendar day, rather than rendering a guess", () => {
    expect(() => formatStayDate("not-a-date", CLUB_FORMAT_TEST)).toThrow();
    expect(() => formatStayDate("2026-02-30", CLUB_FORMAT_TEST)).toThrow();
  });
});

describe("formatStayDateOrNull is the client-render form", () => {
  it("formats the same value the same way", () => {
    expect(formatStayDateOrNull(SERIALISED_STAY, CLUB_FORMAT_TEST)).toBe(EXPECTED);
    expect(formatStayDateOrNull("2026-08-16", CLUB_FORMAT_TEST)).toBe(EXPECTED);
  });

  it("answers null for an absent or malformed value so the caller picks the fallback", () => {
    expect(formatStayDateOrNull(null, CLUB_FORMAT_TEST)).toBeNull();
    expect(formatStayDateOrNull(undefined, CLUB_FORMAT_TEST)).toBeNull();
    expect(formatStayDateOrNull("", CLUB_FORMAT_TEST)).toBeNull();
    expect(formatStayDateOrNull("not-a-date", CLUB_FORMAT_TEST)).toBeNull();
    expect(formatStayDateOrNull("2026-02-30", CLUB_FORMAT_TEST)).toBeNull();
    expect(formatStayDateOrNull("rubbish", CLUB_FORMAT_TEST) ?? "—").toBe("—");
  });
});

/**
 * #3511 — ONE stay-date decoder. `formatPayloadCalendarDay` / `calendarDayFromPayload`
 * (`admin/_lib/calendar-day.ts`) and `formatMemberCalendarDay` were a second and
 * third reading of the same rule, with a stricter rejection of a time-bearing
 * string; they are gone, and the cases they pinned live here against the kernel.
 *
 * THE ONE BEHAVIOUR THAT CHANGED, decided by the owner on #3511 ("converge, keep
 * fallbacks"): a malformed, offset-less timestamp such as `2026-07-04T13:45:00`
 * used to render the surface's fallback ("—"); the kernel's prefix read
 * (`INV-DATE-010`) names its day. The prefix read wins because a serialised
 * `@db.Date` is always an instant string, so the case fires only on a bug, and
 * rejecting it would add a rule to the kernel that INV-DATE-010 does not have.
 */
describe("the converged decoder reads every spelling to the stored day (#3511)", () => {
  const HOSTILE_ZONES = ["UTC", "America/Denver", "Pacific/Kiritimati", "Pacific/Auckland"];

  it.each(HOSTILE_ZONES)("decodes both spellings to 2026-04-01 on a %s host", (zone) => {
    withTimeZone(zone, () => {
      expect(calendarDateOfSerialisedDbDateOrNull("2026-04-01T00:00:00.000Z")).toBe("2026-04-01");
      expect(calendarDateOfSerialisedDbDateOrNull("2026-04-01")).toBe("2026-04-01");
      expect(formatStayDateOrNull("2026-04-01T00:00:00.000Z", CLUB_FORMAT_TEST)).toBe("1 Apr 2026");
      expect(formatStayDateOrNull("2026-04-01", CLUB_FORMAT_TEST)).toBe("1 Apr 2026");
    });
  });

  it("answers null for anything that names no day, so the surface picks its fallback", () => {
    for (const value of [null, undefined, "", "not-a-date", "2026-02-30", "2026-13-01"]) {
      expect(calendarDateOfSerialisedDbDateOrNull(value)).toBeNull();
      expect(formatStayDateOrNull(value, CLUB_FORMAT_TEST) ?? "—").toBe("—");
    }
  });

  it("reads a time-bearing string by its date prefix (the one behaviour #3511 changed)", () => {
    // Before #3511 `formatPayloadCalendarDay` / `formatMemberCalendarDay` /
    // `formatFamilyGroupCalendarDay` answered their fallback for this value.
    expect(calendarDateOfSerialisedDbDateOrNull("2026-07-04T13:45:00")).toBe("2026-07-04");
    expect(formatStayDateOrNull("2026-07-04T13:45:00", CLUB_FORMAT_TEST)).toBe("4 Jul 2026");
  });
});

describe("a non-string payload value cannot throw out of a render (#3511 review)", () => {
  it("answers null for a number, an object or a Date, where `.slice` would throw", () => {
    for (const value of [20260704, {}, new Date(SERIALISED_STAY), true]) {
      expect(calendarDateOfSerialisedDbDateOrNull(value as unknown as string)).toBeNull();
      expect(formatStayDateOrNull(value as unknown as string, CLUB_FORMAT_TEST)).toBeNull();
    }
  });
});
