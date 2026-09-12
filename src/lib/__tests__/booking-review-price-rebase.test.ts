import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingUpdateMany: vi.fn(),
  bookingModificationCreate: vi.fn(),
  recalculateBookingPromo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
// The tree's ONE promotion recompute. Mocked at its boundary because what this
// module owes is (a) that it calls that function rather than writing a second
// spelling of the cap, (b) that it hands it the NEW total and the strands' own
// night prices, and (c) that it stores what comes back. Whether the recompute
// itself caps correctly is proved where it lives, against the real pricing
// engine, by the guest-removal and waitlist suites.
vi.mock("@/lib/booking-guest-removal-service", () => ({
  recalculateBookingPromo: (...a: unknown[]) =>
    mocks.recalculateBookingPromo(...a),
}));

import {
  REBASE_NEGATIVE_PRICE_MESSAGE,
  REBASE_RACED_MESSAGE,
  REBASE_STRAND_NOT_ON_BOOKING_MESSAGE,
  rebaseBookingPriceFromStrands,
  rebaseChangedTheBooking,
  rebaseDivergesFromIssuedInvoice,
  rebaseMovedStoredMoney,
  recordBookingPriceRebaseHistory,
  type BookingPriceRebase,
} from "@/lib/booking-review-price-rebase";
import { requireCalendarDate } from "@/lib/club-time";
import { selectBookingMoneyBuildUp } from "@/lib/night-adjustment-write";

const store = {
  booking: {
    findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a),
    updateMany: (...a: unknown[]) => mocks.bookingUpdateMany(...a),
  },
  bookingModification: {
    create: (...a: unknown[]) => mocks.bookingModificationCreate(...a),
  },
  // #3276: the re-base records the promotion build-up over the strands' nights.
  bookingGuestNightAdjustment: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  promoRedemption: { findUnique: vi.fn().mockResolvedValue(null) },
  bookingGuestNight: {
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
} as never;

const TODAY = requireCalendarDate("2026-07-01");

const AUG_1 = new Date("2026-08-01T00:00:00.000Z");
const AUG_2 = new Date("2026-08-02T00:00:00.000Z");

/**
 * The worked case from #3219: two guests at $100.00 a head, a booking headline
 * FROZEN at $200.00 by the park, and a 75%-off code carrying a $150.00 discount
 * against it. One guest is then removed by the parked edit.
 */
function bookingWithStrands(
  guests: Array<{
    id: string;
    priceCents: number;
    nights: Array<{ stayDate: Date; priceCents: number | null }>;
  }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: null,
    checkIn: AUG_1,
    totalPriceCents: 20_000,
    discountCents: 15_000,
    promoAdjustmentCents: -15_000,
    finalPriceCents: 5_000,
    promoRedemption: null,
    nightAdjustments: [],
    guests: guests.map((guest) => ({
      memberId: null,
      isMember: false,
      ...guest,
      nights: guest.nights.map((night) => ({
        ...night,
        priceSource: "SOLD" as const,
      })),
    })),
    ...overrides,
  };
}

const SURVIVING_STRAND = {
  id: "guest-1",
  priceCents: 10_000,
  nights: [
    { stayDate: AUG_1, priceCents: 5_000 },
    { stayDate: AUG_2, priceCents: 5_000 },
  ],
};

const STORED_MONEY_SELECTION = selectBookingMoneyBuildUp({
  operation: "REVIEW_REBASE",
  baseEvidence: { kind: "EXACT", amountCents: 24_000 },
  rows: [],
  redemption: null,
  derivedCents: 24_000,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bookingModificationCreate.mockResolvedValue({ id: "mod-1" });
  // The honest answer for the worked case: 75% of the $100.00 that is left.
  mocks.recalculateBookingPromo.mockResolvedValue({
    adjustmentTargets: [],
    discount: null,
    newDiscountCents: 7_500,
    newPromoAdjustmentCents: -7_500,
    promoRemoved: false,
    promoCoverage: null,
  });
  mocks.bookingFindUnique.mockResolvedValue(
    bookingWithStrands([SURVIVING_STRAND]),
  );
});

