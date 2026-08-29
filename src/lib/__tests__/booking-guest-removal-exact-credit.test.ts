import { describe, expect, it } from "vitest";
import { calculateBookingPrice, type SeasonRateData } from "@/lib/pricing";
import { lockedNightPricesForGuest } from "@/lib/booking-modify-plan";
import { storedSoldPriceEvidenceForGuest } from "@/lib/stored-sold-price-evidence";

/**
 * #3031 (epic #2797): a guest removal credits the DEPARTING guest's own stored
 * sold price, and nothing else.
 *
 * ## The defect this pins shut
 *
 * `removeBookingGuestInTransaction` never computed that credit directly. It
 * repriced the REMAINING guests and took the difference against the booking's
 * stored total:
 *
 *     priceDiffCents = (reprice of who is left) - Booking.finalPriceCents
 *
 * That is exact only while the reprice cannot move. Where a remaining guest's
 * rows carried no usable price, their nights had no lock, so the reprice valued
 * them at TODAY's season rate — and the whole of that movement landed inside
 * what the member was told was the departing guest's credit. A rate rise on
 * somebody else's stay changed the amount refunded for this one.
 *
 * ## Why the fix is a gate rather than a new formula
 *
 * The service now refuses the removal unless EVERY strand on the booking
 * reconciles: each night the guest holds carries a stored non-negative integer
 * price, and those prices sum to `BookingGuest.priceCents`. Under that
 * condition the existing arithmetic is exact, because a locked night
 * short-circuits the season lookup entirely — so the reprice returns each
 * remaining guest's stored total unchanged and the difference IS
 * `guestToRemove.priceCents`.
 *
 * This suite proves both halves against the REAL pricing engine rather than a
 * mock: that locks make the reprice immovable even when today's rates have
 * doubled, and that the shapes which used to slip through the gate are refused.
 * The route-level suites mock the pricer, so they cannot see either.
 */

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);

const MEMBER_TYPE = "type-member";
/** What the club charges TODAY — deliberately unlike anything below. */
const TODAY_RATE = 12000;

const SEASONS: SeasonRateData[] = [
  {
    seasonId: "s1",
    startDate: D("2026-08-01"),
    endDate: D("2026-08-31"),
    rates: [
      {
        ageTier: "ADULT",
        membershipTypeId: MEMBER_TYPE,
        pricePerNightCents: TODAY_RATE,
      },
    ],
  },
];

const NIGHTS = ["2026-08-20", "2026-08-21", "2026-08-22"];

/** A remaining guest, as `guestsForPricing` builds one on the removal path. */
function remainingGuest(
  nights: Array<{ stayDate: Date; priceCents?: number }>,
  priceCents: number,
) {
  const guest = {
    id: "g-stays",
    ageTier: "ADULT" as const,
    isMember: true,
    memberId: "m2",
    rateMembershipTypeId: MEMBER_TYPE,
    rateSource: "OWN_TYPE" as const,
    stayStart: D(NIGHTS[0]),
    stayEnd: D("2026-08-23"),
    nights,
    priceCents,
  };
  return {
    guest,
    // The exact shape `removeBookingGuestInTransaction` hands the pricer.
    forPricing: {
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      rateMembershipTypeId: guest.rateMembershipTypeId,
      rateSource: guest.rateSource,
      stayStart: guest.stayStart,
      stayEnd: guest.stayEnd,
      nights: guest.nights.map((night) => night.stayDate),
      lockedNightPrices: lockedNightPricesForGuest(guest),
    },
  };
}

