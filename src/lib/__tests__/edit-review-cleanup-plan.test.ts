import { describe, expect, it } from "vitest";
import { ManualRefundTaskDirection } from "@prisma/client";

import {
  decideOpenEditReview,
  isFrozenEditReviewHeadline,
  listDismissedShortenings,
  type OpenEditReviewInput,
} from "@/lib/edit-review-cleanup-plan";
import { editedBookingTotalCents } from "@/lib/edit-night-valuation";

/**
 * Wave B prices one parked edit from stored nights. The cents below are worked
 * by hand from the owner's R1–R3 examples, not by calling the splitter again.
 */

const NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03"] as const;

function context(input: {
  bookingGuestId?: string;
  guestTotalCents: number | null;
  prices: ReadonlyArray<number | null>;
  surrendered?: readonly string[];
  added?: readonly string[];
  otherStrands?: unknown[];
  guestsAddedByEdit?: { count: number; totalPriceCents: number | null } | null;
  bookingModificationId?: string | null;
  bookingId?: string;
}) {
  const strand = {
    bookingGuestId: input.bookingGuestId ?? "guest-1",
    cause: "INEXACT_STORED_NIGHT_PRICES",
    surrenderedNightDates: input.surrendered ?? [],
    addedNightDates: input.added ?? [],
    storedEvidence: {
      guestTotalCents: input.guestTotalCents,
      nightPrices: NIGHTS.map((date, index) => ({ date, priceCents: input.prices[index] ?? null })),
    },
  };
  return {
    version: 1,
    occurrence: {
      bookingId: input.bookingId ?? "booking-1",
      ...strand,
      otherStrands: input.otherStrands ?? [],
    },
    guestMemberId: null,
    bookingCheckIn: "2026-08-01",
    bookingCheckOut: "2026-08-04",
    guestsAddedByEdit: input.guestsAddedByEdit ?? null,
    bookingModificationId: input.bookingModificationId === undefined ? "mod-1" : input.bookingModificationId,
  };
}

function decisionInput(overrides: Partial<OpenEditReviewInput> & { reviewContext: unknown }): OpenEditReviewInput {
  return {
    taskId: "task-1",
    bookingId: "booking-1",
    currentGuestIds: new Set(["guest-1"]),
    addedNightPrices: new Map(),
    checkInChanged: false,
    changeFeeAlreadyChargedCents: 0,
    prospectiveChangeFeeCents: 0,
    bookingStatus: "CONFIRMED",
    paymentCaptured: true,
    ...overrides,
  };
}

