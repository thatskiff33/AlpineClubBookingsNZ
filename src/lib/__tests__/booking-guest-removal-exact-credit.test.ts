import { describe, expect, it } from "vitest";
import { calculateBookingPrice, type SeasonRateData } from "@/lib/pricing";
import { editedGuestPricingLocks } from "@/lib/booking-modify-plan";
import { storedSoldPriceEvidenceForGuest } from "@/lib/stored-sold-price-evidence";
import {
  valuedNightLocksForGuest,
} from "@/lib/edit-night-valuation";

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
 * ## Why the fix is a lock on every night rather than a new formula
 *
 * #3031 refused, and #3032 parked, a removal unless every strand reconciled.
 * #4317 (epic #4302, owner decision D1) locks EVERY night a remaining guest
 * holds at its valued figure (`valuedNightLocksForGuest`, `INV-MOD-028`), and
 * a locked night short-circuits the season lookup entirely — so the reprice
 * returns each remaining guest's stored total unchanged, whatever its rows
 * look like, and the difference IS `guestToRemove.priceCents` (or $0 for a
 * negative one, D11).
 *
 * This suite proves that against the REAL pricing engine rather than a mock,
 * for every strand shape that used to be refused. The route-level suites mock
 * the pricer, so they cannot see it.
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

/**
 * The booking's own stay window, which every evidence question is asked against.
 *
 * `storedSoldPriceEvidenceForGuest` takes it because it reaches the canonical
 * `getGuestBedNightKeys`, whose rule is "explicit night rows, else the guest's
 * envelope, else the BOOKING's" — the same rule every other reader of a guest's
 * nights follows (INV-DATE-020). The local twin it replaced stopped at the
 * guest's envelope and answered "no nights held" when that was null, which for a
 * zero-priced strand reconciled to `exact` (`INV-SSOT`).
 */
const BOOKING_RANGE = { checkIn: D(NIGHTS[0]), checkOut: D("2026-08-23") };

/** A remaining guest, as `guestsForPricing` builds one on the removal path. */
function remainingGuest(
  nights: Array<{ stayDate: Date; priceCents?: number }>,
  priceCents: number,
) {
  const storedNights = nights.map((night) => ({
    ...night,
    priceSource: night.priceCents === undefined ? ("UNKNOWN" as const) : ("SOLD" as const),
  }));
  const guest = {
    id: "g-stays",
    ageTier: "ADULT" as const,
    isMember: true,
    memberId: "m2",
    rateMembershipTypeId: MEMBER_TYPE,
    rateSource: "OWN_TYPE" as const,
    stayStart: D(NIGHTS[0]),
    stayEnd: D("2026-08-23"),
    nights: storedNights,
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
      lockedNightPrices: valuedNightLocksForGuest(guest, BOOKING_RANGE).lockedNightPrices,
    },
  };
}

