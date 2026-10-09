import { describe, expect, it, vi } from "vitest";

import {
  classifyFinishedStayChangeFeeRule,
  defaultCorrectionSettlementMethod,
  FINISHED_STAY_INVOICE_RAISED_MESSAGE,
  FINISHED_STAY_UNKNOWN_NIGHT_PRICE_MESSAGE,
  finishedStayNoticeDay,
  finishedStayRemovalFeeCents,
  finishedStayRemovedPortion,
  recordFinishedStayFeeOwed,
  type RemovalPromoRows,
} from "@/lib/booking-finished-stay-correction";
import {
  FINISHED_STAY_CORRECTION_FIELD_MESSAGE,
  FINISHED_STAY_CORRECTION_FUTURE_NIGHT_MESSAGE,
  resolveTargetDates,
  type BatchModifyInput,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";
import { daysUntilDate } from "@/lib/policies/cancellation";

/**
 * #3750: the finished-stay correction's own rules — the owner's change-fee rule
 * (decision record, 6 Oct 2026) and the window `resolveTargetDates` opens for an
 * officer-approved LOCKED_PERIOD change request on a stay that has finished.
 * Fixtures sit relative to the frozen suite clock (1 July 2026).
 */

function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const TODAY = day("2026-07-01");

function makeBooking(status = "COMPLETED"): LoadedBookingForModify {
  return {
    status,
    checkIn: day("2026-06-10"),
    checkOut: day("2026-06-14"),
    guests: [
      { id: "g1", stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
      { id: "g2", stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
    ],
  } as unknown as LoadedBookingForModify;
}

function resolve(input: BatchModifyInput, booking = makeBooking()) {
  return resolveTargetDates({
    booking,
    role: "ADMIN",
    input,
    today: TODAY,
    finishedStayCorrection: true,
  });
}

const unchanged = {
  stored: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
  proposed: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
};

describe("finished-stay change-fee rule (#3750 owner decision)", () => {
  it("adding guests while every kept guest keeps their nights is add-only: no change fee", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 2,
        removedGuestCount: 0,
        remainingGuests: [unchanged, unchanged],
      }),
    ).toBe("ADD_ONLY_NO_FEE");
  });

  it("reads kept guests' nights, not whether the request mentioned stay ranges", () => {
    // The member's form resends every guest's range; a resent, identical range
    // must not turn an add into a same-day-fee change. Explicit night rows that
    // equal the contiguous range are the same nights.
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 1,
        removedGuestCount: 0,
        remainingGuests: [
          {
            stored: {
              stayStart: day("2026-06-10"),
              stayEnd: day("2026-06-12"),
              nights: [{ stayDate: day("2026-06-11") }, { stayDate: day("2026-06-10") }],
            },
            proposed: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-12") },
          },
        ],
      }),
    ).toBe("ADD_ONLY_NO_FEE");
  });

  it("a removal is charged as a same-day notice change", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 0,
        removedGuestCount: 1,
        remainingGuests: [unchanged],
      }),
    ).toBe("SAME_DAY_NOTICE");
  });

  it("a swap (a removal with an add) is charged the same-day fee on the removed portion", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 1,
        removedGuestCount: 1,
        remainingGuests: [unchanged],
      }),
    ).toBe("SWAP_SAME_DAY_NOTICE");
  });

  it("charges a swap what the same-day tier keeps of the removed portion, by refund method", () => {
    const policyRules = [
      { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
      { daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 80, fixedFeeCents: 500, creditFixedFeeCents: 0 },
    ];
    // Card: 50% of 10,000 back, less the $5 fixed fee -> 4,500 back, 5,500 kept.
    expect(finishedStayRemovalFeeCents({ removedPortionCents: 10_000, policyRules, settlementMethod: "card" })).toBe(5_500);
    // Credit: 80% back -> 2,000 kept.
    expect(finishedStayRemovalFeeCents({ removedPortionCents: 10_000, policyRules, settlementMethod: "credit" })).toBe(2_000);
    // A club with no tiers keeps it all, as a same-day removal would.
    expect(finishedStayRemovalFeeCents({ removedPortionCents: 10_000, policyRules: [], settlementMethod: "card" })).toBe(10_000);
    // A full-refund same-day tier charges nothing.
    expect(
      finishedStayRemovalFeeCents({
        removedPortionCents: 10_000,
        policyRules: [{ daysBeforeStay: 0, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 }],
        settlementMethod: "card",
      }),
    ).toBe(0);
  });

  it("an add that also moves a kept guest's nights is not add-only", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 1,
        removedGuestCount: 0,
        remainingGuests: [
          {
            stored: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
            proposed: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-13") },
          },
        ],
      }),
    ).toBe("SAME_DAY_NOTICE");
  });

  it("a date or range change with nobody added is a same-day notice change", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 0,
        removedGuestCount: 0,
        remainingGuests: [unchanged],
      }),
    ).toBe("SAME_DAY_NOTICE");
  });

  it("measures the notice period from the stay's own check-in, so it is exactly 0 days", () => {
    const booking = makeBooking();
    const noticeDay = finishedStayNoticeDay(booking);
    expect(noticeDay).toBe("2026-06-10");
    expect(daysUntilDate(booking.checkIn, noticeDay)).toBe(0);
  });
});

