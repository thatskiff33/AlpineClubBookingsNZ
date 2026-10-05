/**
 * #3372, owner decision A: ONE fixture for the one Net Collected booking scope,
 * handed to all four surfaces that show a "Net Collected" figure - the
 * dashboard card, the payments board tile, Reports' Net Collected and the
 * Finance dashboard's "Net Collected" (#3637) - so each surface's test
 * asserts the SAME expected amount from the SAME payments.
 *
 * Six payments:
 *  - a CANCELLED booking that paid $200.00 and was refunded $150.00, so the
 *    club kept $50.00 of money it received. It counts: $50.00.
 *  - a SOFT-DELETED booking's captured $70.00. It does not count.
 *  - a CANCELLED booking that was NEVER PAID (owner review on PR #3811): its
 *    payment never took money, so it adds nil, whatever its price or its
 *    policy's fee. It carries a $30.00 refund on its mirror - the shape the
 *    inbound reconcile leaves when it folds a modification credit note into an
 *    unpaid Internet Banking payment that the unpaid cancel then marks FAILED -
 *    so a derivation that pools refunds across payments reads $30.00 less.
 *  - a CANCELLED booking paid wholly with $80.00 of account credit, of which
 *    the cancellation restored $60.00 (owner decision on #3372, 3 Oct 2026:
 *    kept credit counts). It counts: $20.00.
 *  - a CANCELLED booking marked paid by hand for $100.00 whose $75.00 refund
 *    is still an OPEN hand-back task (same decision: the refund owed is gone
 *    straight away). It counts: $25.00, not $100.00.
 *  - a LIVE booking's never-paid Internet Banking payment, created PENDING at
 *    its $450.00 price, that the inbound reconcile folded a $50.00
 *    modification credit note into and marked PARTIALLY_REFUNDED (owner's
 *    rule on PR #3811: only money actually received counts). It has no
 *    captured ledger row and is not a card payment, so it adds nil; a
 *    derivation that trusts the refunded status reads $400.00 more.
 *
 * Each surface used to answer differently: the payments tile, Reports and
 * Finance left cancelled bookings out, the dashboard counted the deleted
 * booking too. Under the one scope and the one per-payment rule all four read
 * $95.00.
 *
 * `source` and `capturedLedgerRows` are each payment's capture evidence
 * (`netCollectedCaptureEvidenceSelect`); a surface's mock hands them in through
 * `netCollectedFixtureEvidence`.
 */

type FixtureRow = {
  bookingId: string;
  bookingStatus: string;
  status: string;
  amountCents: number;
  refundedAmountCents: number;
  source: "STRIPE" | "INTERNET_BANKING";
  /** How many of the payment's ledger rows hold a captured status. */
  capturedLedgerRows: number;
  deletedAt: Date | null;
  creditsApplied: ReadonlyArray<{ type: string; amountCents: number }>;
  creditsFromCancellation: ReadonlyArray<{
    type: string;
    amountCents: number;
    restoredFromBookingId: string | null;
  }>;
  manualRefundTasks: ReadonlyArray<{
    status: string;
    kind: string | null;
    amountCents: number | null;
    partPaymentReviewPaymentId: string | null;
  }>;
};

const noCreditOrTask = {
  creditsApplied: [],
  creditsFromCancellation: [],
  manualRefundTasks: [],
};

export const NET_COLLECTED_SCOPE_FIXTURE = {
  keptFee: {
    bookingId: "b-cancelled-kept-fee",
    bookingStatus: "CANCELLED",
    status: "PARTIALLY_REFUNDED",
    amountCents: 20_000,
    refundedAmountCents: 15_000,
    source: "STRIPE",
    capturedLedgerRows: 1,
    deletedAt: null,
    ...noCreditOrTask,
  },
  deleted: {
    bookingId: "b-soft-deleted",
    bookingStatus: "CANCELLED",
    status: "SUCCEEDED",
    amountCents: 7_000,
    refundedAmountCents: 0,
    source: "STRIPE",
    capturedLedgerRows: 1,
    deletedAt: new Date("2026-04-02T00:00:00.000Z"),
    ...noCreditOrTask,
  },
  unpaidCancelled: {
    bookingId: "b-cancelled-never-paid",
    bookingStatus: "CANCELLED",
    status: "FAILED",
    amountCents: 20_000,
    refundedAmountCents: 3_000,
    source: "INTERNET_BANKING",
    capturedLedgerRows: 0,
    deletedAt: null,
    ...noCreditOrTask,
  },
  creditKept: {
    bookingId: "b-cancelled-credit-kept",
    bookingStatus: "CANCELLED",
    status: "SUCCEEDED",
    amountCents: 0,
    refundedAmountCents: 0,
    source: "INTERNET_BANKING",
    capturedLedgerRows: 0,
    deletedAt: null,
    creditsApplied: [{ type: "BOOKING_APPLIED", amountCents: -8_000 }],
    creditsFromCancellation: [
      {
        type: "CANCELLATION_REFUND",
        amountCents: 6_000,
        restoredFromBookingId: "b-cancelled-credit-kept",
      },
    ],
    manualRefundTasks: [],
  },
  handBackOwed: {
    bookingId: "b-cancelled-hand-back-open",
    bookingStatus: "CANCELLED",
    status: "SUCCEEDED",
    amountCents: 10_000,
    refundedAmountCents: 0,
    source: "INTERNET_BANKING",
    capturedLedgerRows: 1,
    deletedAt: null,
    creditsApplied: [],
    creditsFromCancellation: [],
    manualRefundTasks: [
      {
        status: "OPEN",
        kind: "CANCELLED_BOOKING_HAND_BACK",
        amountCents: 7_500,
        partPaymentReviewPaymentId: null,
      },
    ],
  },
  foldedUnpaidLive: {
    bookingId: "b-live-ib-folded-never-paid",
    bookingStatus: "CONFIRMED",
    status: "PARTIALLY_REFUNDED",
    amountCents: 45_000,
    refundedAmountCents: 5_000,
    source: "INTERNET_BANKING",
    capturedLedgerRows: 0,
    deletedAt: null,
    ...noCreditOrTask,
  },
  /** What every Net Collected figure must read over the six payments above. */
  expectedNetCollectedCents: 9_500,
} as const satisfies Record<string, FixtureRow | number>;

/** The fixture's six payments as a list. */
export const NET_COLLECTED_SCOPE_PAYMENTS: ReadonlyArray<FixtureRow> = [
  NET_COLLECTED_SCOPE_FIXTURE.keptFee,
  NET_COLLECTED_SCOPE_FIXTURE.deleted,
  NET_COLLECTED_SCOPE_FIXTURE.unpaidCancelled,
  NET_COLLECTED_SCOPE_FIXTURE.creditKept,
  NET_COLLECTED_SCOPE_FIXTURE.handBackOwed,
  NET_COLLECTED_SCOPE_FIXTURE.foldedUnpaidLive,
];

/** A fixture row's capture evidence, as `netCollectedCaptureEvidenceSelect` loads it. */
export function netCollectedFixtureEvidence(row: FixtureRow) {
  return { source: row.source, _count: { transactions: row.capturedLedgerRows } };
}

/** A fixture row's booking, in the shape `netCollectedBookingSelect` loads. */
export function netCollectedFixtureBooking(row: FixtureRow) {
  return {
    deletedAt: row.deletedAt,
    status: row.bookingStatus,
    creditsApplied: row.creditsApplied,
    creditsFromCancellation: row.creditsFromCancellation,
    manualRefundTasks: row.manualRefundTasks,
  };
}
