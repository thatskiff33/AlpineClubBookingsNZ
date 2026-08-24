import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  calculateBookingPrice,
  calculatePromoDiscount,
  selectPromoDiscountGuests,
  getStayNights,
  type GroupDiscountConfig,
  type GuestInput,
  type PromoCodeInput,
  type PromoDiscountGuest,
  type SeasonRateData,
} from "@/lib/policies";
import { dateOnlyFromParts } from "@/lib/date-only";

/**
 * Property-based tests (fast-check) for the pure pricing money math
 * (issue #1131, epic #1125). These encode the DOMAIN_INVARIANTS "Money"
 * rules as universally-quantified properties: integer cents in, integer
 * cents out, no negative money, deterministic repricing, and the #1036
 * locked-night-price stability guarantee.
 */

const AGE_TIERS = ["ADULT", "YOUTH", "CHILD", "INFANT"] as const;

// Rates keyed by membership type (#1930, E4): old member rows map to
// MEMBER_TYPE, non-member rows to NONMEMBER_TYPE.
const MEMBER_TYPE = "type-member";
const NONMEMBER_TYPE = "type-nonmember";

// calculateBookingPrice normalizes every date through an Intl.DateTimeFormat
// in the NZ app timezone, which makes each run comparatively expensive. Keep
// the run count modest (and the per-test timeout generous) so the suite stays
// fast locally and does not trip the 5s default under parallel CI workers.
const PRICE_RUNS = { numRuns: 20 } as const;
const PRICE_TEST_TIMEOUT_MS = 30_000;

/** A full rate table (every tier x membership combo) so pricing never throws. */
function ratesArb(maxCents = 20_000) {
  return fc
    .array(fc.integer({ min: 0, max: maxCents }), {
      minLength: AGE_TIERS.length * 2,
      maxLength: AGE_TIERS.length * 2,
    })
    .map((prices) =>
      AGE_TIERS.flatMap((ageTier, i) => [
        { ageTier, membershipTypeId: MEMBER_TYPE, pricePerNightCents: prices[i * 2] },
        { ageTier, membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: prices[i * 2 + 1] },
      ])
    );
}

/** A rate table where the member rate never exceeds the non-member rate. */
function memberCheaperRatesArb(maxCents = 20_000) {
  return fc
    .array(
      fc.tuple(
        fc.integer({ min: 0, max: maxCents }),
        fc.integer({ min: 0, max: 5_000 })
      ),
      { minLength: AGE_TIERS.length, maxLength: AGE_TIERS.length }
    )
    .map((pairs) =>
      AGE_TIERS.flatMap((ageTier, i) => [
        { ageTier, membershipTypeId: MEMBER_TYPE, pricePerNightCents: pairs[i][0] },
        {
          ageTier,
          membershipTypeId: NONMEMBER_TYPE,
          pricePerNightCents: pairs[i][0] + pairs[i][1],
        },
      ])
    );
}

function seasonFromRates(
  rates: SeasonRateData["rates"],
  type: "SUMMER" | "WINTER" = "SUMMER"
): SeasonRateData {
  return {
    seasonId: `season-${type}`,
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-12-31"),
    type,
    rates,
  };
}

/** checkIn day-of-year and stay length; keeps every night inside the season. */
const stayArb = fc
  .tuple(
    fc.integer({ min: 30, max: 300 }),
    fc.integer({ min: 1, max: 5 })
  )
  .map(([startDay, nights]) => {
    const checkIn = dateOnlyFromParts(2026, 0, 1 + startDay);
    const checkOut = dateOnlyFromParts(2026, 0, 1 + startDay + nights);
    return { checkIn, checkOut, nights };
  });

const guestArb: fc.Arbitrary<GuestInput> = fc
  .record({
    ageTier: fc.constantFrom(...AGE_TIERS),
    isMember: fc.boolean(),
  })
  .map((guest) => ({
    ...guest,
    // A member prices from their own type (MEMBER_TYPE / OWN_TYPE); a
    // non-member from NONMEMBER_TYPE / NON_MEMBER_DEFAULT (#1930, E4).
    rateMembershipTypeId: guest.isMember ? MEMBER_TYPE : NONMEMBER_TYPE,
    rateSource: (guest.isMember ? "OWN_TYPE" : "NON_MEMBER_DEFAULT") as
      | "OWN_TYPE"
      | "NON_MEMBER_DEFAULT",
  }));