describe("resolveTargetDates — finished-stay correction window (#3750)", () => {
  it("admits a past guest add and reports the mode it engaged", () => {
    const dates = resolve({
      addGuests: [
        { firstName: "Late", lastName: "Guest", ageTier: "ADULT", isMember: false },
      ],
      notifyMember: true,
    });
    expect(dates.isFinishedStayCorrection).toBe(true);
    expect(dates.isInProgressEdit).toBe(false);
    expect(dates.newCheckIn.toISOString().slice(0, 10)).toBe("2026-06-10");
  });

  it("admits a change to the finished stay's check-in", () => {
    const dates = resolve({ checkIn: "2026-06-11" });
    expect(dates.checkInChanged).toBe(true);
    expect(dates.isFinishedStayCorrection).toBe(true);
  });

  it("refuses anything a change request cannot carry", () => {
    expect(() => resolve({ promoCode: "SUMMER" })).toThrow(
      FINISHED_STAY_CORRECTION_FIELD_MESSAGE,
    );
    expect(() =>
      resolve({ guestUpdates: [{ guestId: "g1", firstName: "A", lastName: "B" }] }),
    ).toThrow(FINISHED_STAY_CORRECTION_FIELD_MESSAGE);
    expect(() => resolve({ applyCreditCents: 0 })).toThrow(
      FINISHED_STAY_CORRECTION_FIELD_MESSAGE,
    );
  });

  it("refuses to reach a night on or after today", () => {
    expect(() => resolve({ checkOut: "2026-07-02" })).toThrow(
      FINISHED_STAY_CORRECTION_FUTURE_NIGHT_MESSAGE,
    );
    // Checking out today leaves every night before today, which is allowed.
    expect(resolve({ checkOut: "2026-07-01" }).isFinishedStayCorrection).toBe(true);
  });

  it("does not report the mode for a stay that has not finished", () => {
    const booking = {
      ...makeBooking("PAID"),
      checkIn: day("2026-06-29"),
      checkOut: day("2026-07-03"),
    } as LoadedBookingForModify;
    const dates = resolve({}, booking);
    expect(dates.isFinishedStayCorrection).toBe(false);
    expect(dates.isInProgressEdit).toBe(true);
  });

  it("keeps a member out entirely, flag or no flag", () => {
    expect(() =>
      resolveTargetDates({
        booking: makeBooking(),
        role: "USER",
        input: {},
        today: TODAY,
        finishedStayCorrection: true,
      }),
    ).toThrow("This booking has no future nights available for self-service changes");
  });
});

