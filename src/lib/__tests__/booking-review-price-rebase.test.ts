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
  rebaseDivergesFromIssuedInvoice,
  recordBookingPriceRebaseHistory,
  type BookingPriceRebase,
} from "@/lib/booking-review-price-rebase";
import { requireCalendarDate } from "@/lib/club-time";

const store = {
  booking: {
    findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a),
    updateMany: (...a: unknown[]) => mocks.bookingUpdateMany(...a),
  },
  bookingModification: {
    create: (...a: unknown[]) => mocks.bookingModificationCreate(...a),
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
    guests: guests.map((guest) => ({
      memberId: null,
      isMember: false,
      ...guest,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bookingModificationCreate.mockResolvedValue({ id: "mod-1" });
  // The honest answer for the worked case: 75% of the $100.00 that is left.
  mocks.recalculateBookingPromo.mockResolvedValue({
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
      repairedGuestId: "guest-1",
      repairedGuestTotalCents: 10_000,
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
      repairedGuestId: "guest-1",
      repairedGuestTotalCents: 10_000,
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
      newDiscountCents: 0,
      newPromoAdjustmentCents: 0,
      promoRemoved: true,
      promoCoverage: null,
    });

    const outcome = await rebaseBookingPriceFromStrands({
      bookingId: "booking-1",
      repairedGuestId: "guest-1",
      repairedGuestTotalCents: 10_000,
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
      newDiscountCents: 15_000,
      newPromoAdjustmentCents: -15_000,
      promoRemoved: false,
      promoCoverage: null,
    });

    await expect(
      rebaseBookingPriceFromStrands({
        bookingId: "booking-1",
        repairedGuestId: "guest-1",
        repairedGuestTotalCents: 10_000,
        todayAtClub: TODAY,
        store,
      }),
    ).rejects.toThrow(REBASE_NEGATIVE_PRICE_MESSAGE);
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("EXACTLY ZERO IS ALLOWED, because a promotion that covers the whole stay is a real shape", async () => {
    mocks.recalculateBookingPromo.mockResolvedValue({
      newDiscountCents: 10_000,
      newPromoAdjustmentCents: -10_000,
      promoRemoved: false,
      promoCoverage: null,
    });

    const outcome = await rebaseBookingPriceFromStrands({
      bookingId: "booking-1",
      repairedGuestId: "guest-1",
      repairedGuestTotalCents: 10_000,
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
      notice. Such a booking still carries an open review over that strand, and
      settling it re-bases then.
    */
    mocks.bookingFindUnique.mockResolvedValue(
      bookingWithStrands([SURVIVING_STRAND, badStrand]),
    );

    const outcome = await rebaseBookingPriceFromStrands({
      bookingId: "booking-1",
      repairedGuestId: "guest-1",
      repairedGuestTotalCents: 10_000,
      todayAtClub: TODAY,
      store,
    });

    expect(outcome).toEqual({
      rebased: false,
      reason: "strand-evidence-unreadable",
    });
    expect(mocks.recalculateBookingPromo).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
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
        repairedGuestId: "guest-on-some-other-booking",
        repairedGuestTotalCents: 10_000,
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
        repairedGuestId: "guest-1",
        repairedGuestTotalCents: 10_000,
        todayAtClub: TODAY,
        store,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a strand that is on the booking but not at the value just written to it", async () => {
    // The guard is the id AND the value: reading the booking before the strand
    // write would give a pre-repair figure and a sum that is quietly wrong.
    await expect(
      rebaseBookingPriceFromStrands({
        bookingId: "booking-1",
        repairedGuestId: "guest-1",
        repairedGuestTotalCents: 9_999,
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
        repairedGuestId: "guest-1",
        repairedGuestTotalCents: 10_000,
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
      xeroInvoiceDiverged: true,
      store,
    });

    expect(mocks.bookingModificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "booking-1",
        memberId: "admin-1",
        modificationType: "PRICE_REBASE",
        priceDiffCents: -12_000,
        changeFeeCents: 0,
        previousData: expect.objectContaining({ finalPriceCents: 24_000 }),
        newData: expect.objectContaining({
          finalPriceCents: 12_000,
          xeroInvoiceDiverged: true,
          financialReviewTaskId: "task-1",
          financialReviewResolution: "dismissed",
        }),
      }),
    });
  });
});
