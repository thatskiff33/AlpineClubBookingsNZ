/**
 * Issue #713 — multi date range stays (per-guest non-contiguous nights).
 *
 * Covers the core, contiguity-agnostic behaviour: per-night pricing over a
 * night set, per-night capacity counting across gaps, Xero line items split
 * per contiguous run, auto-expand normalization (no more "must stay within"),
 * promo maths over a sparse night set, and bed-allocation pruning by night set.
 */
import { describe, it, expect, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

import {
  calculateBookingPrice,
  calculatePromoDiscount,
  type SeasonRateData,
  type PromoCodeInput,
} from "@/lib/pricing";
import {
  countActiveGuestsForNight,
  isGuestActiveOnNight,
} from "@/lib/booking-guest-stay-ranges";
import { buildInvoiceLineItems } from "@/lib/xero-booking-invoices";
import {
  normalizeGuestStayRange,
  BookingGuestStayRangeValidationError,
} from "@/lib/booking-guest-stay-range-input";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld as reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { BED_ALLOCATION_PRIORITY_VOCABULARY } from "@/lib/bed-allocation-settings";
import { parseDateOnly } from "@/lib/date-only";

const MEMBER_TYPE = "type-member";
const NONMEMBER_TYPE = "type-nonmember";

// June 2026 sits inside this single season.
const SEASON: SeasonRateData = {
  seasonId: "winter-2026",
  startDate: parseDateOnly("2026-06-01"),
  endDate: parseDateOnly("2026-06-30"),
  rates: [
    { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 4500 },
    { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 7000 },
    { ageTier: "CHILD", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 1500 },
  ],
};

const CHECK_IN = parseDateOnly("2026-06-01");
const CHECK_OUT = parseDateOnly("2026-06-15"); // 14 nights

describe("per-night pricing over a night set", () => {
  it("prices a guest for only their included nights (the meeting example)", () => {
    // Mum (member) stays the whole fortnight; dad (non-member) stays weekend
    // one and weekend two with the weekdays switched off.
    const dadNights = ["2026-06-06", "2026-06-07", "2026-06-13", "2026-06-14"];
    const breakdown = calculateBookingPrice(
      CHECK_IN,
      CHECK_OUT,
      [
        { ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE" }, // mum, full range
        { ageTier: "ADULT", isMember: false, rateMembershipTypeId: NONMEMBER_TYPE, rateSource: "NON_MEMBER_DEFAULT", nights: dadNights }, // dad, gapped
      ],
      [SEASON],
    );

    const mum = breakdown.guests[0];
    const dad = breakdown.guests[1];

    expect(mum.nights).toBe(14);
    expect(mum.priceCents).toBe(14 * 4500);

    expect(dad.nights).toBe(4);
    expect(dad.priceCents).toBe(4 * 7000);
    expect(dad.perNightCents).toEqual([7000, 7000, 7000, 7000]);
    expect(dad.nightDates.map((d) => d.toISOString().slice(0, 10))).toEqual(
      dadNights,
    );

    expect(breakdown.totalPriceCents).toBe(14 * 4500 + 4 * 7000);
  });

  it("dedupes and sorts an unordered night set", () => {
    const breakdown = calculateBookingPrice(
      CHECK_IN,
      CHECK_OUT,
      [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE", nights: ["2026-06-05", "2026-06-03", "2026-06-05"] }],
      [SEASON],
    );
    const guest = breakdown.guests[0];
    expect(guest.nights).toBe(2);
    expect(guest.nightDates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-06-03",
      "2026-06-05",
    ]);
  });

  it("is identical to the contiguous range when no night set is given", () => {
    const withRange = calculateBookingPrice(
      CHECK_IN,
      CHECK_OUT,
      [{ ageTier: "ADULT", isMember: true, rateMembershipTypeId: MEMBER_TYPE, rateSource: "OWN_TYPE", stayStart: parseDateOnly("2026-06-01"), stayEnd: parseDateOnly("2026-06-04") }],
      [SEASON],
    );
    expect(withRange.guests[0].nights).toBe(3);
    expect(withRange.guests[0].priceCents).toBe(3 * 4500);
  });
});

describe("per-night capacity counting across gaps", () => {
  const booking = { checkIn: CHECK_IN, checkOut: CHECK_OUT };
  const guests = [
    { stayStart: CHECK_IN, stayEnd: CHECK_OUT }, // mum, every night
    { nights: ["2026-06-06", "2026-06-07", "2026-06-13", "2026-06-14"] }, // dad, gapped
  ];

  it("counts a gapped guest only on the nights they stay", () => {
    // Weekend night: both present.
    expect(
      countActiveGuestsForNight(guests, parseDateOnly("2026-06-06"), booking),
    ).toBe(2);
    // Mid-week gap night: only mum.
    expect(
      countActiveGuestsForNight(guests, parseDateOnly("2026-06-09"), booking),
    ).toBe(1);
  });

  it("treats an explicit night set as authoritative for presence", () => {
    const dad = { nights: ["2026-06-06", "2026-06-13"] };
    expect(isGuestActiveOnNight(dad, parseDateOnly("2026-06-06"), booking)).toBe(true);
    expect(isGuestActiveOnNight(dad, parseDateOnly("2026-06-07"), booking)).toBe(false);
  });
});

describe("Xero line items for non-contiguous stays", () => {
  function nightRows(keys: string[], priceCents: number) {
    return keys.map((key) => ({ stayDate: parseDateOnly(key), priceCents }));
  }

  it("splits a gapped stay into one line item per contiguous run", () => {
    const items = buildInvoiceLineItems(
      [
        {
          firstName: "Dad",
          lastName: "Smith",
          ageTier: "ADULT",
          isMember: false,
          priceCents: 4 * 7000,
          nights: nightRows(
            ["2026-06-06", "2026-06-07", "2026-06-13", "2026-06-14"],
            7000,
          ),
        },
      ],
      CHECK_IN,
      CHECK_OUT,
      14,
    );

    expect(items).toHaveLength(2);
    expect(items[0].quantity).toBe(2);
    expect(items[1].quantity).toBe(2);
    expect(items[0].unitAmount).toBe(70);
  });

  it("emits a single line for a contiguous stay (unchanged from before)", () => {
    const items = buildInvoiceLineItems(
      [
        {
          firstName: "Mum",
          lastName: "Smith",
          ageTier: "ADULT",
          isMember: true,
          priceCents: 3 * 4500,
          nights: nightRows(["2026-06-01", "2026-06-02", "2026-06-03"], 4500),
        },
      ],
      CHECK_IN,
      CHECK_OUT,
      14,
    );
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(3);
    expect(items[0].unitAmount).toBe(45);
  });

  it("falls back to one whole-range line when no night rows are given", () => {
    const items = buildInvoiceLineItems(
      [{ firstName: "Mum", lastName: "Smith", ageTier: "ADULT", isMember: true, priceCents: 14 * 4500 }],
      CHECK_IN,
      CHECK_OUT,
      14,
    );
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(14);
  });
});

describe("normalizeGuestStayRange auto-expand + night sets", () => {
  const booking = { checkIn: CHECK_IN, checkOut: CHECK_OUT };

  it("derives the envelope from an explicit night set", () => {
    const result = normalizeGuestStayRange(
      { nights: ["2026-06-14", "2026-06-06", "2026-06-07"] },
      booking,
      0,
    );
    expect(result.stayStart.toISOString().slice(0, 10)).toBe("2026-06-06");
    expect(result.stayEnd.toISOString().slice(0, 10)).toBe("2026-06-15"); // last night + 1
    expect(result.nights?.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-06-06",
      "2026-06-07",
      "2026-06-14",
    ]);
  });

  it("no longer rejects a range outside the booking dates (auto-expand)", () => {
    // Earlier this threw "guest dates must stay within ...".
    const result = normalizeGuestStayRange(
      { stayStart: "2026-05-28", stayEnd: "2026-06-20" },
      booking,
      0,
    );
    expect(result.stayStart.toISOString().slice(0, 10)).toBe("2026-05-28");
    expect(result.stayEnd.toISOString().slice(0, 10)).toBe("2026-06-20");
  });

  it("still requires both Date In and Date Out together", () => {
    expect(() =>
      normalizeGuestStayRange({ stayStart: "2026-06-02" }, booking, 0),
    ).toThrow(BookingGuestStayRangeValidationError);
  });
});

describe("promo maths over a sparse night set", () => {
  // Dad's gapped stay produces four equal nightly rates; promos operate on the
  // rate list, so contiguity is irrelevant.
  const guest = { memberId: "m1", isMember: false, perNightRates: [7000, 7000, 7000, 7000] };

  it("FREE_NIGHTS discounts the most expensive nights regardless of gaps", () => {
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 1 };
    const result = calculatePromoDiscount(promo, {
      totalPriceCents: 28000,
      guests: [guest],
      remainingFreeNights: 1,
    });
    expect(result.discountCents).toBe(7000);
    expect(result.freeNightsUsed).toBe(1);
  });

  it("PERCENTAGE applies to every included night", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 50 };
    const result = calculatePromoDiscount(promo, { totalPriceCents: 28000, guests: [guest] });
    expect(result.discountCents).toBe(14000);
  });
});

