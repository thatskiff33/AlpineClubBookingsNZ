import { describe, expect, it } from "vitest";
import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";

describe("normalizeGuestStayRanges", () => {
  const booking = {
    checkIn: parseDateOnly("2026-07-10"),
    checkOut: parseDateOnly("2026-07-14"),
  };

  it("defaults guests without per-guest dates to the booking range", () => {
    const guests = normalizeGuestStayRanges(
      [{ ageTier: "ADULT" as const, isMember: true }],
      booking
    );

    expect(formatDateOnly(guests[0].stayStart)).toBe("2026-07-10");
    expect(formatDateOnly(guests[0].stayEnd)).toBe("2026-07-14");
  });

  it("normalizes date-only guest range strings", () => {
    const guests = normalizeGuestStayRanges(
      [
        {
          ageTier: "ADULT" as const,
          isMember: true,
          stayStart: "2026-07-11",
          stayEnd: "2026-07-13",
        },
      ],
      booking
    );

    expect(formatDateOnly(guests[0].stayStart)).toBe("2026-07-11");
    expect(formatDateOnly(guests[0].stayEnd)).toBe("2026-07-13");
  });

  it("rejects a partial guest date range", () => {
    expect(() =>
      normalizeGuestStayRanges(
        [{ ageTier: "ADULT" as const, isMember: true, stayStart: "2026-07-11" }],
        booking
      )
    ).toThrow(BookingGuestStayRangeValidationError);
  });

  it("rejects empty, inverted, and out-of-booking ranges", () => {
    expect(() =>
      normalizeGuestStayRanges(
        [
          {
            ageTier: "ADULT" as const,
            isMember: true,
            stayStart: "2026-07-11",
            stayEnd: "2026-07-11",
          },
        ],
        booking
      )
    ).toThrow("Date Out must be after Date In");

    expect(() =>
      normalizeGuestStayRanges(
        [
          {
            ageTier: "ADULT" as const,
            isMember: true,
            stayStart: "2026-07-09",
            stayEnd: "2026-07-11",
          },
        ],
        booking
      )
    ).toThrow("guest dates must stay within");
  });
});