describe("the removed portion a correction is charged on (#3955 F3/F4/F5)", () => {
  const NO_PROMO: RemovalPromoRows = { byNight: new Map(), byGuest: new Map() };
  const nights = (dates: string[], cents: number) =>
    dates.map((date) => ({ stayDate: day(date), priceCents: cents }));
  const guest = (id: string, dates: string[], cents = 4_000) => ({
    id,
    priceCents: dates.length * cents,
    stayStart: day(dates[0]),
    stayEnd: day("2026-06-14"),
    nights: nights(dates, cents),
  });
  const FULL = ["2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"];

  it("counts a removed guest's every night", () => {
    expect(
      finishedStayRemovedPortion({
        storedGuests: [guest("g1", FULL), guest("g2", FULL)],
        keptStays: new Map([["g1", { stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") }]]),
        booking: { totalPriceCents: 32_000, promoAdjustmentCents: 0 },
        promoRows: NO_PROMO,
      }),
    ).toEqual({ grossCents: 16_000, netCents: 16_000 });
  });

  it("counts the nights a kept guest's trimmed stay drops, so trimming plus adding cannot dodge the fee", () => {
    expect(
      finishedStayRemovedPortion({
        storedGuests: [guest("g1", FULL)],
        keptStays: new Map([["g1", { stayStart: day("2026-06-10"), stayEnd: day("2026-06-12") }]]),
        booking: { totalPriceCents: 16_000, promoAdjustmentCents: 0 },
        promoRows: NO_PROMO,
      }),
    ).toEqual({ grossCents: 8_000, netCents: 8_000 });
  });

  it("values removed nights net of their own recorded promotion when the rows reconcile", () => {
    const promoRows: RemovalPromoRows = {
      byNight: new Map([
        ["g2|2026-06-10", -1_000],
        ["g2|2026-06-11", -1_000],
        ["g1|2026-06-10", -500],
      ]),
      byGuest: new Map(),
    };
    expect(
      finishedStayRemovedPortion({
        storedGuests: [guest("g1", ["2026-06-10", "2026-06-11"]), guest("g2", ["2026-06-10", "2026-06-11"])],
        keptStays: new Map([["g1", { stayStart: day("2026-06-10"), stayEnd: day("2026-06-12") }]]),
        booking: { totalPriceCents: 16_000, promoAdjustmentCents: -2_500 },
        promoRows,
      }),
    ).toEqual({ grossCents: 8_000, netCents: 6_000 });
  });

  it("shares the promotion in proportion when its rows do not reconcile", () => {
    expect(
      finishedStayRemovedPortion({
        storedGuests: [guest("g1", ["2026-06-10", "2026-06-11"]), guest("g2", ["2026-06-10", "2026-06-11"])],
        keptStays: new Map([["g1", { stayStart: day("2026-06-10"), stayEnd: day("2026-06-12") }]]),
        booking: { totalPriceCents: 16_000, promoAdjustmentCents: -4_000 },
        promoRows: NO_PROMO,
      }),
    ).toEqual({ grossCents: 8_000, netCents: 6_000 });
  });

  it("refuses to value a removed night whose price is not known", () => {
    expect(() =>
      finishedStayRemovedPortion({
        storedGuests: [
          { ...guest("g1", ["2026-06-10"]), nights: [{ stayDate: day("2026-06-10"), priceCents: null }] },
        ],
        keptStays: new Map(),
        booking: { totalPriceCents: 4_000, promoAdjustmentCents: 0 },
        promoRows: NO_PROMO,
      }),
    ).toThrow(FINISHED_STAY_UNKNOWN_NIGHT_PRICE_MESSAGE);
  });

  it("defaults the refund to the way the booking was paid", () => {
    expect(defaultCorrectionSettlementMethod({ amountCents: 10_000, creditAppliedCents: 0 })).toBe("card");
    expect(defaultCorrectionSettlementMethod({ amountCents: 0, creditAppliedCents: 10_000 })).toBe("credit");
    expect(defaultCorrectionSettlementMethod(null)).toBe("card");
  });
});

/**
 * #3955 review X4: the fee is claimed against the invoice link the edit read,
 * so a primary invoice persisted mid-edit refuses the write (the request stays
 * pending) instead of leaving a fee that no invoice and no document carries.
 */
describe("recordFinishedStayFeeOwed (#3955 X4)", () => {
  const txWith = (count: number) => {
    const updateMany = vi.fn().mockResolvedValue({ count });
    const create = vi.fn().mockResolvedValue({});
    return { tx: { payment: { updateMany, create } } as never, updateMany, create };
  };

  it("increments the fee only while the payment still has the invoice link the edit read", async () => {
    const { tx, updateMany } = txWith(1);
    await recordFinishedStayFeeOwed(tx, {
      bookingId: "bk_1",
      payment: { id: "pay_1", xeroInvoiceId: null },
      changeFeeCents: 2_500,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "pay_1", xeroInvoiceId: null },
      data: { changeFeeCents: { increment: 2_500 } },
    });
  });

  it("refuses when a primary invoice was persisted since the edit read the payment", async () => {
    const { tx } = txWith(0);
    await expect(
      recordFinishedStayFeeOwed(tx, {
        bookingId: "bk_1",
        payment: { id: "pay_1", xeroInvoiceId: null },
        changeFeeCents: 2_500,
      }),
    ).rejects.toThrow(FINISHED_STAY_INVOICE_RAISED_MESSAGE);
  });

  it("creates a fee-only payment row for a booking that never reached its pay step", async () => {
    const { tx, create, updateMany } = txWith(1);
    await recordFinishedStayFeeOwed(tx, { bookingId: "bk_1", payment: null, changeFeeCents: 2_500 });
    expect(create).toHaveBeenCalledWith({ data: { bookingId: "bk_1", amountCents: 0, changeFeeCents: 2_500 } });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