describe("re-pricing a booking from its strands (#3219)", () => {
  it("sums the surviving strands and writes all four money columns, fenced on all four", async () => {
    const outcome = await rebaseBookingPriceFromStrands({
      bookingId: "booking-1",
      repairedStrand: { bookingGuestId: "guest-1", totalCents: 10_000 },
      todayAtClub: TODAY,
      store,
    });

    expect(outcome).toEqual({
      rebased: true,
      rebase: {
        previousTotalPriceCents: 20_000,
        previousDiscountCents: 15_000,
        previousPromoAdjustmentCents: -15_000,
        previousFinalPriceCents: 5_000,
        newTotalPriceCents: 10_000,
        newDiscountCents: 7_500,
        newPromoAdjustmentCents: -7_500,
        newFinalPriceCents: 2_500,
        promoRemoved: false,
      },
      moneyBuildUpSelection: expect.objectContaining({
        source: "DERIVED_COMPATIBILITY_FALLBACK",
        derivedCents: 2_500,
        selectedCents: 2_500,
        fallbackClassification: "STORED_SIDE_DEFECT",
      }),
    });
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        totalPriceCents: 20_000,
        discountCents: 15_000,
        promoAdjustmentCents: -15_000,
        finalPriceCents: 5_000,
      },
      data: {
        totalPriceCents: 10_000,
        discountCents: 7_500,
        promoAdjustmentCents: -7_500,
        finalPriceCents: 2_500,
      },
    });
  });

  it("THE PROMOTION FOLLOWS THE STRANDS: the recompute is handed the NEW total and the strands' own night prices", async () => {
    /*
      The wiring this test pins is the whole of the promotion decision. Hand the
      recompute the OLD total and the discount is re-capped against a booking
      that no longer exists; hand it rates that did not come from the strands and
      it is pricing something else. Both would put the frozen $150.00 back within
      reach, and the frozen figure is what produces MINUS $50.00.
    */
    await rebaseBookingPriceFromStrands({
      bookingId: "booking-1",
      repairedStrand: { bookingGuestId: "guest-1", totalCents: 10_000 },
      todayAtClub: TODAY,
      store,
    });

    expect(mocks.recalculateBookingPromo).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        newTotalPriceCents: 10_000,
        todayAtClub: TODAY,
        guestNightRates: [
          {
            bookingGuestId: "guest-1",
            memberId: null,
            isMember: false,
            perNightRates: [5_000, 5_000],
            nightDates: [AUG_1, AUG_2],
            firstNight: AUG_1,
          },
        ],
      }),
    );
  });

  it("carries NOTHING through: a promotion the recompute removes is written as removed", async () => {
    mocks.recalculateBookingPromo.mockResolvedValue({
    adjustmentTargets: [],
    discount: null,
      newDiscountCents: 0,
      newPromoAdjustmentCents: 0,
      promoRemoved: true,
      promoCoverage: null,
    });

    const outcome = await rebaseBookingPriceFromStrands({
      bookingId: "booking-1",
      repairedStrand: { bookingGuestId: "guest-1", totalCents: 10_000 },
      todayAtClub: TODAY,
      store,
    });

    expect(outcome).toMatchObject({
      rebased: true,
      rebase: { newFinalPriceCents: 10_000, promoRemoved: true },
    });
  });

  it("THE LAST LINE OF DEFENCE: a price below zero is refused and nothing is written", async () => {
    /*
      Unreachable while the recompute re-caps, and kept because THIS is the one
      column in the tree that has been shown able to go negative: the frozen
      $150.00 against a $100.00 remainder is MINUS $50.00. If the cap ever stops
      holding, the transaction rolls back loudly rather than storing a shape the
      refund cap and the reconciliation law would both read as nonsense.
    */
    mocks.recalculateBookingPromo.mockResolvedValue({
    adjustmentTargets: [],
    discount: null,
      newDiscountCents: 15_000,
      newPromoAdjustmentCents: -15_000,
      promoRemoved: false,
      promoCoverage: null,
    });

    await expect(
      rebaseBookingPriceFromStrands({
        bookingId: "booking-1",
        repairedStrand: { bookingGuestId: "guest-1", totalCents: 10_000 },
        todayAtClub: TODAY,
        store,
      }),
    ).rejects.toThrow(REBASE_NEGATIVE_PRICE_MESSAGE);
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("EXACTLY ZERO IS ALLOWED, because a promotion that covers the whole stay is a real shape", async () => {
    mocks.recalculateBookingPromo.mockResolvedValue({
    adjustmentTargets: [],
    discount: null,
      newDiscountCents: 10_000,
      newPromoAdjustmentCents: -10_000,
      promoRemoved: false,
      promoCoverage: null,
    });

    const outcome = await rebaseBookingPriceFromStrands({
      bookingId: "booking-1",
      repairedStrand: { bookingGuestId: "guest-1", totalCents: 10_000 },
      todayAtClub: TODAY,
      store,
    });

    expect(outcome).toMatchObject({
      rebased: true,
      rebase: { newFinalPriceCents: 0 },
    });
  });
});

