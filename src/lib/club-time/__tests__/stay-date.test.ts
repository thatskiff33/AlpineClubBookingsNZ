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
