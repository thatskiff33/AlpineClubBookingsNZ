import { describe, expect, it } from "vitest";
import {
  formatNetCollectedLedgerGapWarning,
  formatPaidRefundedBreakdown,
  getPaymentNetOfRefundsCents,
  getRemainingRefundableCents,
  hasCapturedPayment,
  formatNetCollectedBreakdown,
  summarizeCollectedCash,
  type NetCollectedPaymentRow,
} from "@/lib/booking-payment-state";

describe("booking payment state helpers", () => {
  it("treats pending and failed payments as not captured", () => {
    expect(
      hasCapturedPayment({ status: "PENDING", amountCents: 9000 })
    ).toBe(false);
    expect(
      hasCapturedPayment({ status: "FAILED", amountCents: 9000 })
    ).toBe(false);
  });

  it("returns zero refundable cents when no successful charge exists", () => {
    expect(
      getRemainingRefundableCents({
        status: "PENDING",
        amountCents: 9000,
        refundedAmountCents: 0,
      })
    ).toBe(0);
  });

  it("returns the remaining refundable balance for captured payments", () => {
    expect(
      getRemainingRefundableCents({
        status: "PARTIALLY_REFUNDED",
        amountCents: 9000,
        refundedAmountCents: 2500,
      })
    ).toBe(6500);
  });

  it("does not treat zero-dollar successful records as refundable payments", () => {
    expect(
      hasCapturedPayment({ status: "SUCCEEDED", amountCents: 0 })
    ).toBe(false);
    expect(
      getRemainingRefundableCents({
        status: "SUCCEEDED",
        amountCents: 0,
        refundedAmountCents: 0,
      })
    ).toBe(0);
  });
});

/*
  #3372 — the per-payment net the payments list's "Amount (net)" column, its
  sort, the diagnostics subject and the change-requests panel all read, and the
  "paid, refunded or credited" line printed beneath a net headline.
*/
describe("per-payment net and its breakdown line", () => {
  it("nets one payment row with no status gate, unlike the refundable balance", () => {
    // The #3340 booking: $130.00 captured, $65.00 refunded.
    expect(
      getPaymentNetOfRefundsCents({ amountCents: 13_000, refundedAmountCents: 6_500 })
    ).toBe(6_500);
    // An unpaid row still shows its amount in the column; only the refundable
    // balance, which asks "how much could a refund still take?", reads 0.
    const pending = { status: "PENDING", amountCents: 9_000, refundedAmountCents: 0 };
    expect(getPaymentNetOfRefundsCents(pending)).toBe(9_000);
    expect(getRemainingRefundableCents(pending)).toBe(0);
  });

  it("prints gross and refunded in the caller's exact-cents formatter", () => {
    const cents = (value: number) => `$${(value / 100).toFixed(2)}`;
    expect(formatPaidRefundedBreakdown(13_000, 6_500, cents)).toBe(
      "$130.00 paid, $65.00 refunded or credited"
    );
  });

  it("returns null when nothing was refunded or credited, so no caller prints the line", () => {
    const cents = (value: number) => `$${(value / 100).toFixed(2)}`;
    expect(formatPaidRefundedBreakdown(13_000, 0, cents)).toBeNull();
  });
});

// #3637: the count in the shared warning is printed by the caller's number
// formatter, as the money is by its money formatter - the club's grouping.
describe("the Net Collected ledger-gap warning", () => {
  const cents = (value: number) => `$${(value / 100).toFixed(2)}`;
  const grouped = (count: number) =>
    String(count).replace(/(\d)(?=(\d{3})+$)/g, "$1,");

  it("prints the count in the caller's number format", () => {
    expect(
      formatNetCollectedLedgerGapWarning(
        { additionalLedgerGapCents: 2_100, additionalLedgerGapBookings: 1_234 },
        { one: "booking in this range", many: "bookings in this range" },
        cents,
        grouped,
      ),
    ).toContain("may understate by $21.00: 1,234 bookings in this range record an");
  });

  it("returns null when there is no gap", () => {
    expect(
      formatNetCollectedLedgerGapWarning(
        { additionalLedgerGapCents: 0, additionalLedgerGapBookings: 0 },
        { one: "booking", many: "bookings" },
        cents,
        grouped,
      ),
    ).toBeNull();
  });
});