describe("what the re-price will not price from (#3219, INV-MOD-028)", () => {
  it.each([
    [
      "a strand with a night that carries no price at all",
      {
        id: "guest-2",
        priceCents: 8_000,
        nights: [
          { stayDate: AUG_1, priceCents: 4_000 },
          { stayDate: AUG_2, priceCents: null },
        ],
      },
    ],
    [
      "a strand whose nights do not sum to its stored total",
      {
        id: "guest-2",
        priceCents: 8_000,
        nights: [
          { stayDate: AUG_1, priceCents: 4_000 },
          { stayDate: AUG_2, priceCents: 3_000 },
        ],
      },
    ],
    [
      "a strand with a stay envelope and no night rows behind it",
      { id: "guest-2", priceCents: 8_000, nights: [] },
    ],
    [
      // The same absence at a total the sum check CANNOT catch: no rows sum to
      // zero, and zero is what the strand says it is worth. Only "a strand with
      // no night rows has a stay envelope and no evidence" refuses this one, so
      // without it the case is a false green - which a mutation probe of the
      // row-count check found it to be.
      "a strand with no night rows and nothing stored against it either",
      { id: "guest-2", priceCents: 0, nights: [] },
    ],
    [
      "a strand carrying a night price that is not usable money",
      {
        id: "guest-2",
        priceCents: 8_000,
        nights: [
          { stayDate: AUG_1, priceCents: 4_000 },
          { stayDate: AUG_2, priceCents: -4_000 },
        ],
      },
    ],
  ])("declines and writes nothing: %s", async (_name, badStrand) => {
    /*
      The re-price is DECLINED rather than approximated, and the booking's own
      figures are left exactly where the park set them. Re-basing anyway would
      assert a booking total built from strands the system has already said it
      cannot value - which is a worse lie than the stale one, and harder to
      notice.

      #3257 MADE THIS THE LOAD-BEARING HALF OF THE FEATURE. The trigger is now
      any parked review closing, so a closure that offers no price boxes reaches
      this writer instead of skipping it - and "a strand with a stay envelope and
      no night rows behind it" IS one of the two shapes that used to escape. Get
      this decline wrong and re-pricing on every close stops closing a gap and
      starts creating a worse one, so each case is asserted on BOTH triggers.
    */
    mocks.bookingFindUnique.mockResolvedValue(
      bookingWithStrands([SURVIVING_STRAND, badStrand]),
    );

    for (const repairedStrand of [
      { bookingGuestId: "guest-1", totalCents: 10_000 },
      null,
    ]) {
      vi.clearAllMocks();
      mocks.bookingFindUnique.mockResolvedValue(
        bookingWithStrands([SURVIVING_STRAND, badStrand]),
      );

      const outcome = await rebaseBookingPriceFromStrands({
        bookingId: "booking-1",
        repairedStrand,
        todayAtClub: TODAY,
        store,
      });

      expect(outcome).toMatchObject({
        rebased: false,
        reason: "strand-evidence-unreadable",
        moneyBuildUpSelection: { source: "BASE_EVIDENCE_UNKNOWN" },
      });
      expect(mocks.recalculateBookingPromo).not.toHaveBeenCalled();
      expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    }
  });
});