const guestsArb = fc.array(guestArb, { minLength: 1, maxLength: 4 });

describe("calculateBookingPrice properties", () => {
  it("keeps totals additive, integer, and non-negative", () => {
    fc.assert(
      fc.property(stayArb, guestsArb, ratesArb(), (stay, guests, rates) => {
        const breakdown = calculateBookingPrice(
          stay.checkIn,
          stay.checkOut,
          guests,
          [seasonFromRates(rates)]
        );

        const guestSum = breakdown.guests.reduce((s, g) => s + g.priceCents, 0);
        expect(breakdown.totalPriceCents).toBe(guestSum);
        expect(Number.isInteger(breakdown.totalPriceCents)).toBe(true);
        expect(breakdown.totalPriceCents).toBeGreaterThanOrEqual(0);

        for (const guest of breakdown.guests) {
          expect(guest.nights).toBe(stay.nights);
          expect(guest.perNightCents).toHaveLength(stay.nights);
          expect(guest.nightDates).toHaveLength(stay.nights);
          expect(guest.priceCents).toBe(
            guest.perNightCents.reduce((s, c) => s + c, 0)
          );
          for (const cents of guest.perNightCents) {
            expect(Number.isInteger(cents)).toBe(true);
            expect(cents).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      PRICE_RUNS
    );
  }, PRICE_TEST_TIMEOUT_MS);

  it("is deterministic: repricing the same input yields the same breakdown", () => {
    fc.assert(
      fc.property(stayArb, guestsArb, ratesArb(), (stay, guests, rates) => {
        const seasons = [seasonFromRates(rates)];
        const first = calculateBookingPrice(stay.checkIn, stay.checkOut, guests, seasons);
        const second = calculateBookingPrice(stay.checkIn, stay.checkOut, guests, seasons);
        expect(second).toEqual(first);
      }),
      PRICE_RUNS
    );
  }, PRICE_TEST_TIMEOUT_MS);

  it("prices each guest independently when no group discount applies", () => {
    fc.assert(
      fc.property(stayArb, guestsArb, ratesArb(), (stay, guests, rates) => {
        const seasons = [seasonFromRates(rates)];
        const together = calculateBookingPrice(
          stay.checkIn,
          stay.checkOut,
          guests,
          seasons
        );
        guests.forEach((guest, i) => {
          const alone = calculateBookingPrice(
            stay.checkIn,
            stay.checkOut,
            [guest],
            seasons
          );
          expect(alone.totalPriceCents).toBe(together.guests[i].priceCents);
        });
      }),
      PRICE_RUNS
    );
  }, PRICE_TEST_TIMEOUT_MS);

  it("never increases the total when the group discount applies and member rates are cheaper", () => {
    const groupDiscountArb: fc.Arbitrary<GroupDiscountConfig> = fc.record({
      minGroupSize: fc.integer({ min: 1, max: 8 }),
      summerOnly: fc.boolean(),
      enabled: fc.constant(true),
      // The discount substitutes the (cheaper) member type for non-members.
      rateMembershipTypeId: fc.constant(MEMBER_TYPE),
    });
    fc.assert(
      fc.property(
        stayArb,
        guestsArb,
        memberCheaperRatesArb(),
        groupDiscountArb,
        fc.constantFrom("SUMMER", "WINTER") as fc.Arbitrary<"SUMMER" | "WINTER">,
        (stay, guests, rates, groupDiscount, seasonType) => {
          const seasons = [seasonFromRates(rates, seasonType)];
          const withDiscount = calculateBookingPrice(
            stay.checkIn,
            stay.checkOut,
            guests,
            seasons,
            groupDiscount
          );
          const withoutDiscount = calculateBookingPrice(
            stay.checkIn,
            stay.checkOut,
            guests,
            seasons
          );
          expect(withDiscount.totalPriceCents).toBeLessThanOrEqual(
            withoutDiscount.totalPriceCents
          );
        }
      ),
      PRICE_RUNS
    );
  }, PRICE_TEST_TIMEOUT_MS);

  it("locked night prices freeze a guest's total across season-rate changes (#1036)", () => {
    fc.assert(
      fc.property(
        stayArb,
        guestsArb,
        ratesArb(),
        ratesArb(),
        (stay, guests, originalRates, changedRates) => {
          const original = calculateBookingPrice(
            stay.checkIn,
            stay.checkOut,
            guests,
            [seasonFromRates(originalRates)]
          );

          const lockedGuests = guests.map((guest, i) => ({
            ...guest,
            lockedNightPrices: original.guests[i].nightDates.map((night, j) => ({
              stayDate: night,
              priceCents: original.guests[i].perNightCents[j],
            })),
          }));

          const repriced = calculateBookingPrice(
            stay.checkIn,
            stay.checkOut,
            lockedGuests,
            [seasonFromRates(changedRates)]
          );

          expect(repriced.totalPriceCents).toBe(original.totalPriceCents);
          repriced.guests.forEach((guest, i) => {
            expect(guest.priceCents).toBe(original.guests[i].priceCents);
            expect(guest.perNightCents).toEqual(original.guests[i].perNightCents);
          });
        }
      ),
      PRICE_RUNS
    );
  }, PRICE_TEST_TIMEOUT_MS);

  it("getStayNights returns exactly the chronological night set", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 360 }),
        fc.integer({ min: -3, max: 14 }),
        (startDay, nights) => {
          const checkIn = dateOnlyFromParts(2026, 0, 1 + startDay);
          const checkOut = dateOnlyFromParts(2026, 0, 1 + startDay + nights);
          const stayNights = getStayNights(checkIn, checkOut);
          expect(stayNights).toHaveLength(Math.max(nights, 0));
          for (let i = 1; i < stayNights.length; i++) {
            expect(
              stayNights[i].getTime() - stayNights[i - 1].getTime()
            ).toBe(24 * 60 * 60 * 1000);
          }
        }
      )
    );
  });
});

