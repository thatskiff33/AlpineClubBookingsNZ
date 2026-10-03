/**
 * #3372, owner decision A: ONE fixture for the one Net Collected booking scope,
 * handed to all four surfaces that show a "Net Collected" figure - the
 * dashboard card, the payments board tile, Reports' Net Collected Cash and the
 * Finance dashboard's "Net Collected Cash" (#3637) - so each surface's test
 * asserts the SAME expected amount from the SAME payments.
 *
 * Three payments:
 *  - a CANCELLED booking that paid $200.00 and was refunded $150.00, so the
 *    club kept $50.00 of money it received. It counts: $50.00 is money collected.
 *  - a SOFT-DELETED booking's captured $70.00. It does not count.
 *  - a CANCELLED booking that was NEVER PAID (owner review on PR #3811): its
 *    payment never took money, so it adds nil, whatever its price or its
 *    policy's fee. It carries a $30.00 refund on its mirror - the shape the
 *    inbound reconcile leaves when it folds a modification credit note into an
 *    unpaid Internet Banking payment that the unpaid cancel then marks FAILED -
 *    so a derivation that pools refunds across payments reads $20.00 instead.
 *
 * Each surface used to answer differently: the payments tile, Reports and
 * Finance left the cancelled booking out ($0.00), the dashboard counted the
 * deleted booking too ($120.00). Under the one scope all four read $50.00.
 */
export const NET_COLLECTED_SCOPE_FIXTURE = {
  keptFee: {
    bookingId: "b-cancelled-kept-fee",
    bookingStatus: "CANCELLED",
    status: "PARTIALLY_REFUNDED",
    amountCents: 20_000,
    refundedAmountCents: 15_000,
    deletedAt: null,
  },
  deleted: {
    bookingId: "b-soft-deleted",
    bookingStatus: "CANCELLED",
    status: "SUCCEEDED",
    amountCents: 7_000,
    refundedAmountCents: 0,
    deletedAt: new Date("2026-04-02T00:00:00.000Z"),
  },
  unpaidCancelled: {
    bookingId: "b-cancelled-never-paid",
    bookingStatus: "CANCELLED",
    status: "FAILED",
    amountCents: 20_000,
    refundedAmountCents: 3_000,
    deletedAt: null,
  },
  /** What every Net Collected figure must read over the three payments above. */
  expectedNetCollectedCents: 5_000,
} as const;

/** The fixture's three payments as a list. */
export const NET_COLLECTED_SCOPE_PAYMENTS = [
  NET_COLLECTED_SCOPE_FIXTURE.keptFee,
  NET_COLLECTED_SCOPE_FIXTURE.deleted,
  NET_COLLECTED_SCOPE_FIXTURE.unpaidCancelled,
] as const;