describe("re-pricing a closure that repaired NOTHING (#3257)", () => {
  it("sums the surviving strands with no repaired strand at all, and writes all four columns", async () => {
    /*
      The trigger moved (owner, 7 September 2026): a parked review closing, not a
      strand being repaired. Two shapes of a parked guest REMOVAL offer no price
      boxes - the review names the guest the same transaction deleted, or names a
      strand with no night rows - so under the old trigger neither re-priced and
      the headline kept counting a strand the booking no longer had.
    */
    const outcome = await rebaseBookingPriceFromStrands({
      bookingId: "booking-1",
      repairedStrand: null,
      todayAtClub: TODAY,
      store,
    });

    expect(outcome).toMatchObject({
      rebased: true,
      rebase: { newTotalPriceCents: 10_000, newFinalPriceCents: 2_500 },
    });
    // The promotion is re-capped on this path too - it is the same writer, not a
    // lighter one for the closures that typed nothing.
    expect(mocks.recalculateBookingPromo).toHaveBeenCalledWith(
      expect.objectContaining({ newTotalPriceCents: 10_000 }),
    );
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          totalPriceCents: 10_000,
          discountCents: 7_500,
          promoAdjustmentCents: -7_500,
          finalPriceCents: 2_500,
        },
      }),
    );
  });

  it("rebaseMovedStoredMoney separates a real movement from a recomputation that landed on the stored figures", () => {
    // The gate on the history row. Every parked review closing now re-prices, so
    // most closures recompute what the booking already held; a "Price
    // Recalculated" row recording no change would be noise.
    const still: BookingPriceRebase = {
      previousTotalPriceCents: 10_000,
      previousDiscountCents: 0,
      previousPromoAdjustmentCents: 0,
      previousFinalPriceCents: 10_000,
      newTotalPriceCents: 10_000,
      newDiscountCents: 0,
      newPromoAdjustmentCents: 0,
      newFinalPriceCents: 10_000,
      promoRemoved: false,
    };

    expect(rebaseMovedStoredMoney(still)).toBe(false);
    // Each column on its own is enough - a promotion that moved while the total
    // did not is a real movement, and the four are written together.
    expect(
      rebaseMovedStoredMoney({ ...still, newTotalPriceCents: 9_000 }),
    ).toBe(true);
    expect(rebaseMovedStoredMoney({ ...still, newDiscountCents: 1 })).toBe(true);
    expect(
      rebaseMovedStoredMoney({ ...still, newPromoAdjustmentCents: -1 }),
    ).toBe(true);
    expect(rebaseMovedStoredMoney({ ...still, newFinalPriceCents: 1 })).toBe(
      true,
    );
  });

  it("a PROMOTION REMOVED with all four columns unmoved still has to reach the booking's history", () => {
    // The disclosure regression the history-row gate can introduce. A promo
    // redemption that delivered no benefit is deliberately representable
    // (`shouldPersistPromoRedemption`, owner decision #2299), so removing an
    // expired one of those recomputes to exactly the stored figures while the
    // `PromoRedemption` row is deleted and its usage slot handed back. The
    // narrative's "The promotion no longer applies and was removed." is the only
    // place outside the audit log that says so, and it renders only on a
    // PRICE_REBASE row - so this is what decides whether the row is written.
    const still: BookingPriceRebase = {
      previousTotalPriceCents: 10_000,
      previousDiscountCents: 0,
      previousPromoAdjustmentCents: 0,
      previousFinalPriceCents: 10_000,
      newTotalPriceCents: 10_000,
      newDiscountCents: 0,
      newPromoAdjustmentCents: 0,
      newFinalPriceCents: 10_000,
      promoRemoved: false,
    };

    // Nothing changed at all: no row, which is the #3257 no-op.
    expect(rebaseMovedStoredMoney(still)).toBe(false);
    expect(rebaseChangedTheBooking(still)).toBe(false);

    // Money unmoved, promotion gone: NOT a no-op, and the money predicate on its
    // own cannot see it.
    const promoGone: BookingPriceRebase = { ...still, promoRemoved: true };
    expect(rebaseMovedStoredMoney(promoGone)).toBe(false);
    expect(rebaseChangedTheBooking(promoGone)).toBe(true);

    // And it stays wider than the money question, never narrower.
    expect(
      rebaseChangedTheBooking({ ...still, newFinalPriceCents: 9_000 }),
    ).toBe(true);
  });
});