describe("calculatePromoDiscount properties", () => {
  /** Distinct member ids so allocation sums are attributable per member. */
  const promoGuestsArb: fc.Arbitrary<PromoDiscountGuest[]> = fc
    .array(
      fc.record({
        hasMemberId: fc.boolean(),
        isMember: fc.boolean(),
        perNightRates: fc.array(fc.integer({ min: 0, max: 10_000 }), {
          minLength: 0,
          maxLength: 8,
        }),
      }),
      { minLength: 1, maxLength: 6 }
    )
    .map((raw) =>
      raw.map((g, i) => ({
        memberId: g.hasMemberId ? `member-${i}` : null,
        isMember: g.isMember,
        perNightRates: g.perNightRates,
      }))
    );

  const allMemberPromoGuestsArb = promoGuestsArb.map((guests) =>
    guests.map((g, i) => ({ ...g, memberId: `member-${i}`, isMember: true }))
  );

  function totalOf(guests: PromoDiscountGuest[]) {
    return guests.reduce(
      (sum, g) => sum + g.perNightRates.reduce((s, r) => s + r, 0),
      0
    );
  }

  const guestCapArb = fc.option(fc.integer({ min: 0, max: 8 }), { nil: null });
  const nightlyCapArb = fc.option(fc.integer({ min: 0, max: 10_000 }), {
    nil: null,
  });

  it("PERCENTAGE: discount is bounded, mirrored in the adjustment, and fully allocated to member guests", () => {
    fc.assert(
      fc.property(
        allMemberPromoGuestsArb,
        fc.integer({ min: 1, max: 100 }),
        guestCapArb,
        nightlyCapArb,
        (guests, percentOff, maxGuestsPerBooking, maxNightlyValueCents) => {
          const promo: PromoCodeInput = {
            type: "PERCENTAGE",
            percentOff,
            maxGuestsPerBooking,
            maxNightlyValueCents,
          };
          const totalPriceCents = totalOf(guests);
          const result = calculatePromoDiscount(promo, {
            totalPriceCents,
            guests,
          });

          expect(result.discountCents).toBeGreaterThanOrEqual(0);
          expect(result.discountCents).toBeLessThanOrEqual(totalPriceCents);
          // Mirror invariant (sum form avoids Object.is(-0, 0) failures).
          expect(result.priceAdjustmentCents + result.discountCents).toBe(0);
          expect(Number.isInteger(result.discountCents)).toBe(true);

          const allocated = result.allocations.reduce(
            (s, a) => s + a.discountCents,
            0
          );
          expect(allocated).toBe(result.discountCents);
        }
      )
    );
  });

  it("PERCENTAGE: per-member allocations sum to the capped total even when percentOff > 100 forces the cap to bind (#1206)", () => {
    fc.assert(
      fc.property(
        allMemberPromoGuestsArb,
        // Deliberately allow percentOff > 100 so the total-price cap binds and
        // the per-member allocations must be rescaled to stay in lockstep.
        fc.integer({ min: 1, max: 300 }),
        guestCapArb,
        nightlyCapArb,
        (guests, percentOff, maxGuestsPerBooking, maxNightlyValueCents) => {
          const promo: PromoCodeInput = {
            type: "PERCENTAGE",
            percentOff,
            maxGuestsPerBooking,
            maxNightlyValueCents,
          };
          const totalPriceCents = totalOf(guests);
          const result = calculatePromoDiscount(promo, {
            totalPriceCents,
            guests,
          });

          // Universal invariants (hold whether or not the cap binds).
          expect(result.discountCents).toBeGreaterThanOrEqual(0);
          expect(result.discountCents).toBeLessThanOrEqual(totalPriceCents);
          expect(result.priceAdjustmentCents + result.discountCents).toBe(0);
          expect(Number.isInteger(result.discountCents)).toBe(true);

          // The #1206 core invariant: the per-member split sums exactly to the
          // (possibly capped) total — no drift when the cap binds.
          const allocated = result.allocations.reduce(
            (s, a) => s + a.discountCents,
            0
          );
          expect(allocated).toBe(result.discountCents);

          for (const allocation of result.allocations) {
            expect(allocation.discountCents).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(allocation.discountCents)).toBe(true);
            // priceAdjustmentCents mirrors discountCents per member after rescale.
            expect(allocation.priceAdjustmentCents).toBe(
              -allocation.discountCents
            );
          }

          // A member can only be discounted beyond their own subtotal when
          // percentOff > 100 pushes a raw per-night discount above the night's
          // rate; proportional rescale preserves that over-representation. In the
          // reachable regime (percentOff <= 100) each allocation stays within the
          // member's subtotal.
          if (percentOff <= 100) {
            for (const allocation of result.allocations) {
              const guest = guests.find(
                (g) => g.memberId === allocation.memberId
              );
              expect(guest).toBeDefined();
              const subtotal = guest!.perNightRates.reduce((s, r) => s + r, 0);
              expect(allocation.discountCents).toBeLessThanOrEqual(subtotal);
            }
          }
        }
      )
    );
  });

  it("PERCENTAGE: largest-remainder rescale keeps the split exact when the cap binds (#1206 fixed case)", () => {
    // percentOff 150 makes each raw per-night discount exceed the night's rate,
    // so the uncapped discount (5 + 8 = 13) overshoots the 8c booking total and
    // the cap binds. The rescale must bring the split back to sum to 8 while
    // keeping each member within their own subtotal.
    const guests: PromoDiscountGuest[] = [
      { memberId: "member-0", isMember: true, perNightRates: [3] },
      { memberId: "member-1", isMember: true, perNightRates: [5] },
    ];
    const totalPriceCents = totalOf(guests);
    expect(totalPriceCents).toBe(8);

    const result = calculatePromoDiscount(
      { type: "PERCENTAGE", percentOff: 150 },
      { totalPriceCents, guests }
    );

    expect(result.discountCents).toBe(8);
    expect(result.priceAdjustmentCents).toBe(-8);

    const byMember = new Map(result.allocations.map((a) => [a.memberId, a]));
    expect(byMember.get("member-0")?.discountCents).toBe(3);
    expect(byMember.get("member-1")?.discountCents).toBe(5);
    expect(byMember.get("member-0")?.priceAdjustmentCents).toBe(-3);
    expect(byMember.get("member-1")?.priceAdjustmentCents).toBe(-5);

    const allocated = result.allocations.reduce(
      (s, a) => s + a.discountCents,
      0
    );
    expect(allocated).toBe(result.discountCents);
  });

  it("FIXED_AMOUNT: each guest is discounted at most their own stay total", () => {
    fc.assert(
      fc.property(
        allMemberPromoGuestsArb,
        fc.integer({ min: 1, max: 30_000 }),
        guestCapArb,
        (guests, valueCents, maxGuestsPerBooking) => {
          const promo: PromoCodeInput = {
            type: "FIXED_AMOUNT",
            valueCents,
            maxGuestsPerBooking,
          };
          const totalPriceCents = totalOf(guests);
          const result = calculatePromoDiscount(promo, {
            totalPriceCents,
            guests,
          });

          expect(result.discountCents).toBeGreaterThanOrEqual(0);
          expect(result.discountCents).toBeLessThanOrEqual(totalPriceCents);
          expect(result.priceAdjustmentCents + result.discountCents).toBe(0);

          for (const allocation of result.allocations) {
            const guest = guests.find((g) => g.memberId === allocation.memberId);
            expect(guest).toBeDefined();
            const guestTotal = guest!.perNightRates.reduce((s, r) => s + r, 0);
            expect(allocation.discountCents).toBeLessThanOrEqual(
              Math.min(valueCents, guestTotal)
            );
          }
        }
      )
    );
  });

  it("FREE_NIGHTS: never uses more nights than the per-guest and lifetime budgets allow", () => {
    fc.assert(
      fc.property(
        promoGuestsArb,
        fc.integer({ min: 1, max: 5 }),
        fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
        nightlyCapArb,
        (guests, freeNightsPerIndividual, remainingFreeNights, maxNightlyValueCents) => {
          const promo: PromoCodeInput = {
            type: "FREE_NIGHTS",
            freeNightsPerIndividual,
            maxNightlyValueCents,
          };
          const totalPriceCents = totalOf(guests);
          const result = calculatePromoDiscount(promo, {
            totalPriceCents,
            guests,
            remainingFreeNights,
          });

          expect(result.discountCents).toBeGreaterThanOrEqual(0);
          expect(result.discountCents).toBeLessThanOrEqual(totalPriceCents);
          expect(result.priceAdjustmentCents + result.discountCents).toBe(0);
          expect(result.freeNightsUsed).toBeLessThanOrEqual(
            guests.length * freeNightsPerIndividual
          );
          if (remainingFreeNights !== undefined) {
            expect(result.freeNightsUsed).toBeLessThanOrEqual(remainingFreeNights);
          }
        }
      )
    );
  });

  it("FIXED_NIGHTLY_PRICE: CAP_ONLY never raises the price and discount mirrors the adjustment", () => {
    fc.assert(
      fc.property(
        promoGuestsArb,
        fc.integer({ min: 1, max: 12_000 }),
        fc.constantFrom("CAP_ONLY", "SET_PRICE") as fc.Arbitrary<
          "CAP_ONLY" | "SET_PRICE"
        >,
        guestCapArb,
        (guests, fixedNightlyPriceCents, mode, maxGuestsPerBooking) => {
          const promo: PromoCodeInput = {
            type: "FIXED_NIGHTLY_PRICE",
            fixedNightlyPriceCents,
            fixedNightlyMode: mode,
            maxGuestsPerBooking,
          };
          const result = calculatePromoDiscount(promo, {
            totalPriceCents: totalOf(guests),
            guests,
          });

          if (mode === "CAP_ONLY") {
            expect(result.priceAdjustmentCents).toBeLessThanOrEqual(0);
          }
          expect(result.discountCents).toBe(
            Math.max(0, -result.priceAdjustmentCents)
          );
          expect(Number.isInteger(result.priceAdjustmentCents)).toBe(true);
        }
      )
    );
  });

  it("respects maxGuestsPerBooking and member-only eligibility in guest selection", () => {
    fc.assert(
      fc.property(
        promoGuestsArb,
        guestCapArb,
        fc.boolean(),
        (guests, maxGuestsPerBooking, memberGuestsOnly) => {
          const promo: PromoCodeInput = {
            type: "PERCENTAGE",
            percentOff: 10,
            maxGuestsPerBooking,
            memberGuestsOnly,
          };
          const selected = selectPromoDiscountGuests(promo, guests);

          expect(selected.length).toBeLessThanOrEqual(
            Math.max(0, maxGuestsPerBooking ?? guests.length)
          );
          if (memberGuestsOnly) {
            for (const { guest } of selected) {
              expect(guest.isMember).toBe(true);
            }
          }
          // Selection prefers the most expensive stays first.
          const totals = selected.map(({ guest }) =>
            guest.perNightRates.reduce((s, r) => s + r, 0)
          );
          for (let i = 1; i < totals.length; i++) {
            expect(totals[i - 1]).toBeGreaterThanOrEqual(totals[i]);
          }
        }
      )
    );
  });
});