describe("pricing one open edit review (#4343)", () => {
  it("credits an R1 surrender at the stored row", () => {
    const decision = decideOpenEditReview(
      decisionInput({
        reviewContext: context({
          guestTotalCents: 30_000,
          prices: [10_000, 10_000, 10_000],
          surrendered: ["2026-08-01"],
        }),
      }),
    );
    expect(decision).toMatchObject({
      action: "complete",
      direction: ManualRefundTaskDirection.REFUND_TO_MEMBER,
      amountCents: 10_000,
      feeCents: 0,
      creditCents: 10_000,
    });
  });

  it("credits an R2 blank night at the remainder, $40 of a $240 guest", () => {
    // Rows $100 / $100 / blank on a $240 guest are $100 / $100 / $40.
    const decision = decideOpenEditReview(
      decisionInput({
        reviewContext: context({
          guestTotalCents: 24_000,
          prices: [10_000, 10_000, null],
          surrendered: ["2026-08-03"],
        }),
      }),
    );
    expect(decision).toMatchObject({ action: "complete", amountCents: 4_000, creditCents: 4_000 });
  });

  it("credits an R3 surrender at the even split, leftover cent on the earliest night", () => {
    // $100 over three stored nights that do not add up to it: 3334, 3333, 3333.
    const decision = decideOpenEditReview(
      decisionInput({
        reviewContext: context({
          guestTotalCents: 10_000,
          prices: [9_000, 9_000, 9_000],
          surrendered: ["2026-08-01"],
        }),
      }),
    );
    expect(decision).toMatchObject({ action: "complete", amountCents: 3_334, creditCents: 3_334 });
  });

  it("charges a guest the edit added at the recorded total, and does not re-quote", () => {
    const decision = decideOpenEditReview(
      decisionInput({
        reviewContext: context({
          guestTotalCents: 20_000,
          prices: [20_000, null, null],
          guestsAddedByEdit: { count: 1, totalPriceCents: 32_000 },
        }),
      }),
    );
    expect(decision).toMatchObject({
      action: "complete",
      direction: ManualRefundTaskDirection.CHARGE_TO_MEMBER,
      amountCents: 32_000,
      chargeCents: 32_000,
    });
  });

  it("credits a whole guest the review's own edit removed, at the stored total", () => {
    const decision = decideOpenEditReview(
      decisionInput({
        currentGuestIds: new Set(),
        reviewContext: context({
          guestTotalCents: 30_000,
          prices: [10_000, 10_000, 10_000],
          surrendered: [...NIGHTS],
        }),
      }),
    );
    expect(decision).toMatchObject({
      action: "complete",
      direction: ManualRefundTaskDirection.REFUND_TO_MEMBER,
      amountCents: 30_000,
      creditCents: 30_000,
    });
  });

  it("MUTATION: a guest removed after the review was raised closes the whole task with no money, and still names a strand that remains", () => {
    // Delete the consent-removed branch and this prices the guest who is still here.
    const other = {
      bookingGuestId: "guest-2",
      cause: "INEXACT_STORED_NIGHT_PRICES",
      surrenderedNightDates: ["2026-08-01"],
      addedNightDates: [],
      storedEvidence: {
        guestTotalCents: 30_000,
        nightPrices: NIGHTS.map((date) => ({ date, priceCents: 10_000 })),
      },
    };
    const decision = decideOpenEditReview(
      decisionInput({
        currentGuestIds: new Set(["guest-2"]),
        reviewContext: context({
          guestTotalCents: 30_000,
          prices: [10_000, 10_000, 10_000],
          surrendered: ["2026-08-01"],
          otherStrands: [other],
        }),
      }),
    );
    expect(decision).toMatchObject({
      action: "dismiss",
      reason: "consent-removed",
      removedGuestIds: ["guest-1"],
      remainingStrandGuestIds: ["guest-2"],
    });
  });

  it("dismisses an unreadable context and a null added-night price with no money", () => {
    expect(decideOpenEditReview(decisionInput({ reviewContext: { version: 2 } }))).toMatchObject({
      action: "dismiss",
      reason: "unreadable",
    });
    expect(
      decideOpenEditReview(
        decisionInput({
          addedNightPrices: new Map([["guest-1|2026-08-04", null]]),
          reviewContext: context({
            guestTotalCents: 10_000,
            prices: [10_000, null, null],
            added: ["2026-08-04"],
          }),
        }),
      ),
    ).toMatchObject({ action: "dismiss", reason: "unpriced-added-night" });
  });

  it("adds the change fee only when check-in moved and none was stored, and not on an unpaid unconfirmed booking", () => {
    const priced = context({
      guestTotalCents: 10_000,
      prices: [10_000, null, null],
      added: ["2026-08-04"],
    });
    const prices = new Map<string, number | null>([["guest-1|2026-08-04", 0]]);
    const withFee = decisionInput({
      reviewContext: priced,
      addedNightPrices: prices,
      checkInChanged: true,
      prospectiveChangeFeeCents: 1_500,
    });
    expect(decideOpenEditReview(withFee)).toMatchObject({
      action: "complete",
      amountCents: 1_500,
      feeCents: 1_500,
      chargeCents: 0,
    });
    expect(
      decideOpenEditReview({ ...withFee, changeFeeAlreadyChargedCents: 500 }),
    ).toMatchObject({ action: "dismiss", reason: "nothing-owing" });
    expect(
      decideOpenEditReview({ ...withFee, checkInChanged: false }),
    ).toMatchObject({ action: "dismiss", reason: "nothing-owing" });
    expect(
      decideOpenEditReview({ ...withFee, bookingStatus: "DRAFT", paymentCaptured: false }),
    ).toMatchObject({ action: "dismiss", reason: "nothing-owing", });
  });

  it("dismisses a zero net, and a priced edit with no modification anchor", () => {
    expect(
      decideOpenEditReview(
        decisionInput({
          reviewContext: context({
            guestTotalCents: 10_000,
            prices: [10_000, null, null],
            surrendered: ["2026-08-01"],
            added: ["2026-08-04"],
          }),
          addedNightPrices: new Map([["guest-1|2026-08-04", 10_000]]),
        }),
      ),
    ).toMatchObject({ action: "dismiss", reason: "nothing-owing" });
    expect(
      decideOpenEditReview(
        decisionInput({
          reviewContext: context({
            guestTotalCents: 10_000,
            prices: [10_000, null, null],
            surrendered: ["2026-08-01"],
            bookingModificationId: null,
          }),
        }),
      ),
    ).toMatchObject({ action: "dismiss", reason: "no-anchor" });
  });
});