describe("bed-allocation pruning by night set", () => {
  it("prunes allocations on nights a guest is not staying (gaps included)", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = {
      clubModuleSettings: { findUnique: vi.fn().mockResolvedValue({ bedAllocation: true }) },
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({
          autoAllocationEnabled: false,
          allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
        }),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "b1",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          guests: [
            {
              id: "g1",
              bookingId: "b1",
              ageTier: "ADULT",
              stayStart: parseDateOnly("2026-06-06"),
              stayEnd: parseDateOnly("2026-06-15"),
              // Non-contiguous: weekends only.
              nights: [
                { stayDate: parseDateOnly("2026-06-06") },
                { stayDate: parseDateOnly("2026-06-07") },
                { stayDate: parseDateOnly("2026-06-13") },
                { stayDate: parseDateOnly("2026-06-14") },
              ],
            },
          ],
        }),
      },
      bedAllocation: {
        deleteMany,
        // #1750: the prune sweep captures doomed primary bed-nights before
        // deleting, to promote orphaned second occupants afterwards.
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as Parameters<typeof reconcileBedAllocationsForBooking>[0]["db"];

    await reconcileBedAllocationsForBooking({
      bookingId: "b1",
      db,
    });

    expect(deleteMany).toHaveBeenCalled();
    const whereArg = deleteMany.mock.calls[0][0].where;
    const guestClause = whereArg.OR.find(
      (clause: { bookingGuestId?: string; stayDate?: { notIn?: Date[] } }) =>
        clause.bookingGuestId === "g1" && clause.stayDate?.notIn,
    );
    expect(guestClause).toBeTruthy();
    // The four staying nights are kept; the gap nights are pruned by exclusion.
    expect(guestClause.stayDate.notIn).toHaveLength(4);
  });
});
