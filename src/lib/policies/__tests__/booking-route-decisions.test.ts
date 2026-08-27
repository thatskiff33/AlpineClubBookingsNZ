import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  calculateBookingCreditApplication,
  calculateBookingHoldDecision,
  calculateCancellationPreview,
  GROUP_DISCOUNT_EDIT_OFF_NOTICE,
  groupDiscountEditNotice,
  isGroupDiscountAppliedToBooking,
  toEditTimeGroupDiscountConfig,
  toGroupDiscountConfig,
  toSeasonRateData,
  type CancellationRule,
} from "@/lib/policies";
import { requireCalendarDate } from "@/lib/club-time";

describe("booking route policy decisions", () => {
  it("normalizes enabled group discount settings and ignores disabled settings", () => {
    expect(
      toGroupDiscountConfig({ enabled: true, minGroupSize: 5, summerOnly: true })
    ).toEqual({ enabled: true, minGroupSize: 5, summerOnly: true, rateMembershipTypeId: null });
    expect(
      toGroupDiscountConfig({
        enabled: true,
        minGroupSize: 5,
        summerOnly: true,
        rateMembershipTypeId: "type-full",
      })
    ).toEqual({ enabled: true, minGroupSize: 5, summerOnly: true, rateMembershipTypeId: "type-full" });
    expect(
      toGroupDiscountConfig({ enabled: false, minGroupSize: 5, summerOnly: true })
    ).toBeUndefined();
  });

  // #2770 (INV-MOD-026). The edit-time mapper is the ONE place the club's
  // `applyToEdits` switch is applied, so these four cases are the whole
  // semantics of the switch: on, it is the creation answer verbatim; off, it is
  // the SAME `undefined` a disabled discount produces, which is what makes an
  // off club price byte-identically to a club that never enabled the discount
  // rather than through some second rule.
  describe("toEditTimeGroupDiscountConfig — the edit-time switch (#2770)", () => {
    const enabled = {
      enabled: true,
      minGroupSize: 5,
      summerOnly: true,
      rateMembershipTypeId: "type-full",
    };

    it("passes the discount through unchanged when the switch is on", () => {
      expect(
        toEditTimeGroupDiscountConfig({ ...enabled, applyToEdits: true }),
      ).toEqual(toGroupDiscountConfig(enabled));
      // Not merely equal to the creation answer — equal to the REAL config, so a
      // future edit to either mapper cannot make both wrong together.
      expect(
        toEditTimeGroupDiscountConfig({ ...enabled, applyToEdits: true }),
      ).toEqual({
        enabled: true,
        minGroupSize: 5,
        summerOnly: true,
        rateMembershipTypeId: "type-full",
      });
    });

    it("resolves to the same absent config as a disabled discount when the switch is off", () => {
      expect(
        toEditTimeGroupDiscountConfig({ ...enabled, applyToEdits: false }),
      ).toBeUndefined();
      expect(
        toEditTimeGroupDiscountConfig({ ...enabled, applyToEdits: false }),
      ).toEqual(
        toGroupDiscountConfig({
          enabled: false,
          minGroupSize: 5,
          summerOnly: true,
        }),
      );
    });

    it("stays undefined when the discount itself is off, whatever the switch says", () => {
      // The switch cannot turn a discount ON. A club that has not enabled the
      // group discount is untouched by #2770 in either position.
      expect(
        toEditTimeGroupDiscountConfig({
          enabled: false,
          minGroupSize: 5,
          summerOnly: true,
          applyToEdits: true,
        }),
      ).toBeUndefined();
      expect(
        toEditTimeGroupDiscountConfig({
          enabled: false,
          minGroupSize: 5,
          summerOnly: true,
          applyToEdits: false,
        }),
      ).toBeUndefined();
    });

    it("treats a missing row as no discount, exactly like the creation mapper", () => {
      expect(toEditTimeGroupDiscountConfig(null)).toBeUndefined();
      expect(toEditTimeGroupDiscountConfig(undefined)).toBeUndefined();
    });

    /**
     * The stay the note is judged against. A SUMMER season (so `summerOnly: true`
     * is satisfied) and a party of five (so `minGroupSize: 5` is satisfied), which
     * is the only shape where a withheld discount is worth explaining.
     */
    const summerSeasons = toSeasonRateData([
      {
        id: "summer",
        startDate: new Date("2026-11-01"),
        endDate: new Date("2027-03-31"),
        type: "SUMMER",
        membershipTypeRates: [],
      },
    ]);
    const winterSeasons = toSeasonRateData([
      {
        id: "winter",
        startDate: new Date("2026-04-01"),
        endDate: new Date("2026-10-31"),
        type: "WINTER",
        membershipTypeRates: [],
      },
    ]);
    function party(size: number) {
      return Array.from({ length: size }, () => ({
        ageTier: "ADULT" as const,
        isMember: false,
      }));
    }
    const QUALIFYING_STAY = {
      checkIn: new Date("2026-12-10"),
      checkOut: new Date("2026-12-13"),
      guests: party(5),
      seasons: summerSeasons,
    };

    // #2770 D2. The note is DERIVED from the mapper, so it cannot contradict the
    // price: it is present exactly when the club runs a discount, the edit does
    // not get it, and the edit would otherwise have had it.
    it("explains the withheld discount exactly when there is one to withhold", () => {
      expect(
        groupDiscountEditNotice(
          { ...enabled, applyToEdits: false },
          QUALIFYING_STAY,
        ),
      ).toBe(GROUP_DISCOUNT_EDIT_OFF_NOTICE);
      expect(
        groupDiscountEditNotice(
          { ...enabled, applyToEdits: true },
          QUALIFYING_STAY,
        ),
      ).toBeNull();
      expect(
        groupDiscountEditNotice(
          {
            enabled: false,
            minGroupSize: 5,
            summerOnly: true,
            applyToEdits: false,
          },
          QUALIFYING_STAY,
        ),
      ).toBeNull();
      expect(groupDiscountEditNotice(null, QUALIFYING_STAY)).toBeNull();
    });

    // The narrowing (#2770 D2 review). D2's purpose was to explain a number that
    // went UP, so a note beside a number that did not move is worse than silence —
    // the officer reads the switch as the reason for a price the switch did not
    // touch. Both ways an edit can fail to qualify are pinned.
    it("stays silent when this edit could not have been discounted anyway", () => {
      // A party below the club's minimum: the same edit costs the same cents with
      // the switch on.
      expect(
        groupDiscountEditNotice(
          { ...enabled, applyToEdits: false },
          { ...QUALIFYING_STAY, guests: party(4) },
        ),
      ).toBeNull();
      // A winter stay at a summer-only club, same reason.
      expect(
        groupDiscountEditNotice({ ...enabled, applyToEdits: false }, {
          checkIn: new Date("2026-06-10"),
          checkOut: new Date("2026-06-13"),
          guests: party(5),
          seasons: winterSeasons,
        }),
      ).toBeNull();
      // And `summerOnly: false` puts the winter stay back in scope, so the
      // silence above is really about the season and not about the dates.
      expect(
        groupDiscountEditNotice(
          { ...enabled, summerOnly: false, applyToEdits: false },
          {
            checkIn: new Date("2026-06-10"),
            checkOut: new Date("2026-06-13"),
            guests: party(5),
            seasons: winterSeasons,
          },
        ),
      ).toBe(GROUP_DISCOUNT_EDIT_OFF_NOTICE);
    });

    it("never states a note while the same setting still yields a discount config", () => {
      // The property the derivation exists for: note and config are mutually
      // exclusive, so a quote can never show one and charge the other. Held
      // across every setting state AND every stay shape, because the narrowing
      // above must not have opened a case where both appear.
      for (const applyToEdits of [true, false]) {
        for (const isEnabled of [true, false]) {
          for (const summerOnly of [true, false]) {
            for (const guests of [party(4), party(5)]) {
              for (const seasons of [summerSeasons, winterSeasons]) {
                const setting = {
                  ...enabled,
                  enabled: isEnabled,
                  summerOnly,
                  applyToEdits,
                };
                const config = toEditTimeGroupDiscountConfig(setting);
                const note = groupDiscountEditNotice(setting, {
                  ...QUALIFYING_STAY,
                  guests,
                  seasons,
                });
                expect(config !== undefined && note !== null).toBe(false);
              }
            }
          }
        }
      }
    });
  });

  it("detects group-discount application using the route response contract", () => {
    const seasons = toSeasonRateData([
      {
        id: "summer",
        startDate: new Date("2026-11-01"),
        endDate: new Date("2027-03-31"),
        type: "SUMMER",
        membershipTypeRates: [],
      },
    ]);

    expect(
      isGroupDiscountAppliedToBooking({
        checkIn: new Date("2026-12-10"),
        checkOut: new Date("2026-12-12"),
        guestCount: 5,
        seasons,
        groupDiscount: { enabled: true, minGroupSize: 5, summerOnly: true },
      })
    ).toBe(true);
    expect(
      isGroupDiscountAppliedToBooking({
        checkIn: new Date("2026-12-10"),
        checkOut: new Date("2026-12-12"),
        guestCount: 4,
        seasons,
        groupDiscount: { enabled: true, minGroupSize: 5, summerOnly: true },
      })
    ).toBe(false);
  });

  it("calculates booking hold status with ceil day semantics", () => {
    expect(
      calculateBookingHoldDecision({
        hasNonMembers: true,
        checkIn: new Date("2026-07-10T12:00:00.000Z"),
        holdDays: 7,
        now: new Date("2026-07-03T13:00:00.000Z"),
      })
    ).toMatchObject({
      daysUntilCheckIn: 7,
      shouldBePending: false,
      status: BookingStatus.PAYMENT_PENDING,
    });

    expect(
      calculateBookingHoldDecision({
        hasNonMembers: true,
        checkIn: new Date("2026-07-11T12:00:00.000Z"),
        holdDays: 7,
        now: new Date("2026-07-03T13:00:00.000Z"),
      }).status
    ).toBe(BookingStatus.PENDING);
  });

  it("keeps non-member bookings on the payment path inside the enabled hold window", () => {
    expect(
      calculateBookingHoldDecision({
        hasNonMembers: true,
        holdEnabled: true,
        checkIn: new Date("2026-07-10T12:00:00.000Z"),
        holdDays: 7,
        now: new Date("2026-07-03T12:00:00.000Z"),
      })
    ).toMatchObject({
      daysUntilCheckIn: 7,
      holdEnabled: true,
      shouldBePending: false,
      status: BookingStatus.PAYMENT_PENDING,
    });
  });

  it("disables member-priority holds regardless of the threshold", () => {
    expect(
      calculateBookingHoldDecision({
        hasNonMembers: true,
        holdEnabled: false,
        checkIn: new Date("2026-10-01T00:00:00.000Z"),
        holdDays: 7,
        now: new Date("2026-07-03T00:00:00.000Z"),
      })
    ).toMatchObject({
      holdEnabled: false,
      shouldBePending: false,
      status: BookingStatus.PAYMENT_PENDING,
    });
  });

  it("does not mark a booking pending at a 365-day threshold until it is beyond that window", () => {
    expect(
      calculateBookingHoldDecision({
        hasNonMembers: true,
        holdEnabled: true,
        checkIn: new Date("2027-07-03T00:00:00.000Z"),
        holdDays: 365,
        now: new Date("2026-07-03T00:00:00.000Z"),
      })
    ).toMatchObject({
      daysUntilCheckIn: 365,
      shouldBePending: false,
      status: BookingStatus.PAYMENT_PENDING,
    });
  });

  it("validates booking credit application against balance, status, and price", () => {
    expect(
      calculateBookingCreditApplication({
        requestedCreditCents: 2500,
        creditBalanceCents: 3000,
        finalPriceCents: 4000,
        status: BookingStatus.PAYMENT_PENDING,
      })
    ).toEqual({ creditAppliedCents: 2500, effectivePriceCents: 1500 });

    expect(() =>
      calculateBookingCreditApplication({
        requestedCreditCents: 5000,
        creditBalanceCents: 3000,
        finalPriceCents: 4000,
        status: BookingStatus.PAYMENT_PENDING,
      })
    ).toThrow("Insufficient credit: 3000 cents available, 5000 requested");

    expect(
      calculateBookingCreditApplication({
        requestedCreditCents: 2500,
        creditBalanceCents: 3000,
        finalPriceCents: 4000,
        status: BookingStatus.PENDING,
      })
    ).toEqual({ creditAppliedCents: 0, effectivePriceCents: 4000 });
  });

  it("calculates cancellation preview amounts without route-side refund math", () => {
    const policyRules: CancellationRule[] = [
      {
        daysBeforeStay: 7,
        refundPercentage: 50,
        creditRefundPercentage: 75,
        fixedFeeCents: 1000,
        creditFixedFeeCents: 500,
      },
      { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0 },
    ];

    expect(
      calculateCancellationPreview({
        payment: {
          amountCents: 10000,
          refundedAmountCents: 1000,
          changeFeeCents: 1000,
          creditAppliedCents: 2000,
        },
        finalPriceCents: 8000,
        checkIn: new Date("2026-07-15T00:00:00.000Z"),
        policyRules,
        // #3123 — the CLUB's calendar day, required. Same ten-day count the old
        // `now: new Date("2026-07-05T00:00:00.000Z")` produced once the
        // container's zone had projected it, so the money below is unchanged.
        todayAtClub: requireCalendarDate("2026-07-05"),
      })
    ).toMatchObject({
      refundAmountCents: 3000,
      keptAmountCents: 6000,
      changeFeeCents: 1000,
      refundPercentage: 50,
      creditRefundAmountCents: 5500,
      creditRefundPercentage: 75,
      // #1164 / D7: applied credit is now tiered by the CARD tier (50%), not
      // restored at 100%. refundableBase 8000 -> cardGross 4000 absorbs the full
      // 1000 fixed fee (feeRemainder 0), so the 2000 applied credit restores
      // 50% = 1000.
      creditRestoredCents: 1000,
      totalPaidCents: 9000,
    });
  });

  it("caps the preview refund base at the booking's current value (#1031)", () => {
    const policyRules: CancellationRule[] = [
      { daysBeforeStay: 7, refundPercentage: 100 },
      { daysBeforeStay: 0, refundPercentage: 0 },
    ];

    // A prior reduction left the mirror stale: paid 30000, booking now worth
    // 20000. The preview must promise at most the booking's current value.
    expect(
      calculateCancellationPreview({
        payment: {
          amountCents: 30000,
          refundedAmountCents: 0,
          changeFeeCents: 0,
          creditAppliedCents: 0,
        },
        finalPriceCents: 20000,
        checkIn: new Date("2026-07-15T00:00:00.000Z"),
        policyRules,
        // #3123 — the CLUB's calendar day, required. Same ten-day count the old
        // `now: new Date("2026-07-05T00:00:00.000Z")` produced once the
        // container's zone had projected it, so the money below is unchanged.
        todayAtClub: requireCalendarDate("2026-07-05"),
      })
    ).toMatchObject({
      refundAmountCents: 20000,
      refundPercentage: 100,
    });
  });
});