describe("the strand-on-this-booking guard (#3219)", () => {
  it("refuses a review naming a guest who is not on this booking", async () => {
    // The pre-existing hole: nothing cross-checked the guest id an
    // EDIT_FINANCIAL_REVIEW context carries against the task's own bookingId.
    mocks.bookingFindUnique.mockResolvedValue(
      bookingWithStrands([SURVIVING_STRAND]),
    );

    await expect(
      rebaseBookingPriceFromStrands({
        bookingId: "booking-1",
        repairedStrand: { bookingGuestId: "guest-on-some-other-booking", totalCents: 10_000 },
        todayAtClub: TODAY,
        store,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: REBASE_STRAND_NOT_ON_BOOKING_MESSAGE,
    });
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses rather than ZEROING a headline when the booking has no strands at all", async () => {
    mocks.bookingFindUnique.mockResolvedValue(bookingWithStrands([]));

    await expect(
      rebaseBookingPriceFromStrands({
        bookingId: "booking-1",
        repairedStrand: { bookingGuestId: "guest-1", totalCents: 10_000 },
        todayAtClub: TODAY,
        store,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("declines rather than ZEROING a headline when there is no repaired strand to prove the list is not empty", async () => {
    /*
      #3257: with no repaired strand, the id-and-value check above has nothing to
      check, so the empty-list half of the hole it closes needs its own answer.
      Summing an empty guest list would write a $0.00 headline - the exact shape
      that guard exists to keep unreachable.
    */
    mocks.bookingFindUnique.mockResolvedValue(bookingWithStrands([]));

    const outcome = await rebaseBookingPriceFromStrands({
      bookingId: "booking-1",
      repairedStrand: null,
      todayAtClub: TODAY,
      store,
    });

    expect(outcome).toMatchObject({
      rebased: false,
      reason: "no-surviving-strands",
      moneyBuildUpSelection: { source: "BASE_EVIDENCE_UNKNOWN" },
    });
    expect(mocks.recalculateBookingPromo).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a strand that is on the booking but not at the value just written to it", async () => {
    // The guard is the id AND the value: reading the booking before the strand
    // write would give a pre-repair figure and a sum that is quietly wrong.
    await expect(
      rebaseBookingPriceFromStrands({
        bookingId: "booking-1",
        repairedStrand: { bookingGuestId: "guest-1", totalCents: 9_999 },
        todayAtClub: TODAY,
        store,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("turns a concurrent edit into a refusal rather than a lost update", async () => {
    mocks.bookingUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      rebaseBookingPriceFromStrands({
        bookingId: "booking-1",
        repairedStrand: { bookingGuestId: "guest-1", totalCents: 10_000 },
        todayAtClub: TODAY,
        store,
      }),
    ).rejects.toMatchObject({ status: 409, message: REBASE_RACED_MESSAGE });
  });
});

describe("D1's two consequences, surfaced rather than shipped blind (#3219)", () => {
  const rebase: BookingPriceRebase = {
    previousTotalPriceCents: 24_000,
    previousDiscountCents: 0,
    previousPromoAdjustmentCents: 0,
    previousFinalPriceCents: 24_000,
    newTotalPriceCents: 12_000,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    newFinalPriceCents: 12_000,
    promoRemoved: false,
  };

  it("a DISMISSAL on an invoiced booking diverges: the invoice says one figure and the booking now says another", () => {
    expect(
      rebaseDivergesFromIssuedInvoice({
        rebase,
        hasIssuedXeroInvoice: true,
        settlementIssuesXeroDocument: false,
      }),
    ).toBe(true);
  });

  it.each([
    [
      "the settlement issues a Xero document that brings the invoice back into line",
      { hasIssuedXeroInvoice: true, settlementIssuesXeroDocument: true },
    ],
    [
      "the club never invoiced this booking",
      { hasIssuedXeroInvoice: false, settlementIssuesXeroDocument: false },
    ],
  ])("does not diverge when %s", (_name, flags) => {
    expect(rebaseDivergesFromIssuedInvoice({ rebase, ...flags })).toBe(false);
  });

  it("does not diverge when the re-price moved the figure nowhere", () => {
    expect(
      rebaseDivergesFromIssuedInvoice({
        rebase: { ...rebase, newFinalPriceCents: 24_000 },
        hasIssuedXeroInvoice: true,
        settlementIssuesXeroDocument: false,
      }),
    ).toBe(false);
  });

  it("writes the re-price into the BOOKING'S OWN history, with the divergence on it", async () => {
    // D1's second consequence: a member can now be refunded less than they paid
    // from an action they never saw, so the reason has to be readable from the
    // booking rather than reconstructed from an audit trail.
    await recordBookingPriceRebaseHistory({
      bookingId: "booking-1",
      actingMemberId: "admin-1",
      taskId: "task-1",
      resolution: "dismissed",
      rebase,
      moneyBuildUpSelection: STORED_MONEY_SELECTION,
      xeroInvoiceDiverged: true,
      store,
    });

    expect(mocks.bookingModificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "booking-1",
        memberId: "admin-1",
        modificationType: "PRICE_REBASE",
        previousData: expect.objectContaining({ finalPriceCents: 24_000 }),
        newData: expect.objectContaining({
          finalPriceCents: 12_000,
          rebasedPriceMovementCents: -12_000,
          xeroInvoiceDiverged: true,
          financialReviewTaskId: "task-1",
          financialReviewResolution: "dismissed",
          moneyBuildUpOperation: "REVIEW_REBASE",
          moneyBuildUpSource: "STORED",
          moneyBuildUpStoredCents: 24_000,
          moneyBuildUpDerivedCents: 24_000,
        }),
      }),
    });
  });

  /**
   * The row must carry NO money components. `priceDiffCents + changeFeeCents`
   * is this tree's one statement that money moved, and every generic reader of
   * it applies to every modification row with no `modificationType` filter -
   * `getModificationNetAmountCents` feeding the Xero repair classifier's
   * `critical`, `safeToAutoApply` supplementary-invoice arm and its credit-note
   * arm, `getKnownModificationRefundTotalCents` counting negatives as refunds
   * already known, and `booking-delete`'s hard-delete blocker. A re-base runs
   * after the primary invoice was raised, so a signed component here reads to
   * all of them as a second, unbilled ask: one click from issuing a duplicate
   * invoice for money already billed. The movement belongs in `newData`, which
   * no money reader consumes.
   */
  it.each([
    ["a reduction", { newFinalPriceCents: 12_000 }, -12_000],
    ["an increase", { newFinalPriceCents: 29_000 }, 5_000],
  ])(
    "%s moves no money on the row itself: both money components are 0, and the signed movement rides newData",
    async (_name, overrides, expectedMovementCents) => {
      await recordBookingPriceRebaseHistory({
        bookingId: "booking-1",
        actingMemberId: "admin-1",
        taskId: "task-1",
        resolution: "completed",
        rebase: { ...rebase, ...overrides },
        moneyBuildUpSelection: STORED_MONEY_SELECTION,
        xeroInvoiceDiverged: false,
        store,
      });

      const [{ data }] = mocks.bookingModificationCreate.mock.calls.at(-1) as [
        { data: Record<string, unknown> },
      ];
      expect(data.priceDiffCents).toBe(0);
      expect(data.changeFeeCents).toBe(0);
      expect(
        (data.newData as Record<string, unknown>).rebasedPriceMovementCents,
      ).toBe(expectedMovementCents);
    },
  );
});