/*
  Owner review on PR #3811 (2 Oct 2026): "a cancelled booking should only count
  if there were payments on the booking and they were not refunded when the
  booking was cancelled, but if there were no payments on the booking and it's
  cancelled, then the money received is nil". Refined by the owner's decision on
  #3372 (3 Oct 2026, https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3372#issuecomment-5967063711):
  account credit a cancellation KEPT counts, and a hand-back refund still owed
  on an open task counts as gone straight away.

  Each case is ONE cancelled booking's payment in the shape its cancel path
  leaves it, beside a live booking's untouched $100.00, so a case that leaks
  into another booking's money shows up as a total other than $100.00 plus that
  booking's own share.
*/
describe("what a cancelled booking adds to Net Collected (owner review on #3811, decision 3 Oct)", () => {
  const noRows = { creditsApplied: [], creditsFromCancellation: [], manualRefundTasks: [] };
  const otherBooking = {
    status: "SUCCEEDED",
    amountCents: 10_000,
    refundedAmountCents: 0,
    booking: { deletedAt: null, status: "PAID", ...noRows },
  };
  type CancelledBooking = Partial<NetCollectedPaymentRow["booking"]>;
  const netWith = (
    cancelled: { status: string | null; amountCents: number; refundedAmountCents: number },
    booking: CancelledBooking = {},
  ) =>
    summarizeCollectedCash([
      otherBooking,
      { ...cancelled, booking: { deletedAt: null, status: "CANCELLED", ...noRows, ...booking } },
    ]);
  const applied = (cents: number) => ({ type: "BOOKING_APPLIED", amountCents: -cents });
  const restored = (cents: number) => ({
    type: "CANCELLATION_REFUND",
    amountCents: cents,
    restoredFromBookingId: "b-cancelled",
  });
  const handBack = (status: string, amountCents: number | null) => ({
    status,
    kind: "CANCELLED_BOOKING_HAND_BACK",
    amountCents,
    partPaymentReviewPaymentId: null,
  });

  it("adds nil for a booking cancelled before anything was paid", () => {
    // The unpaid cancel marks a never-captured payment FAILED; a booking
    // cancelled while still PENDING keeps its PENDING row. Its price, and any
    // fee its policy would charge, is never read.
    expect(netWith({ status: "FAILED", amountCents: 45_000, refundedAmountCents: 0 }).netCollectedCents).toBe(10_000);
    expect(netWith({ status: "PENDING", amountCents: 45_000, refundedAmountCents: 0 }).netCollectedCents).toBe(10_000);
  });

  it("adds nil, never less, when a never-paid booking's payment carries a refund on its mirror", () => {
    // The inbound reconcile folds a modification credit note into a
    // never-captured Internet Banking payment; the unpaid cancel then marks it
    // FAILED with the fold still on it. Pooled, that $30.00 came off the OTHER
    // booking's money.
    expect(netWith({ status: "FAILED", amountCents: 20_000, refundedAmountCents: 3_000 })).toEqual({
      capturedGrossCents: 10_000,
      refundedCents: 0,
      handBackOwedCents: 0,
      keptCreditCents: 0,
      netCollectedCents: 10_000,
    });
  });

  it("adds nil for a booking paid and then refunded in full", () => {
    expect(netWith({ status: "REFUNDED", amountCents: 20_000, refundedAmountCents: 20_000 }).netCollectedCents).toBe(10_000);
  });

  it("adds the part a cancellation policy kept out of money that was paid", () => {
    // Paid $200.00 by card; a 75% tier refunded $150.00, and the club kept $50.00.
    expect(netWith({ status: "PARTIALLY_REFUNDED", amountCents: 20_000, refundedAmountCents: 15_000 })).toEqual({
      capturedGrossCents: 30_000,
      refundedCents: 15_000,
      handBackOwedCents: 0,
      keptCreditCents: 0,
      netCollectedCents: 15_000,
    });
  });

  it("never lets a refund above its own payment reach another booking", () => {
    expect(netWith({ status: "REFUNDED", amountCents: 20_000, refundedAmountCents: 26_000 })).toEqual({
      capturedGrossCents: 30_000,
      refundedCents: 20_000,
      handBackOwedCents: 0,
      keptCreditCents: 0,
      netCollectedCents: 10_000,
    });
  });

  describe("paid wholly with account credit ($80.00 applied; no cash, so amountCents is 0)", () => {
    const creditPaid = { status: "SUCCEEDED", amountCents: 0, refundedAmountCents: 0 };

    it("adds nil when the cancellation restored all the credit", () => {
      expect(
        netWith(creditPaid, { creditsApplied: [applied(8_000)], creditsFromCancellation: [restored(8_000)] }).netCollectedCents,
      ).toBe(10_000);
    });

    it("adds the credit the cancellation kept", () => {
      // A tier restored $60.00 of the $80.00 and kept $20.00.
      expect(
        netWith(creditPaid, { creditsApplied: [applied(8_000)], creditsFromCancellation: [restored(6_000)] }),
      ).toEqual({
        capturedGrossCents: 10_000,
        refundedCents: 0,
        handBackOwedCents: 0,
        keptCreditCents: 2_000,
        netCollectedCents: 12_000,
      });
      // Kept in full when nothing was restored.
      expect(netWith(creditPaid, { creditsApplied: [applied(8_000)] }).netCollectedCents).toBe(18_000);
    });

    it("nets a clamp's give-back, and does not read the paid slice refunded AS credit as a restore", () => {
      // $80.00 applied, $10.00 given back by a clamp: $70.00 applied. A
      // cancellation credit of the cash slice carries no restore marker and is
      // on `refundedAmountCents` already, so it does not shrink the kept credit.
      expect(
        netWith(creditPaid, {
          creditsApplied: [applied(8_000), { type: "BOOKING_APPLIED", amountCents: 1_000 }],
          creditsFromCancellation: [
            restored(5_000),
            { type: "CANCELLATION_REFUND", amountCents: 4_000, restoredFromBookingId: null },
          ],
        }).keptCreditCents,
      ).toBe(2_000);
    });

    it("never counts a LIVE booking's applied credit", () => {
      expect(
        summarizeCollectedCash([
          { ...creditPaid, booking: { deletedAt: null, status: "PAID", ...noRows, creditsApplied: [applied(8_000)] } },
        ]).netCollectedCents,
      ).toBe(0);
    });
  });

  it("adds an Internet Banking payment's kept share once its cancellation refund is held as credit", () => {
    // A reconciled Internet Banking payment cancels on the credit path: the
    // refunded share is on `refundedAmountCents` at once
    // (`applyLocalRefundAllocation`), so only the kept share counts.
    expect(netWith({ status: "PARTIALLY_REFUNDED", amountCents: 20_000, refundedAmountCents: 10_000 }).netCollectedCents).toBe(20_000);
  });

  describe("marked paid by hand, $200.00; the 50% tier owes $100.00 back by hand", () => {
    it("counts only the kept share while the hand-back task is still open", () => {
      expect(
        netWith({ status: "SUCCEEDED", amountCents: 20_000, refundedAmountCents: 0 }, { manualRefundTasks: [handBack("OPEN", 10_000)] }),
      ).toEqual({
        capturedGrossCents: 30_000,
        refundedCents: 0,
        handBackOwedCents: 10_000,
        keptCreditCents: 0,
        netCollectedCents: 20_000,
      });
    });

    it("counts the same kept share once the task is completed and the refund is recorded", () => {
      expect(
        netWith(
          { status: "PARTIALLY_REFUNDED", amountCents: 20_000, refundedAmountCents: 10_000 },
          { manualRefundTasks: [handBack("COMPLETED", 10_000)] },
        ).netCollectedCents,
      ).toBe(20_000);
    });

    it("counts the whole payment when the task was dismissed: nothing went back", () => {
      expect(
        netWith({ status: "SUCCEEDED", amountCents: 20_000, refundedAmountCents: 0 }, { manualRefundTasks: [handBack("DISMISSED", 10_000)] })
          .netCollectedCents,
      ).toBe(30_000);
    });

    it("owes nothing for a part-payment review or another task kind, and never below nil", () => {
      const review = { ...handBack("OPEN", null), partPaymentReviewPaymentId: "pay-1" };
      const other = { ...handBack("OPEN", 10_000), kind: "EDIT_FINANCIAL_REVIEW" };
      expect(
        netWith({ status: "SUCCEEDED", amountCents: 20_000, refundedAmountCents: 0 }, { manualRefundTasks: [review, other] })
          .netCollectedCents,
      ).toBe(30_000);
      // An owed amount above what is left takes the payment to nil, not below.
      expect(
        netWith({ status: "SUCCEEDED", amountCents: 20_000, refundedAmountCents: 0 }, { manualRefundTasks: [handBack("OPEN", 25_000)] })
          .netCollectedCents,
      ).toBe(10_000);
    });

    it("never takes a hand-back off a LIVE booking", () => {
      expect(
        summarizeCollectedCash([
          {
            status: "SUCCEEDED",
            amountCents: 20_000,
            refundedAmountCents: 0,
            booking: { deletedAt: null, status: "PAID", ...noRows, manualRefundTasks: [handBack("OPEN", 10_000)] },
          },
        ]).netCollectedCents,
      ).toBe(20_000);
    });
  });

  it("prints the breakdown so the headline's arithmetic is on screen", () => {
    const cents = (value: number) => `$${(value / 100).toFixed(2)}`;
    expect(
      formatNetCollectedBreakdown(
        { capturedGrossCents: 30_000, refundedCents: 15_000, handBackOwedCents: 7_500, keptCreditCents: 2_000 },
        cents,
      ),
    ).toBe(
      "$300.00 paid, $150.00 refunded or credited, $75.00 owed back on cancellation, plus $20.00 account credit kept on cancellation",
    );
    expect(
      formatNetCollectedBreakdown(
        { capturedGrossCents: 0, refundedCents: 0, handBackOwedCents: 0, keptCreditCents: 2_000 },
        cents,
      ),
    ).toBe("$0.00 paid, plus $20.00 account credit kept on cancellation");
    expect(
      formatNetCollectedBreakdown(
        { capturedGrossCents: 10_000, refundedCents: 0, handBackOwedCents: 0, keptCreditCents: 0 },
        cents,
      ),
    ).toBeNull();
  });
});
