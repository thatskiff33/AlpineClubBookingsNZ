import { editRefundHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";

/**
 * #3372, owner decision A: ONE fixture for the one Net Collected booking scope,
 * handed to all four surfaces that show a "Net Collected" figure - the
 * dashboard card, the payments board tile, Reports' Net Collected and the
 * Finance dashboard's "Net Collected" (#3637) - so each surface's test
 * asserts the SAME expected amount from the SAME payments.
 *
 * Eight payments:
 *  - a CANCELLED booking that paid $200.00 and was refunded $150.00, so the
 *    club kept $50.00 of money it received. It counts: $50.00.
 *  - a CANCELLED booking that paid $120.00 and was refunded all of it (owner
 *    review on PR #3811: money refunded when the booking was cancelled was not
 *    kept). It adds nil.
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
 *  - a LIVE (PAID) booking that paid $200.00 by card and was edited down by
 *    $50.00, with that refund still an OPEN hand-back task (owner decision on
 *    #3372, 7 Oct 2026: "subtract it immediately"; an edit's refund,
 *    `INV-PAY-117`). It counts: $150.00.
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
 * $245.00.
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
    /**
     * Set only where the writer sets one: an edit's refund carries
     * `edit-refund-hand-back:<modification>` (`INV-PAY-117`). The Net
     * Collected reader keys on kind and status alone, so this proves the key
     * changes nothing.
     */
    occurrenceKey?: string | null;
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
  fullyRefunded: {
    bookingId: "b-cancelled-fully-refunded",
    bookingStatus: "CANCELLED",
    status: "REFUNDED",
    amountCents: 12_000,
    refundedAmountCents: 12_000,
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
  liveEditRefundOpen: {
    bookingId: "b-live-edit-refund-open",
    bookingStatus: "PAID",
    status: "SUCCEEDED",
    amountCents: 20_000,
    refundedAmountCents: 0,
    source: "STRIPE",
    capturedLedgerRows: 1,
    deletedAt: null,
    creditsApplied: [],
    creditsFromCancellation: [],
    manualRefundTasks: [
      {
        status: "OPEN",
        kind: "CANCELLED_BOOKING_HAND_BACK",
        amountCents: 5_000,
        partPaymentReviewPaymentId: null,
        occurrenceKey: editRefundHandBackOccurrenceKey("mod-live-edit-refund"),
      },
    ],
  },
  /** What every Net Collected figure must read over the eight payments above. */
  expectedNetCollectedCents: 24_500,
} as const satisfies Record<string, FixtureRow | number>;

/** The fixture's eight payments as a list. */
export const NET_COLLECTED_SCOPE_PAYMENTS: ReadonlyArray<FixtureRow> = [
  NET_COLLECTED_SCOPE_FIXTURE.keptFee,
  NET_COLLECTED_SCOPE_FIXTURE.fullyRefunded,
  NET_COLLECTED_SCOPE_FIXTURE.deleted,
  NET_COLLECTED_SCOPE_FIXTURE.unpaidCancelled,
  NET_COLLECTED_SCOPE_FIXTURE.creditKept,
  NET_COLLECTED_SCOPE_FIXTURE.handBackOwed,
  NET_COLLECTED_SCOPE_FIXTURE.foldedUnpaidLive,
  NET_COLLECTED_SCOPE_FIXTURE.liveEditRefundOpen,
];

/**
 * #3372 (owner, 7 Oct 2026): the "Refunds owed" and "Credits owed" figures
 * every Net Collected surface shows beside it, as at today and club-wide. ONE
 * fixture, handed to all four surfaces through the two reads they make
 * (`manualRefundTask.findMany` for open tasks, `memberCredit.groupBy` for
 * balances), so each asserts the same totals.
 *
 * Open tasks: four refunds still owed - a cancellation's ($75.00), an edit's
 * refund on a live booking ($50.00), one with no kind, from before the column
 * ($10.00), and a late card charge awaiting the treasurer's refund-or-keep
 * decision ($30.00; owner, 7 Oct 2026: "count as owed") - and three that are
 * not: a part-payment review (no amount, settled in Xero), an unpriced edit
 * financial review an officer has still to confirm, and a priced one ($40.00,
 * not yet confirmed). No card refund is outstanding here; the reconciliation
 * fixture below covers those.
 *
 * Credit ledger: four members' entries. One has $100.00 issued and $40.00 used
 * ($60.00 left); one $25.00 unused; one used all it had; one is (wrongly)
 * $5.00 negative, which owes nothing and must not hide the others.
 */
export const REFUNDS_AND_CREDITS_OWED_FIXTURE = {
  openTasks: [
    { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 7_500, partPaymentReviewPaymentId: null, refundOwed: true },
    { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 5_000, partPaymentReviewPaymentId: null, refundOwed: true },
    { status: "OPEN", kind: null, amountCents: 1_000, partPaymentReviewPaymentId: null, refundOwed: true },
    { status: "OPEN", kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: null, partPaymentReviewPaymentId: "pay-review", refundOwed: false },
    { status: "OPEN", kind: "EDIT_FINANCIAL_REVIEW", amountCents: null, partPaymentReviewPaymentId: null, refundOwed: false },
    { status: "OPEN", kind: "EDIT_FINANCIAL_REVIEW", amountCents: 4_000, partPaymentReviewPaymentId: null, refundOwed: false },
    { status: "OPEN", kind: "DELETED_BOOKING_LATE_CAPTURE", amountCents: 3_000, partPaymentReviewPaymentId: null, refundOwed: true },
  ],
  creditEntries: [
    { memberId: "m-part-used", amountCents: 10_000 },
    { memberId: "m-part-used", amountCents: -4_000 },
    { memberId: "m-unused", amountCents: 2_500 },
    { memberId: "m-all-used", amountCents: 3_000 },
    { memberId: "m-all-used", amountCents: -3_000 },
    { memberId: "m-negative", amountCents: -500 },
  ],
  expectedRefundsOwedCents: 16_500,
  expectedCreditsOwedCents: 8_500,
} as const;

/**
 * The open tasks as `manualRefundTask.findMany` returns them (no test marker),
 * each with its booking's `deletedAt`.
 */
export function refundsOwedTaskRows(): Array<{
  status: string;
  kind: string | null;
  amountCents: number | null;
  partPaymentReviewPaymentId: string | null;
  booking: { deletedAt: Date | null };
}> {
  return REFUNDS_AND_CREDITS_OWED_FIXTURE.openTasks.map((task) => ({
    status: task.status,
    kind: task.kind,
    amountCents: task.amountCents,
    partPaymentReviewPaymentId: task.partPaymentReviewPaymentId,
    booking: { deletedAt: null },
  }));
}

/** The ledger as `memberCredit.groupBy({ by: ["memberId"], _sum })` returns it. */
export function creditBalanceGroupRows() {
  const byMember = new Map<string, number>();
  for (const entry of REFUNDS_AND_CREDITS_OWED_FIXTURE.creditEntries) {
    byMember.set(entry.memberId, (byMember.get(entry.memberId) ?? 0) + entry.amountCents);
  }
  return [...byMember].map(([memberId, amountCents]) => ({ memberId, _sum: { amountCents } }));
}

/**
 * A fixture row's capture evidence, as `netCollectedCaptureEvidenceSelect`
 * loads it, and its card refunds not yet paid (`netCollectedCardRefundSelect`):
 * none on the scope fixture's eight payments.
 */
export function netCollectedFixtureEvidence(row: FixtureRow) {
  return {
    source: row.source,
    _count: { transactions: row.capturedLedgerRows },
    recoveryOperations: [],
    refunds: [],
  };
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

/** A card refund operation row, as `netCollectedCardRefundSelect` loads it. */
type CardRefundOperationFixture = {
  type: string;
  status: string;
  amountCents: number;
  allocationPlan: Array<{ paymentTransactionId: string; amountCents: number }> | null;
  paymentTransactionId: string | null;
  createdAt: Date;
};

type ReconciliationRow = FixtureRow & {
  memberId: string;
  recoveryOperations: ReadonlyArray<CardRefundOperationFixture>;
  refunds: ReadonlyArray<{
    paymentTransactionId: string | null;
    amountCents: number;
    status: string;
    createdAt: Date;
  }>;
};

const LATE_BANK_CREDIT_DESCRIPTION = "Internet Banking payment credit for booking b-late-bank-credit";

/**
 * #3372 (owner, 7 Oct 2026, decisions (c) and (d), and the money review of
 * #3924): Net Collected, "Refunds owed" and "Credits owed" over one set of
 * bookings, so the three can be checked against one another to the cent.
 * Every amount owed back comes off Net Collected for its own booking and
 * counts once in Refunds owed (or, for credit, Credits owed); nothing is both
 * kept and owed.
 *
 *  - a CANCELLED card booking, $200.00 paid, whose $150.00 card refund FAILED
 *    at Stripe and waits for a retry. Net Collected $50.00; owed $150.00.
 *  - a CANCELLED card booking, $300.00 over two charges, refunded $20.00 before
 *    the cancel; the cancel's $250.00 card refund has sent its first $100.00
 *    slice (recorded) and not its $150.00 second. Net Collected $30.00; owed
 *    $150.00. Without the net-out it reads $0.00 (owed capped at $180.00); one
 *    that also nets the earlier $20.00 reads $50.00.
 *  - a CANCELLED card booking refunded in full on the cancel, then a $40.00
 *    change payment captured late and HELD for the treasurer (#3639). Net
 *    Collected $0.00; owed $40.00 until kept.
 *  - a CANCELLED Internet Banking booking whose $90.00 bank transfer arrived
 *    after the cancel and was credited to the member's account. Net Collected
 *    $0.00; Credits owed $90.00.
 *  - a DELETED booking with a $25.00 change payment captured after it was
 *    deleted, its #2700 task raised before task kinds existed (no kind). Out
 *    of Net Collected's scope; owed $25.00.
 *  - a LIVE card booking paid $100.00, nothing owed. Net Collected $100.00.
 *
 * Credit ledger: the late bank credit's member holds $90.00; another member
 * has $30.00 issued and $10.00 used.
 */
export const OWED_RECONCILIATION_PAYMENTS: ReadonlyArray<ReconciliationRow> = [
  {
    bookingId: "b-card-refund-failed",
    memberId: "m-card-refund-failed",
    bookingStatus: "CANCELLED",
    status: "SUCCEEDED",
    amountCents: 20_000,
    refundedAmountCents: 0,
    source: "STRIPE",
    capturedLedgerRows: 1,
    deletedAt: null,
    creditsApplied: [],
    creditsFromCancellation: [],
    manualRefundTasks: [],
    recoveryOperations: [
      {
        type: "REFUND_BOOKING_MODIFICATION",
        status: "FAILED",
        amountCents: 15_000,
        allocationPlan: [{ paymentTransactionId: "txn-failed", amountCents: 15_000 }],
        paymentTransactionId: null,
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
      },
    ],
    refunds: [],
  },
  {
    bookingId: "b-card-refund-part-sent",
    memberId: "m-card-refund-part-sent",
    bookingStatus: "CANCELLED",
    status: "PARTIALLY_REFUNDED",
    amountCents: 30_000,
    refundedAmountCents: 12_000,
    source: "STRIPE",
    capturedLedgerRows: 2,
    deletedAt: null,
    creditsApplied: [],
    creditsFromCancellation: [],
    manualRefundTasks: [],
    recoveryOperations: [
      {
        type: "REFUND_BOOKING_MODIFICATION",
        status: "PROCESSING",
        amountCents: 25_000,
        allocationPlan: [
          { paymentTransactionId: "txn-b", amountCents: 10_000 },
          { paymentTransactionId: "txn-a", amountCents: 15_000 },
        ],
        paymentTransactionId: null,
        createdAt: new Date("2026-06-21T00:00:00.000Z"),
      },
    ],
    refunds: [
      // Before the cancel: not this operation's.
      { paymentTransactionId: "txn-a", amountCents: 2_000, status: "succeeded", createdAt: new Date("2026-06-01T00:00:00.000Z") },
      // The operation's first slice, recorded before it closed.
      { paymentTransactionId: "txn-b", amountCents: 10_000, status: "succeeded", createdAt: new Date("2026-06-21T00:00:05.000Z") },
    ],
  },
  {
    bookingId: "b-late-capture-held",
    memberId: "m-late-capture-held",
    bookingStatus: "CANCELLED",
    status: "PARTIALLY_REFUNDED",
    amountCents: 16_000,
    refundedAmountCents: 12_000,
    source: "STRIPE",
    capturedLedgerRows: 2,
    deletedAt: null,
    creditsApplied: [],
    creditsFromCancellation: [],
    manualRefundTasks: [
      { status: "OPEN", kind: "DELETED_BOOKING_LATE_CAPTURE", amountCents: 4_000, partPaymentReviewPaymentId: null },
    ],
    recoveryOperations: [],
    refunds: [],
  },
  {
    bookingId: "b-late-bank-credit",
    memberId: "m-late-bank-credit",
    bookingStatus: "CANCELLED",
    status: "SUCCEEDED",
    amountCents: 9_000,
    refundedAmountCents: 0,
    source: "INTERNET_BANKING",
    capturedLedgerRows: 1,
    deletedAt: null,
    creditsApplied: [],
    creditsFromCancellation: [
      { type: "CANCELLATION_REFUND", amountCents: 9_000, restoredFromBookingId: null },
    ],
    manualRefundTasks: [],
    recoveryOperations: [],
    refunds: [],
  },
  {
    bookingId: "b-deleted-late-capture",
    memberId: "m-deleted-late-capture",
    bookingStatus: "CANCELLED",
    status: "SUCCEEDED",
    amountCents: 2_500,
    refundedAmountCents: 0,
    source: "STRIPE",
    capturedLedgerRows: 1,
    deletedAt: new Date("2026-06-10T00:00:00.000Z"),
    creditsApplied: [],
    creditsFromCancellation: [],
    manualRefundTasks: [
      { status: "OPEN", kind: null, amountCents: 2_500, partPaymentReviewPaymentId: null },
    ],
    recoveryOperations: [],
    refunds: [],
  },
  {
    bookingId: "b-live-paid",
    memberId: "m-live-paid",
    bookingStatus: "PAID",
    status: "SUCCEEDED",
    amountCents: 10_000,
    refundedAmountCents: 0,
    source: "STRIPE",
    capturedLedgerRows: 1,
    deletedAt: null,
    creditsApplied: [],
    creditsFromCancellation: [],
    manualRefundTasks: [],
    recoveryOperations: [],
    refunds: [],
  },
];

/** The credit ledger beside those payments. */
export const OWED_RECONCILIATION_CREDIT_ENTRIES = [
  { memberId: "m-late-bank-credit", amountCents: 9_000, description: LATE_BANK_CREDIT_DESCRIPTION },
  { memberId: "m-other", amountCents: 3_000, description: "Cancellation credit" },
  { memberId: "m-other", amountCents: -1_000, description: "Applied to a booking" },
] as const;

/** What the three figures must read over the fixture above, in cents. */
export const OWED_RECONCILIATION_EXPECTED = {
  netCollectedCents: 18_000,
  cardRefundOwedCents: 30_000,
  lateCaptureOwedCents: 4_000,
  lateCashCreditedCents: 9_000,
  refundsOwedCents: 36_500,
  creditsOwedCents: 11_000,
} as const;

/** A reconciliation row as a Net Collected select loads it. */
export function owedReconciliationPaymentRow(row: ReconciliationRow) {
  return {
    status: row.status,
    amountCents: row.amountCents,
    refundedAmountCents: row.refundedAmountCents,
    source: row.source,
    _count: { transactions: row.capturedLedgerRows },
    recoveryOperations: row.recoveryOperations,
    refunds: row.refunds,
    booking: {
      ...netCollectedFixtureBooking(row),
      creditsFromCancellation: row.creditsFromCancellation.map((credit) => ({
        ...credit,
        description: credit.type === "CANCELLATION_REFUND" ? LATE_BANK_CREDIT_DESCRIPTION : null,
      })),
    },
  };
}

/** The open tasks over those bookings, as the "Refunds owed" read loads them. */
export function owedReconciliationTaskRows() {
  return OWED_RECONCILIATION_PAYMENTS.flatMap((row) =>
    row.manualRefundTasks
      .filter((task) => task.status === "OPEN")
      .map((task) => ({ ...task, booking: { deletedAt: row.deletedAt } })),
  );
}

/** The open card refunds, as the "Refunds owed" read loads them. */
export function owedReconciliationCardRefundRows() {
  return OWED_RECONCILIATION_PAYMENTS.flatMap((row) =>
    row.recoveryOperations.map((operation) => ({
      paymentId: `pay-${row.bookingId}`,
      ...operation,
      payment: {
        status: row.status,
        amountCents: row.amountCents,
        refundedAmountCents: row.refundedAmountCents,
        refunds: row.refunds,
      },
    })),
  );
}

/** The credit ledger as `memberCredit.groupBy({ by: ["memberId"], _sum })` returns it. */
export function owedReconciliationCreditGroupRows() {
  const byMember = new Map<string, number>();
  for (const entry of OWED_RECONCILIATION_CREDIT_ENTRIES) {
    byMember.set(entry.memberId, (byMember.get(entry.memberId) ?? 0) + entry.amountCents);
  }
  return [...byMember].map(([memberId, amountCents]) => ({ memberId, _sum: { amountCents } }));
}
