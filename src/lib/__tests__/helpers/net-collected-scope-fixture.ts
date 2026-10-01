/**
 * #3372, owner decision A: ONE fixture for the one Net Collected booking scope,
 * handed to all four surfaces that show a "Net Collected" figure - the
 * dashboard card, the payments board tile, Reports' Net Collected Cash and the
 * Finance dashboard's "Net Collected Cash" (#3637) - so each surface's test
 * asserts the SAME expected amount from the SAME payments.
 *
 * Two payments:
 *  - a CANCELLED booking that paid $200.00 and was refunded $150.00, so the
 *    club kept a $50.00 cancellation fee. It counts: $50.00 is money collected.
 *  - a SOFT-DELETED booking's captured $70.00. It does not count.
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
  /** What every Net Collected figure must read over the two payments above. */
  expectedNetCollectedCents: 5_000,
} as const;

/** The fixture's two payments as a list. */
export const NET_COLLECTED_SCOPE_PAYMENTS = [
  NET_COLLECTED_SCOPE_FIXTURE.keptFee,
  NET_COLLECTED_SCOPE_FIXTURE.deleted,
] as const;