describe("frozen headlines and dismissed shortenings", () => {
  const guests = [
    { id: "sam", priceCents: 30_000 },
    { id: "alex", priceCents: 30_000 },
  ];

  it("flags a dismissed review whose headline is not the guest sum, and ignores the rest", () => {
    const money = { discountCents: 0, promoAdjustmentCents: 0, finalPriceCents: 60_000 };
    const both = { id: "booking-1", ...money, totalPriceCents: 60_000, guests };
    const alexGone = { ...both, totalPriceCents: 60_000, guests: [{ id: "sam", priceCents: 30_000 }] };
    const dismissed = [{ id: "task-1", bookingId: "booking-1", status: "DISMISSED" }];
    expect(isFrozenEditReviewHeadline(alexGone, dismissed)).toBe(true);
    expect(isFrozenEditReviewHeadline(both, dismissed)).toBe(false);
    expect(isFrozenEditReviewHeadline(alexGone, [])).toBe(false);
    expect(isFrozenEditReviewHeadline(alexGone, [{ id: "task-1", bookingId: "booking-1", status: "OPEN" }])).toBe(false);
    expect(isFrozenEditReviewHeadline({ ...alexGone, guests: [] }, dismissed)).toBe(false);
  });

  it("lists a dismissed shortening whose guest is still stored at the recorded total", () => {
    const review = context({
      guestTotalCents: 30_000,
      prices: [10_000, 10_000, 10_000],
      surrendered: ["2026-08-03"],
    });
    const rows = listDismissedShortenings(
      [{ id: "task-1", bookingId: "booking-1", status: "DISMISSED", reviewContext: review }],
      new Map([["booking-1", [{ id: "guest-1", priceCents: 30_000 }]]]),
    );
    expect(rows).toEqual([
      { bookingId: "booking-1", taskId: "task-1", guestId: "guest-1", guestTotalCents: 30_000 },
    ]);
    expect(
      listDismissedShortenings(
        [{ id: "task-1", bookingId: "booking-1", status: "DISMISSED", reviewContext: review }],
        new Map([["booking-1", [{ id: "guest-1", priceCents: 20_000 }]]]),
      ),
    ).toEqual([]);
  });

  it("does not refuse an edit once the headline has been re-based onto the guests", () => {
    const stored = { id: "booking-1", totalPriceCents: 10_000, guests: [{ priceCents: 40_000 }] };
    expect(() => editedBookingTotalCents(stored, 10_000)).toThrow(/stored total is out of step/);
    const rebased = { ...stored, totalPriceCents: 40_000 };
    expect(editedBookingTotalCents(rebased, 10_000)).toBe(10_000);
  });
});