describe("#3031 a removal's credit is the departing guest's own stored price", () => {
  it("cannot move a remaining guest's total, however far today's rates have run", () => {
    // They bought three nights at 4000 when the club charged 4000. It charges
    // 12000 now. Repricing them at today's rate would add 24000 to the booking
    // total, and every cent of that would have been reported as part of the
    // departing guest's credit.
    const paidCents = 4000;
    const { guest, forPricing } = remainingGuest(
      NIGHTS.map((night) => ({ stayDate: D(night), priceCents: paidCents })),
      NIGHTS.length * paidCents,
    );

    // The gate this all rests on: their evidence is exact.
    expect(storedSoldPriceEvidenceForGuest(guest).kind).toBe("exact");

    const breakdown = calculateBookingPrice(
      D(NIGHTS[0]),
      D("2026-08-23"),
      [forPricing],
      SEASONS,
    );

    expect(TODAY_RATE).not.toBe(paidCents);
    expect(breakdown.guests[0].perNightCents).toEqual([
      paidCents,
      paidCents,
      paidCents,
    ]);
    // The property the removal's arithmetic depends on, stated as itself: the
    // reprice returns the STORED total, so the difference against the booking
    // total is exactly the departing guest's own price and nothing else.
    expect(breakdown.guests[0].priceCents).toBe(guest.priceCents);
    expect(breakdown.totalPriceCents).toBe(guest.priceCents);
  });

  it("is exactly what the reprice would NOT be without the locks", () => {
    // The control, so the case above cannot pass by coincidence: the same guest
    // with no stored prices reprices at today's rate, and the difference is the
    // contamination that used to be reported as somebody else's credit.
    const { forPricing } = remainingGuest(
      NIGHTS.map((night) => ({ stayDate: D(night) })),
      NIGHTS.length * 4000,
    );

    const breakdown = calculateBookingPrice(
      D(NIGHTS[0]),
      D("2026-08-23"),
      [forPricing],
      SEASONS,
    );

    expect(breakdown.totalPriceCents).toBe(NIGHTS.length * TODAY_RATE);
    expect(breakdown.totalPriceCents).toBeGreaterThan(NIGHTS.length * 4000);
  });

  it("refuses every strand whose stored rows cannot support the removal", () => {
    // The gate, shape by shape. Each of these used to reach the pricer and be
    // valued at today's rate on the nights it could not lock.
    const base = { stayStart: D(NIGHTS[0]), stayEnd: D("2026-08-23") };

    // No rows at all: a booking predating `BookingGuestNight`, or one created by
    // approving a request (#2739 backfills those but cannot empty the
    // population). The envelope still says which nights; nothing says what they
    // cost.
    expect(
      storedSoldPriceEvidenceForGuest({ ...base, priceCents: 12000, nights: [] }),
    ).toMatchObject({ kind: "unusable", cause: "NO_STORED_NIGHT_PRICES" });

    // Some rows priced, some not — a mixed strand, which is worse than none,
    // because the total that DOES reconcile is only part of the stay.
    expect(
      storedSoldPriceEvidenceForGuest({
        ...base,
        priceCents: 12000,
        nights: [
          { stayDate: D(NIGHTS[0]), priceCents: 4000 },
          { stayDate: D(NIGHTS[1]), priceCents: 4000 },
          { stayDate: D(NIGHTS[2]), priceCents: null },
        ],
      }),
    ).toMatchObject({ kind: "unusable", cause: "PARTIAL_STORED_NIGHT_PRICES" });

    // Rows all present and priced, and a stored total that disagrees. Nothing is
    // missing; the evidence simply does not add up.
    expect(
      storedSoldPriceEvidenceForGuest({
        ...base,
        priceCents: 12001,
        nights: NIGHTS.map((night) => ({
          stayDate: D(night),
          priceCents: 4000,
        })),
      }),
    ).toMatchObject({ kind: "unusable", cause: "STORED_TOTAL_MISMATCH" });

    // A negative row is not a cheap night; it is a row that cannot be money, and
    // pre-#2744 arithmetic could write one. Trusting it would invert the credit.
    expect(
      storedSoldPriceEvidenceForGuest({
        ...base,
        priceCents: 0,
        nights: NIGHTS.map((night) => ({
          stayDate: D(night),
          priceCents: -4000,
        })),
      }),
    ).toMatchObject({ kind: "unusable", cause: "NO_STORED_NIGHT_PRICES" });

    // And the one that must NOT be refused: a negotiated flat allocation. Equal
    // nightly rows are not a defect, and epic #2797 says so in as many words -
    // refusing them would refuse a large share of historical bookings.
    expect(
      storedSoldPriceEvidenceForGuest({
        ...base,
        priceCents: 12000,
        nights: NIGHTS.map((night) => ({
          stayDate: D(night),
          priceCents: 4000,
        })),
      }),
    ).toMatchObject({ kind: "exact", totalCents: 12000 });
  });

  it("treats a comped night as a price and an absent one as an absence", () => {
    // Zero is a real sold price. The distinction is the whole reason the
    // evidence carries `number | null` rather than a number defaulted to zero:
    // "we gave them this night" and "we have no idea what this night cost" are
    // different facts, and only the second needs a person.
    const comped = storedSoldPriceEvidenceForGuest({
      stayStart: D(NIGHTS[0]),
      stayEnd: D("2026-08-23"),
      priceCents: 8000,
      nights: [
        { stayDate: D(NIGHTS[0]), priceCents: 4000 },
        { stayDate: D(NIGHTS[1]), priceCents: 0 },
        { stayDate: D(NIGHTS[2]), priceCents: 4000 },
      ],
    });

    expect(comped).toMatchObject({ kind: "exact", totalCents: 8000 });
  });
});