describe("a removal's credit is the departing guest's own stored price (#3031, #4317)", () => {
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
    expect(
      storedSoldPriceEvidenceForGuest(guest, BOOKING_RANGE, "WHOLE_GUEST").kind,
    ).toBe("exact");

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

  it("T8: a remaining guest with NO usable rows still reprices to its stored total", () => {
    // Three nights with no stored price against a stored $120: R2 values each
    // at $40, and the locks hold them there although the club charges $120 a
    // night today. Without the lock (the control) the reprice is $360.
    const { guest, forPricing } = remainingGuest(
      NIGHTS.map((night) => ({ stayDate: D(night) })),
      NIGHTS.length * 4000,
    );

    const locked = calculateBookingPrice(D(NIGHTS[0]), D("2026-08-23"), [forPricing], SEASONS);
    expect(locked.guests[0].perNightCents).toEqual([4000, 4000, 4000]);
    expect(locked.totalPriceCents).toBe(guest.priceCents);

    const unlocked = calculateBookingPrice(
      D(NIGHTS[0]),
      D("2026-08-23"),
      [{ ...forPricing, lockedNightPrices: [] }],
      SEASONS,
    );
    expect(unlocked.totalPriceCents).toBe(NIGHTS.length * TODAY_RATE);
  });

  it("reprices every strand shape the gate used to refuse to its stored total (#4317)", () => {
    // Each of these used to be refused or parked. Valued and locked, each
    // reprices to exactly what it carries, so a removal beside it credits
    // only the departing guest.
    const shapes: Array<{
      label: string;
      priceCents: number;
      nights: Array<{ stayDate: Date; priceCents?: number | null }>;
      values: number[];
    }> = [
      {
        // No rows at all: valued over the envelope (R2), $40 a night.
        label: "no rows",
        priceCents: 12000,
        nights: [],
        values: [4000, 4000, 4000],
      },
      {
        // Two priced, one blank: the blank takes the $40 the total has left (R2).
        label: "partial",
        priceCents: 12000,
        nights: [
          { stayDate: D(NIGHTS[0]), priceCents: 4000 },
          { stayDate: D(NIGHTS[1]), priceCents: 4000 },
          { stayDate: D(NIGHTS[2]), priceCents: null },
        ],
        values: [4000, 4000, 4000],
      },
      {
        // Rows that do not add up ($120 against $120.01): R3 splits the total,
        // the leftover cent on the earliest night.
        label: "mismatch",
        priceCents: 12001,
        nights: NIGHTS.map((night) => ({ stayDate: D(night), priceCents: 4000 })),
        values: [4001, 4000, 4000],
      },
      {
        // Negative rows against a $0 total: not money, so the $0 is split.
        label: "negative rows",
        priceCents: 0,
        nights: NIGHTS.map((night) => ({ stayDate: D(night), priceCents: -4000 })),
        values: [0, 0, 0],
      },
    ];
    for (const shape of shapes) {
      const guest = {
        stayStart: D(NIGHTS[0]),
        stayEnd: D("2026-08-23"),
        priceCents: shape.priceCents,
        nights: shape.nights.map((night) => ({
          ...night,
          priceSource: "SOLD" as const,
        })),
      };
      const { lockedNightPrices, unattachedCents } = valuedNightLocksForGuest(
        guest,
        BOOKING_RANGE,
      );
      expect(lockedNightPrices.map((lock) => lock.priceCents), shape.label).toEqual(shape.values);
      const repriced = calculateBookingPrice(
        D(NIGHTS[0]),
        D("2026-08-23"),
        [
          {
            ageTier: "ADULT",
            isMember: true,
            rateMembershipTypeId: MEMBER_TYPE,
            nights: NIGHTS.map((night) => D(night)),
            lockedNightPrices,
          },
        ],
        SEASONS,
      );
      expect(repriced.totalPriceCents + unattachedCents, shape.label).toBe(shape.priceCents);
    }
  });

  it("D11: a negative stored total is valued at $0 a night and carries its figure unattached (pure; doors refuse it)", () => {
    const guest = {
      stayStart: D(NIGHTS[0]),
      stayEnd: D("2026-08-23"),
      priceCents: -500,
      nights: NIGHTS.map((night) => ({
        stayDate: D(night),
        priceCents: 4000,
        priceSource: "SOLD" as const,
      })),
    };
    const { lockedNightPrices, unattachedCents } = valuedNightLocksForGuest(guest, BOOKING_RANGE);
    expect(lockedNightPrices.map((lock) => lock.priceCents)).toEqual([0, 0, 0]);
    expect(unattachedCents).toBe(-500);
  });

  it("asks the BOOKING's range for a strand carrying no envelope of its own", () => {
    // The null-envelope strand, which the local night-key derivation this module
    // used to carry got wrong. `BookingGuest.stayStart`/`stayEnd` are nullable,
    // and the canonical rule (`getGuestBedNightKeys`) falls back to the
    // BOOKING's range for a guest with neither rows nor an envelope. The twin
    // stopped one step earlier and answered "holds no nights at all" — which,
    // against a zero stored total, reconciles to `exact` and lets a removal be
    // credited from history nobody has.
    const verdict = storedSoldPriceEvidenceForGuest(
      { stayStart: null, stayEnd: null, priceCents: 0, nights: [] },
      BOOKING_RANGE,
      "WHOLE_GUEST",
    );

    expect(verdict).toMatchObject({
      kind: "unusable",
      cause: "NO_STORED_NIGHT_PRICES",
    });
    // Three booking nights, each reported as an absence rather than as a zero.
    expect(verdict.nightPrices).toEqual([
      { date: "2026-08-20", priceCents: null },
      { date: "2026-08-21", priceCents: null },
      { date: "2026-08-22", priceCents: null },
    ]);
  });

  it("treats a comped night as a price and an absent one as an absence", () => {
    // Zero is a real sold price. The distinction is the whole reason the
    // evidence carries `number | null` rather than a number defaulted to zero:
    // "we gave them this night" and "we have no idea what this night cost" are
    // different facts, and only the second needs a person.
    const comped = storedSoldPriceEvidenceForGuest(
      {
        stayStart: D(NIGHTS[0]),
        stayEnd: D("2026-08-23"),
        priceCents: 8000,
        nights: [
          { stayDate: D(NIGHTS[0]), priceCents: 4000 },
          { stayDate: D(NIGHTS[1]), priceCents: 0 },
          { stayDate: D(NIGHTS[2]), priceCents: 4000 },
        ],
      },
      BOOKING_RANGE,
      "WHOLE_GUEST",
    );

    expect(comped).toMatchObject({ kind: "exact", totalCents: 8000 });
  });
});

/**
 * #3531 3a: the locks an edited guest prices with, and whether the edit cleared
 * them, are one answer for the modify save and the modify preview.
 */
describe("editedGuestPricingLocks - one home for the cleared-locks fact", () => {
  const booking = {
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
  };
  const guest = {
    priceCents: 10000,
    stayStart: booking.checkIn,
    stayEnd: booking.checkOut,
    nights: [
      { stayDate: new Date("2026-08-01T00:00:00.000Z"), priceCents: 5000, priceSource: "EVEN_SPLIT" as const },
      { stayDate: new Date("2026-08-02T00:00:00.000Z"), priceCents: 5000, priceSource: "EVEN_SPLIT" as const },
    ],
  };

  it("locks every booked night at its valued price and provenance for an ordinary edit", () => {
    expect(editedGuestPricingLocks(guest, booking, false)).toEqual({
      lockedNightPrices: valuedNightLocksForGuest(guest, booking).lockedNightPrices,
      unattachedCents: 0,
    });
    expect(
      editedGuestPricingLocks(guest, booking, false).lockedNightPrices?.map(
        (lock) => [lock.priceCents, lock.priceSource],
      ),
    ).toEqual([
      [5000, "EVEN_SPLIT"],
      [5000, "EVEN_SPLIT"],
    ]);
  });

  it("clears the locks AND says so for a strand the edit deliberately reprices", () => {
    expect(editedGuestPricingLocks(guest, booking, true)).toEqual({
      lockedNightPrices: [],
      repricedDeliberately: true,
      unattachedCents: 0,
    });
  });
});
