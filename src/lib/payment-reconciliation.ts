import { prisma } from "@/lib/prisma";
import {
  BookingEventType,
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import {
  findPaymentTransactionByIntentId,
  planStripeRefundAllocation,
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import {
  enqueueCapacityClaimFailedRefundRecovery,
  enqueueDuplicateCaptureRefundRecovery,
  enqueuePaymentIntentCancellationRecovery,
  findOtherDuplicateCaptureRefundOperation,
  markCapacityClaimFailedRefundRecoverySucceeded,
  markDuplicateCaptureRefundRecoverySucceeded,
  recordCapacityClaimFailedRefundRecoveryInlineError,
  recordDuplicateCaptureRefundRecoveryInlineError,
} from "@/lib/payment-recovery";
import {
  buildBookingModificationRefundMetadata,
  buildCapacityClaimFailedRefundStripeKeyPrefix,
  buildDuplicateCaptureRefundRecoveryIdempotencyKey,
  buildDuplicateCaptureRefundStripeKeyPrefix,
} from "@/lib/payment-recovery-keys";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  deriveBookingAppliedCreditCents,
  lockMemberCreditLedger,
  restoreCreditFromBooking,
} from "@/lib/member-credit";
import { createAuditLog } from "@/lib/audit";
import { cancelPaymentIntentIfCancellable } from "@/lib/stripe";
import {
  MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND,
  MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
  type ManualSettlementReversalEventSnapshot,
} from "@/lib/manual-settlement-reversal-event";
import {
  recordBookingEvent,
  recordDuplicateCaptureRefundEvent,
} from "@/lib/booking-events";
import {
  sendAdminDuplicateCaptureRefundAlert,
  sendAdminPaymentFailureAlert,
} from "@/lib/email";
import logger from "@/lib/logger";
import { clearStaleCreditElection } from "@/lib/booking-credit-election";
import { reportUnappliedCreditElection } from "@/lib/booking-credit-election-report";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { getDefaultLodgeId } from "@/lib/lodges";
import {
  isManualSettleFromPaymentStatus,
  MANUAL_CAPTURED_PAYMENT_REFUSAL,
  MANUAL_SETTLE_FROM_PAYMENT_STATUS_LIST,
} from "@/lib/booking-payment-state";
import { isAdditionalAmountUncollected } from "@/lib/unpaid-finished-stays";
import {
  bookingHasCapacityOverride,
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
} from "@/lib/booking-status";

type ReconciliationBooking = Prisma.BookingGetPayload<{
  include: {
    guests: true;
    member: true;
  };
}>;

export type MarkBookingPaymentSucceededResult = {
  outcome:
    | "paid"
    | "already_paid"
    | "cancelled_refunded"
    | "cancelled_refund_failed"
    // #1992 — a SECOND, distinct Stripe capture arrived on an already-PAID
    // booking (the residual #1967 split-child window). The duplicate capture
    // was auto-refunded (or a durable refund operation is pending for the
    // recovery cron when the inline attempt failed). The booking itself stays
    // settled by the other capture, so callers that only branch on the
    // cancelled_* outcomes keep treating these as "settled".
    | "duplicate_capture_refunded"
    | "duplicate_capture_refund_failed";
  bookingId: string;
  bumpedBookingIds: string[];
  refundError?: string;
};

const PAYABLE_SUCCESS_STATUS_LIST = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PENDING,
  BookingStatus.DRAFT,
] as const;

const PAYABLE_SUCCESS_STATUSES = new Set<string>(PAYABLE_SUCCESS_STATUS_LIST);

// #2397: the payment statuses a manual settlement may settle FROM, and the
// refusal for everything else, live in the leaf `booking-payment-state` module
// so the read-time refusal below, the fenced write's WHERE and the admin page's
// advisory state all consume ONE list. The fence alone used to leave the read
// path offering an action that was certain to 409, with a message ("changed
// while you were recording it") that was simply untrue — nothing had changed.

// #1992 (superseded-handoff exclusion) — the pre-existing superseded-intent
// machinery (booking-payment-cleanup queues a CANCEL_PAYMENT_INTENT recovery
// operation; when the cancel loses to a late capture, payment-recovery's
// handoff marks that transaction SUCCEEDED and queues a
// REFUND_SUPERSEDED_PAYMENT operation for the cron) transiently produces
// EXACTLY the shape the duplicate-capture predicate below hunts for: another
// SUCCEEDED PRIMARY Stripe capture with net cash under a different intent id,
// with no duplicate_capture adjudication marker (the handoff never passes
// through markBookingPaymentSucceeded). That capture's money is already spoken
// for — the recovery cron will refund it under its
// `payment_recovery_refund_<txn>_<pi>` key — so treating it as "the
// settlement" would refund the REAL settlement as the duplicate and, once the
// cron also refunds the superseded capture, leave the booking PAID at zero net
// cash. A superseded-machinery operation counts as LIVE while it is not
// SUCCEEDED: PENDING, PROCESSING and FAILED (retrying or exhausted, where the
// money is still adjudicated to that machinery and admins were alerted). A
// SUCCEEDED cancel operation either actually cancelled the intent (its
// transaction is FAILED — never a predicate candidate) or handed off to a
// refund operation that is enqueued BEFORE the cancel operation completes; a
// SUCCEEDED refund operation leaves the transaction REFUNDED, which predicate
// (b) already excludes. So `status != SUCCEEDED` across both types covers the
// whole handoff window with no gap.
const SUPERSEDED_INTENT_OPERATION_TYPES = [
  PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
  PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
] as const;

/**
 * Guard (b′): every intent id on this payment whose money a live
 * superseded-intent recovery operation already owns. Run under lock(1) inside
 * the reconciliation transaction; the result feeds the `notIn` exclusion of
 * the duplicate-capture candidate query.
 */
async function listLiveSupersededIntentIds(
  tx: Prisma.TransactionClient,
  paymentId: string
): Promise<string[]> {
  const operations = await tx.paymentRecoveryOperation.findMany({
    where: {
      paymentId,
      type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    select: { paymentIntentId: true },
  });
  return [...new Set(operations.map((operation) => operation.paymentIntentId))];
}

/**
 * Guard (c′), belt-and-braces sibling of (b′) with a deliberately DIFFERENT
 * query shape (direct intent-id lookup, not scoped to a payment): does a live
 * superseded-intent recovery operation own this specific intent's money? Used
 * to re-check the matched "settlement" candidate so that even if it slipped
 * the (b′) exclusion, the arriving capture stays plain already_paid.
 */
async function findLiveSupersededIntentOperation(
  tx: Prisma.TransactionClient,
  paymentIntentId: string
) {
  return tx.paymentRecoveryOperation.findFirst({
    where: {
      paymentIntentId,
      type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    select: { id: true },
  });
}

async function alertRefundFailure({
  booking,
  paymentIntentId,
  amountCents,
  error,
}: {
  booking: ReconciliationBooking;
  paymentIntentId: string;
  amountCents: number;
  error: unknown;
}) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  sendAdminPaymentFailureAlert({
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    amountCents,
    errorMessage: `Payment succeeded but final capacity claim failed and automatic refund failed: ${errorMessage}`,
    paymentIntentId,
  }).catch((alertErr) =>
    logger.error(
      { err: alertErr, bookingId: booking.id, paymentIntentId },
      "Failed to alert admins about capacity refund failure"
    )
  );
}

/**
 * B5 (#2262) — a booking settlement is now described by its SOURCE, so the one
 * settlement body below serves both the Stripe capture and the admin recording
 * a cash / off-Xero bank transfer. Guard 1 of #2262 is discharged structurally:
 * there is no second path that could drift from this one's lock ordering,
 * capacity check, status fence, bed reconciliation or event recording.
 */
type StripeSettlementSource = {
  kind: "stripe";
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
};

/**
 * #2397 — the admin's answer to "does this cash also cover the outstanding
 * extra?", asked ONLY when the booking carries one.
 *
 * `expectedAdditionalAmountCents` is the figure the dialog showed, and follows
 * the same law as `expectedAmountCents`: the settle never takes an amount from
 * the client, it re-derives the outstanding extra under the locks and refuses
 * when the two disagree, so an extra that moved since the dialog rendered is
 * never settled at a figure the admin never saw.
 */
export type ManualAdditionalCoverage = {
  /** True = the cash covers the extra too; false = leave it outstanding. */
  covered: boolean;
  expectedAdditionalAmountCents: number;
};

type ManualSettlementSource = {
  kind: "manual";
  actingAdminMemberId: string;
  note: string | null;
  /**
   * The amount the admin was shown in the dialog. The settlement amount itself
   * is NEVER taken from the client — it is recomputed under the locks — but a
   * mismatch means the price or the applied credit moved since the dialog
   * rendered, so the settle is refused rather than recorded at a figure the
   * admin never agreed to.
   */
  expectedAmountCents: number;
  notifyMember: boolean;
  /**
   * #2397. `null` is not "no opinion": it is the caller's positive claim that
   * the dialog showed NO outstanding extra, and the settle checks that claim
   * under the locks — an extra that exists with `null` here is a 409, exactly
   * as a moved price is. That keeps the common screen unchanged (no extra, no
   * question, no field) without letting a stale client silently settle only the
   * primary on a booking that has since grown an extra.
   */
  additionalCoverage: ManualAdditionalCoverage | null;
};

type BookingSettlementSource = StripeSettlementSource | ManualSettlementSource;

/**
 * B5 (#2262): a domain refusal from the manual booking-payment paths, carrying
 * the HTTP status the route should answer with. Lives here (rather than in
 * manual-booking-payment.ts) so the settlement core can throw it without a
 * circular import.
 */
export class ManualBookingPaymentError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ManualBookingPaymentError";
    this.status = status;
  }
}

const MANUAL_XERO_INVOICE_REFUSAL =
  "This booking has an outstanding Xero invoice — record the payment against the invoice in Xero instead.";
const MANUAL_XERO_QUEUED_MINT_REFUSAL =
  "A Xero invoice for this booking is already queued — let it finish, then record the payment against the invoice in Xero.";
const MANUAL_GROUP_SETTLEMENT_REFUSAL =
  "This booking was settled as part of a group booking — record the payment against the group settlement instead.";

/**
 * B5 (#2262) guard 2, read side. Every piece of evidence that a Xero invoice
 * exists — or is about to — for this payment. Run under lock(1) inside the
 * settlement/reversal transaction, before any write.
 *
 * The payment-level and transaction-level conditions are ALSO re-asserted in
 * the fenced write, because an invoice can be minted between this read and that
 * write. The object-link and outbox-operation evidence are read-time refusals:
 * they cannot be expressed as a Payment WHERE, and the settle-time refusal plus
 * the choke-point and handler fences in the Xero mint path close that race from
 * the other side.
 */
async function assertNoXeroInvoiceEvidence(
  tx: Prisma.TransactionClient,
  payment: {
    id: string;
    xeroInvoiceId: string | null;
    xeroRefundCreditNoteId: string | null;
  }
) {
  if (payment.xeroInvoiceId || payment.xeroRefundCreditNoteId) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  // Transaction-stamped-but-payment-null is a MODELED drift state, not a
  // hypothesis: the zero-cash inbound arm stamps the transaction rows in writes
  // that do not also stamp the payment, and the repair classifier backfills the
  // payment-level id from exactly that transaction-level evidence. A
  // payment-level check alone is a hole.
  const stampedTransaction = await tx.paymentTransaction.findFirst({
    where: { paymentId: payment.id, xeroInvoiceId: { not: null } },
    select: { id: true },
  });
  if (stampedTransaction) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  const activeInvoiceLink = await tx.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: payment.id,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });
  if (activeInvoiceLink) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  const completedMint = await tx.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: payment.id,
      status: "SUCCEEDED",
    },
    select: { id: true },
  });
  if (completedMint) {
    throw new ManualBookingPaymentError(MANUAL_XERO_INVOICE_REFUSAL, 409);
  }

  // An invoice mint that is queued but has not fired yet. Without this the
  // common ordering — an operation enqueued minutes before the cron picks it up
  // — lets a mark-paid commit while a real awaiting-payment invoice is about to
  // be created AND EMAILED to the member for money already collected in cash.
  // The repair classifier already models this exact state as its own finding
  // (BLOCKED_BY_XERO_OPERATION), so it is a real, observed state.
  //
  // Deliberately a SUPERSET of the choke point's own predicate: WAITING_PAYMENT
  // is included alongside PENDING/RUNNING because such an operation is
  // unambiguously a mint that has not happened yet and will fire later.
  const inFlightMint = await tx.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: payment.id,
      status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
    },
    select: { id: true },
  });
  if (inFlightMint) {
    throw new ManualBookingPaymentError(MANUAL_XERO_QUEUED_MINT_REFUSAL, 409);
  }
}

/**
 * B5 (#2262): everything the manual path decides BEFORE the shared settlement
 * body writes anything — the third lock tier, every refusal, and the settlement
 * amount. Split out only so the shared body below stays readable; every step
 * the four guards care about (locks, capacity, fences, bed reconciliation,
 * events) still lives in the one settlement body.
 *
 * Runs under lock(1) + the per-lodge lock, and takes the MEMBER-CREDIT lock as
 * the third tier (global -> lodge -> member-credit, the same composition
 * switch-to-internet-banking uses) before deriving the amount, so the derived
 * figure cannot race an applied-credit writer.
 */
async function prepareManualSettlement(
  tx: Prisma.TransactionClient,
  booking: ReconciliationBooking,
  settlement: ManualSettlementSource
) {
  // Third lock tier. Credit writers serialise on a per-member key, not lock(1),
  // so the switch-to-internet-banking precedent deliberately refuses to rely on
  // other writers holding lock(1); this path does the same.
  await lockMemberCreditLedger(booking.memberId, tx);

  if (booking.status === BookingStatus.PAID) {
    // Refusal, never the duplicate-adjudication branch: no manual money fact
    // has been written yet, so rolling back is exact and the admin keeps the
    // cash rather than the club recording it twice.
    throw new ManualBookingPaymentError(
      "This booking is already paid — nothing was recorded.",
      409
    );
  }

  if (!PAYABLE_SUCCESS_STATUSES.has(booking.status)) {
    throw new ManualBookingPaymentError(
      `This booking cannot be paid from status ${booking.status}.`,
      409
    );
  }

  // Guard 2, conservative v1 group fence (owner-decided 28 Jul). organiserSettled
  // is set once, under lock(1), by the group-settlement path, so the post-lock
  // re-read decides it permanently. Each-pays group members and the organiser's
  // own parent booking are deliberately NOT fenced.
  if (booking.organiserSettled) {
    throw new ManualBookingPaymentError(MANUAL_GROUP_SETTLEMENT_REFUSAL, 409);
  }

  const payment = await tx.payment.findUnique({
    where: { bookingId: booking.id },
    select: {
      id: true,
      status: true,
      xeroInvoiceId: true,
      xeroRefundCreditNoteId: true,
      manuallyMarkedPaidAt: true,
      refundedAmountCents: true,
      // #2397: the upward-modification delta and its collection state, read
      // under the same locks as the amount law below.
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      // #2397 F4: the member's live card instrument for that delta, so the
      // settlement can spare it when the cash did not cover the delta.
      additionalPaymentIntentId: true,
    },
  });

  if (payment) {
    if (payment.manuallyMarkedPaidAt) {
      throw new ManualBookingPaymentError(
        "This booking's payment is already recorded as a manual settlement.",
        409
      );
    }
    // THE ORDER OF THE THREE REFUSALS BELOW IS DELIBERATE AND SHARED (#2397).
    // `getBookingManualPaymentState` (src/lib/manual-booking-payment-state.ts)
    // applies the same three in the same order, so a booking that trips more
    // than one is given the SAME sentence before the click and after it —
    // refund history, then already-captured, then Xero evidence. Refund history
    // goes first because it is the most specific truth available: a fully
    // REFUNDED payment is also a captured one, and "already carries refund
    // history" names a remedy ("resolve the refund first") that the captured
    // message can only gesture at. Xero goes last so the cheap in-memory
    // refusals settle it without the three lookups `assertNoXeroInvoiceEvidence`
    // costs inside this locked transaction. Any change here must be made in
    // both files.
    //
    // L7 (#2262): a manually settled payment carries NO prior refund history.
    // Money already handed back through the ledger cannot be reconciled with a
    // cash settlement recorded over the top of it — the reversal's fences and
    // the settle's own mirror both assume refundedAmountCents starts at 0 —
    // so the settle refuses rather than recording an irreconcilable row. The
    // fenced write below re-asserts this as a WHERE condition.
    if (payment.refundedAmountCents !== 0) {
      throw new ManualBookingPaymentError(
        "This booking's payment already carries refund history — it cannot be recorded as a manual settlement. Cancel and rebook, or resolve the refund first.",
        409
      );
    }
    // #2397: the read-time twin of the fenced write's status clause. Without
    // it, a booking whose card capture stranded before its status promotion
    // (the #1418 confirm-pending-guests / cron-confirm-pending incident state:
    // booking still CONFIRMED or PAYMENT_PENDING, payment already SUCCEEDED)
    // passed every read guard, opened the whole dialog — including #2397's own
    // "does the cash cover the extra?" question, since an upward modification
    // in that window is exactly what records an uncollected delta — and then
    // failed at the fence with "changed while you were recording it", which was
    // false and would repeat on every retry. Refuse where the truth is known.
    if (!isManualSettleFromPaymentStatus(payment.status)) {
      throw new ManualBookingPaymentError(MANUAL_CAPTURED_PAYMENT_REFUSAL, 409);
    }
    await assertNoXeroInvoiceEvidence(tx, payment);
  }

  // The amount law. The manual path NEVER accepts a client-supplied settlement
  // amount: it recomputes the effective price under the full lock set.
  const creditAppliedCents = await deriveBookingAppliedCreditCents(
    booking.id,
    tx
  );
  const effectiveAmountCents = booking.finalPriceCents - creditAppliedCents;

  if (!Number.isSafeInteger(effectiveAmountCents)) {
    throw new ManualBookingPaymentError(
      "This booking's amount owing is not a whole number of cents — refresh and check the booking's price.",
      409
    );
  }
  if (effectiveAmountCents <= 0) {
    // Verified: no $0 booking is stranded without one of these paths.
    throw new ManualBookingPaymentError(
      "This booking has nothing owing — use Force confirm / Confirm pending guests instead.",
      409
    );
  }
  if (effectiveAmountCents !== settlement.expectedAmountCents) {
    throw new ManualBookingPaymentError(
      "The amount owing changed while you were recording this payment — refresh and check the figure before recording it.",
      409
    );
  }

  // The ledger mirror holds by construction (effective = final - credit), but
  // assert it explicitly so a future change to either derivation is caught here
  // rather than in the ledger.
  if (effectiveAmountCents + creditAppliedCents !== booking.finalPriceCents) {
    throw new ManualBookingPaymentError(
      "This booking's payment ledger does not reconcile — refresh and try again.",
      409
    );
  }

  // #2397 — the outstanding upward-modification delta, and the admin's answer
  // about it.
  //
  // The MONEY half of the shared owed test is enough here: this settle always
  // lands the booking on PAID, which is inside the owed status list, so the
  // status half is constant-true by construction (see the merge-point note on
  // `isAdditionalAmountUncollected`). Whatever the answer, the chase that #2386
  // adds and every admin surface read the same two columns, so agreeing with
  // them is a matter of writing those columns, not of inventing a parallel
  // "manually settled extra" state.
  const outstandingAdditionalCents = isAdditionalAmountUncollected(payment)
    ? payment.additionalAmountCents
    : 0;
  const coverage = settlement.additionalCoverage;

  if (outstandingAdditionalCents === 0 && coverage !== null) {
    throw new ManualBookingPaymentError(
      "The extra owing on this booking was settled or removed while you were recording this payment — refresh and check the figures before recording it.",
      409
    );
  }
  if (outstandingAdditionalCents > 0 && coverage === null) {
    throw new ManualBookingPaymentError(
      "This booking has an extra owing that was not on your screen — refresh and say whether the cash covers it before recording this payment.",
      409
    );
  }
  if (
    coverage !== null &&
    coverage.expectedAdditionalAmountCents !== outstandingAdditionalCents
  ) {
    throw new ManualBookingPaymentError(
      "The extra owing changed while you were recording this payment — refresh and check the figure before recording it.",
      409
    );
  }

  // The extra is a SLICE of the amount owing, never a sum on top of it: an
  // upward modification raises `Booking.finalPriceCents` by the same delta it
  // records on the payment, and this settle collects `finalPriceCents - credit`
  // in one go. An extra LARGER than the whole amount owing therefore cannot be
  // a slice of it (a modification change fee is added to the recorded extra but
  // never to `finalPriceCents`, so this is reachable) — refuse rather than guess
  // which part of it the cash covered. Checked for BOTH answers, because both
  // now derive their settled figure from the same subtraction.
  //
  // #2397 F5: the remedy named here has to be one that EXISTS. There is no
  // "settle the extra separately" door for an admin — the only two things that
  // actually work are the member paying the extra on their own booking page
  // (the card the addition minted, which this settle deliberately leaves live
  // when it is not covered — see `enqueueManualSettlementIntentCancellations`),
  // or an admin correcting the booking's price so the extra is a slice of it
  // again.
  if (outstandingAdditionalCents > effectiveAmountCents) {
    throw new ManualBookingPaymentError(
      "The extra recorded on this booking is larger than the amount owing, so this payment cannot settle it. Ask the member to pay the extra from their booking page, or correct the booking's price, then record this payment.",
      409
    );
  }

  const additionalSettlementCents =
    coverage !== null && coverage.covered ? outstandingAdditionalCents : 0;
  const uncollectedAdditionalCents =
    outstandingAdditionalCents - additionalSettlementCents;

  // THE SETTLED FIGURE (owner decision, 31 Jul 2026). The club records what it
  // actually took, not what the booking is worth:
  //
  //  * covered   — the cash was the whole amount owing, so the settled figure is
  //    `finalPriceCents - credit` and the extra is a slice of it (the PRIMARY
  //    transaction drops by the delta, the ADDITIONAL transaction carries it);
  //  * NOT covered — only the amount owing BEFORE the change was handed over, so
  //    the extra is subtracted from the settled figure. It stays outstanding and
  //    is still chased, and the books say $100 received / $21 owing rather than
  //    $121 received / $21 owing, which was the old contradiction.
  //
  // The PRIMARY transaction is the same figure either way; the only difference
  // is whether an ADDITIONAL row exists alongside it saying the delta was
  // collected too.
  const settlementAmountCents = effectiveAmountCents - uncollectedAdditionalCents;

  if (settlementAmountCents <= 0) {
    // Everything owing IS the extra, and the admin has said the cash did not
    // cover it — so there is nothing to record. Refusing beats writing a $0
    // settlement that would flip the booking to PAID for no money.
    throw new ManualBookingPaymentError(
      "Everything owing on this booking is the extra you have said the cash does not cover, so there is nothing to record. Ask the member to pay it from their booking page, or record this payment once the cash covers it.",
      409
    );
  }

  // THE GENERALISED LEDGER MIRROR. `amountCents + creditAppliedCents =
  // finalPriceCents` was only ever the special case where nothing is left owing;
  // it CANNOT hold on a partially settled booking, and asserting it would forbid
  // the honest "no" answer outright. What holds in every case — and what already
  // held for a CARD-settled booking carrying an uncollected addition, so this
  // makes the manual path match the card path rather than diverging from it — is
  //
  //     amountCents + creditAppliedCents + (uncollected addition) = finalPriceCents
  //
  // i.e. every cent of the booking's price is either collected, paid with
  // credit, or still owed. The covered answer leaves the third term at 0 and
  // reduces to the original mirror exactly.
  //
  // #2397 F6 — and it is deliberately NOT asserted here, because it CANNOT be.
  // At this point `settlementAmountCents` is DEFINED as `effectiveAmountCents -
  // uncollectedAdditionalCents`, and `effectiveAmountCents + creditAppliedCents
  // === finalPriceCents` was already asserted a few lines above, so the identity
  // reduces to `finalPrice === finalPrice`: a tautology in these locals that
  // could never fire. Nor would re-reading the values after the writes help —
  // inside this one transaction the re-read can only return what these same
  // locals just wrote.
  //
  // What actually enforces the mirror at runtime, in order:
  //  1. CONSTRUCTION. The primary and additional ledger rows are a SPLIT of one
  //     figure (`manualPrimaryTransactionAmountCents +
  //     additionalSettlementCents = settlementAmountCents`), and that same
  //     figure is what `Payment.amountCents` is set to — so the reconciler's
  //     own derivation (sum of captured rows) reproduces it rather than
  //     inflating it.
  //  2. THE FENCE. The fenced `payment.updateMany` below re-asserts the
  //     outstanding delta, the settle-from status, the zero refund history and
  //     the absence of Xero evidence as WHERE clauses, so a concurrent writer
  //     that moved any of them yields count 0 -> 409 instead of a write whose
  //     third term is stale. That is the real runtime net.
  //  3. AFTER THE FACT, AND ONLY NARROWLY. `auditIbAppliedCreditStrands`
  //     (src/lib/ib-hold-clearing-audit.ts) recomputes
  //     `amountCents + creditAppliedCents - finalPriceCents` over COMMITTED
  //     data and now reports the uncollected addition beside it, so where it
  //     DOES report, a residual that is not exactly the uncollected delta is
  //     visible to an operator. It is the only one of the three that can fire
  //     at all, because it is not reading back its own writes.
  //
  //     It is NOT a general after-the-fact net for this settle, and nothing
  //     later should be built on the assumption that it is. Its enumeration is
  //     narrow on three counts:
  //       * it reports a payment only when that booking still carries
  //         UN-ALLOCATED applied credit — `deriveIbAppliedCreditStrandFinding`
  //         returns null on `ledgerAppliedCents <= 0`, and the ledger sum counts
  //         BOOKING_APPLIED rows with `xeroCreditNoteId: null` only. An ordinary
  //         "not covered" cash settlement on a booking with no applied credit
  //         therefore produces NO finding, and its residual is never printed;
  //       * it scans INTERNET_BANKING payments only; and
  //       * it is an operator-run script (scripts/audit-ib-hold-clearing.ts),
  //         not a scheduled job or an alert — nothing fires unless somebody runs
  //         it and reads the output.
  //     So (1) and (2) are what actually keep this settle honest; (3) is a
  //     reading aid for the credit-strand population it already enumerates.

  return {
    /** `finalPriceCents - credit`: everything the booking still owes. */
    amountOwingCents: effectiveAmountCents,
    /** What this settlement records as RECEIVED — the figure that is written. */
    settlementAmountCents,
    creditAppliedCents,
    paymentId: payment?.id ?? null,
    outstandingAdditionalCents,
    additionalSettlementCents,
    uncollectedAdditionalCents,
    previousAdditionalPaymentStatus: payment?.additionalPaymentStatus ?? null,
    /**
     * #2397 F4: the live card instrument for the outstanding extra, if the
     * member has one. When the cash does NOT cover the extra this intent is
     * deliberately spared the settlement's intent cancellation, because it is
     * the only self-service door left to the money the club is still owed.
     */
    additionalPaymentIntentId: payment?.additionalPaymentIntentId ?? null,
  };
}

/**
 * B5 (#2262) Stripe-intent hygiene for a manual settlement. Any Stripe intent
 * on this payment that has NOT reached a terminal state is still capable of
 * capturing — the member's `/pay` tab may hold a live client secret — so a
 * durable CANCEL_PAYMENT_INTENT recovery operation is enqueued for each,
 * ATOMICALLY with the settlement and BEFORE any Stripe call. The best-effort
 * Stripe cancel itself runs after commit, never inside this transaction.
 *
 * Returns the intent ids so the caller can attempt the cancel, and so the
 * reversal can name exactly what it disarmed.
 *
 * #2397 F4 — `spareAdditionalPaymentIntentId`. The blanket cancel was right
 * while a manual settlement ALWAYS recorded the whole amount owing: every live
 * intent, primary or additional, was then a door to a second payment for money
 * the club already held. The "the cash did not cover the extra" answer breaks
 * that assumption for exactly one intent — the addition's own — because that
 * extra is deliberately still owed, and this intent is the ONLY self-service
 * instrument for it (`/api/bookings/[id]/additional-payment-secret` hands back
 * precisely `Payment.additionalPaymentIntentId`, and the member's booking page
 * renders the pay card off `additionalAmountCents` + a non-SUCCEEDED
 * `additionalPaymentStatus`; neither gates on booking status, so both keep
 * working on the now-PAID booking).
 *
 * Cancelling it left the club chasing money the member had no way to send —
 * the worst available outcome. Sparing it is also ledger-correct: capturing it
 * routes through `markPaymentIntentTransactionSucceeded` ->
 * `reconcilePaymentAggregates`, which sums the captured rows, so
 * `Payment.amountCents` becomes cash + addition = `finalPriceCents` and the
 * generalised mirror closes with a zero third term.
 *
 * ONE intent is spared, by id, never "all ADDITIONAL rows": a superseded
 * addition intent is a stale door to a figure nobody is owed any more, and
 * `additionalPaymentIntentId` is the single pointer every consumer honours.
 */
async function enqueueManualSettlementIntentCancellations(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    paymentId,
    spareAdditionalPaymentIntentId = null,
  }: {
    bookingId: string;
    paymentId: string;
    spareAdditionalPaymentIntentId?: string | null;
  }
): Promise<{ cancelledIntentIds: string[]; sparedIntentId: string | null }> {
  const liveTransactions = await tx.paymentTransaction.findMany({
    where: {
      paymentId,
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: { not: null },
      // Non-terminal only. A SUCCEEDED row is money already in the ledger (and
      // the duplicate-capture machinery's business), and FAILED/REFUNDED rows
      // have nothing left to cancel.
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
    },
    select: {
      id: true,
      kind: true,
      stripePaymentIntentId: true,
      amountCents: true,
    },
  });

  const cancelledIntentIds: string[] = [];
  let sparedIntentId: string | null = null;
  for (const transaction of liveTransactions) {
    if (!transaction.stripePaymentIntentId) continue;
    // Both halves are required: the id must be the payment's CURRENT addition
    // pointer AND the row must actually be an ADDITIONAL one, so a mismatched
    // pointer can never spare a live primary intent.
    if (
      spareAdditionalPaymentIntentId !== null &&
      transaction.kind === PaymentTransactionKind.ADDITIONAL &&
      transaction.stripePaymentIntentId === spareAdditionalPaymentIntentId
    ) {
      sparedIntentId = transaction.stripePaymentIntentId;
      continue;
    }
    await enqueuePaymentIntentCancellationRecovery({
      bookingId,
      paymentId,
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
      store: tx,
    });
    cancelledIntentIds.push(transaction.stripePaymentIntentId);
  }
  return { cancelledIntentIds, sparedIntentId };
}

/**
 * The ONE booking-settlement body (#2262 guard 1). Both the Stripe capture and
 * the admin's manual cash settlement execute it, so the lock ordering, the
 * post-lock re-read, the capacity check with its #1771 override carve-out, the
 * status-fenced PAID claim and the bed reconciliation are literally the same
 * lines for both — there is no sibling path that can drift.
 *
 * Runs INSIDE a caller-provided transaction; every provider call (Stripe
 * refunds/cancels, email) belongs to the callers, after commit.
 */
async function settleBookingPaymentInTransaction(
  tx: Prisma.TransactionClient,
  bookingId: string,
  settlement: BookingSettlementSource
) {
    // Two-tier lock protocol (#1881). A Stripe capture does BOTH tiers of work:
    // it flips the booking's status + moves money (the booking-status/money
    // tier), AND it claims capacity (the per-lodge tier). It must therefore
    // hold BOTH locks, and the global lock(1) is taken FIRST — always
    // global-before-per-lodge, so the ordering is deadlock-free against every
    // other two-lock writer (invoice-paid-effects, confirm-pending-guests).
    // Without lock(1) this capture no longer mutually excluded the cancel /
    // hold-release / settlement paths (which serialise on lock(1)); a concurrent
    // cancel could interleave and the bare PAID write below could resurrect a
    // just-cancelled booking. The per-lodge lock still serialises the capacity
    // claim against per-lodge creators.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    // Pre-lock read: only the lodge lock key. lodgeId is immutable, so keying
    // the per-lodge lock from this read is safe; every status/capacity-relevant
    // field is taken from the post-lock re-read below.
    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });

    if (!lockTarget) {
      throw new Error("Booking not found");
    }

    const bookingLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read the full booking under the lock; the status/amount checks, the
    // capacity check and the PAID/CANCELLED claim below consume ONLY this
    // post-lock snapshot.
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        guests: { include: { nights: true } }, // per-night sets (issue #713)
        member: true,
      },
    });

    if (!booking) {
      throw new Error("Booking not found");
    }

    // B5 (#2262): the manual path's third lock tier, every guard-2 refusal and
    // the amount law, all decided from this same post-lock snapshot and all
    // BEFORE the first write below.
    const manual =
      settlement.kind === "manual"
        ? await prepareManualSettlement(tx, booking, settlement)
        : null;

    // The amount this settlement moves. The Stripe path takes the captured
    // amount as given (and validates it against the booking below); the manual
    // path recomputed it under the locks and never accepts one from a client.
    // #2397: for the manual path this is what the club actually RECEIVED, which
    // is the amount owing minus any extra the admin said the cash did not cover
    // — never the booking's whole worth when only part of it was handed over.
    const settlementAmountCents =
      manual !== null
        ? manual.settlementAmountCents
        : (settlement as StripeSettlementSource).amountCents;

    // #1641 — split the captured amount into cash + credit so the mirror invariant
    // `amountCents + creditAppliedCents = finalPriceCents` holds for BOTH a new
    // effective capture (credit = applied) and a legacy full-price capture
    // (credit = 0, repaired locally by the audit — never a Xero over-allocation).
    // This is derived from the captured amount alone; the ledger is only read below
    // when the amount is NOT the full price (to admit the effective capture).
    // The manual path already derived both halves under the MEMBER-CREDIT lock.
    const mirrorCreditAppliedCents =
      manual !== null
        ? manual.creditAppliedCents
        : Math.max(0, booking.finalPriceCents - settlementAmountCents);

    // #2397 — the slice of this settlement that pays off the outstanding
    // upward-modification delta, when the admin said the cash covers it. Zero
    // on every other settlement, which is every settlement today.
    const manualAdditionalSettlementCents = manual?.additionalSettlementCents ?? 0;
    const manualOutstandingAdditionalCents =
      manual?.outstandingAdditionalCents ?? 0;
    const manualUncollectedAdditionalCents =
      manual?.uncollectedAdditionalCents ?? 0;
    const manualAmountOwingCents =
      manual?.amountOwingCents ?? settlementAmountCents;
    const manualPreviousAdditionalPaymentStatus =
      manual?.previousAdditionalPaymentStatus ?? null;
    // The cash is SPLIT, never increased: the additional transaction carries the
    // delta and the primary carries the rest, so the two rows sum to
    // `settlementAmountCents` = `Payment.amountCents` — the money the club
    // actually took. This is exactly the shape a card-paid booking with a later
    // addition has, so `reconcilePaymentAggregates` re-deriving the payment from
    // its ledger reproduces these figures instead of inflating them.
    //
    // The PRIMARY figure is deliberately the SAME under both answers — the
    // booking's worth before the change. "Covered" adds an ADDITIONAL row beside
    // it; "not covered" leaves the delta uncollected and out of the settled
    // total. That is why one subtraction serves both, and why the answer can
    // never change what the primary row says was received.
    const manualPrimaryTransactionAmountCents =
      settlementAmountCents - manualAdditionalSettlementCents;

    const payment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents: settlementAmountCents,
        creditAppliedCents: mirrorCreditAppliedCents,
        status: PaymentStatus.PENDING,
      },
      update: {},
    });

    let refundedIntentHistory = false;

    if (settlement.kind === "stripe") {
      // #1765 — refund history is immutable: an intent whose transaction was
      // refunded (fully or partially) must never be re-admitted as settlement,
      // whichever path (intent-route recovery, confirm-payment, webhook
      // redelivery, payment link) carries the succeeded intent back here.
      // Without this guard a redelivered success event for a refunded intent
      // would clobber the transaction row back to SUCCEEDED and, when the
      // booking price never changed, settle the booking at zero net cash. The
      // lookup backfills pre-ledger payments so legacy refund history is caught
      // too. Crashed-webhook recovery is untouched: its transaction is still
      // PENDING/PROCESSING (success was never recorded locally).
      const priorTransaction = await findPaymentTransactionByIntentId({
        paymentIntentId: settlement.paymentIntentId,
        store: tx,
      });
      refundedIntentHistory =
        priorTransaction !== null &&
        (priorTransaction.status === PaymentStatus.REFUNDED ||
          priorTransaction.status === PaymentStatus.PARTIALLY_REFUNDED);

      if (!refundedIntentHistory) {
        await upsertPaymentIntentTransaction({
          paymentId: payment.id,
          kind: PaymentTransactionKind.PRIMARY,
          paymentIntentId: settlement.paymentIntentId,
          amountCents: settlement.amountCents,
          status: PaymentStatus.SUCCEEDED,
          paymentMethodId: settlement.paymentMethodId,
          store: tx,
        });
      }
    } else {
      // B5 (#2262) manual transaction mint. Shaped after the inbound-Xero mint
      // (an INTERNET_BANKING PRIMARY row, no Stripe intent id) minus the
      // invoice stamping, because this settlement has no invoice by definition.
      //
      // DELIBERATE DIVERGENCE 1 — FAILED rows are excluded from the update
      // predicate, where the inbound mint excludes only REFUNDED /
      // PARTIALLY_REFUNDED. A reversal marks this feature's manual row FAILED at
      // the old amount; resurrecting it would settle the booking at a stale
      // figure. Do not "restore" the inbound predicate here.
      //
      // DELIBERATE DIVERGENCE 2 — on count 0 this CREATES UNCONDITIONALLY. The
      // inbound mint first looks for ANY existing IB PRIMARY row and only
      // creates when none exists; copied here that fallback would find the
      // reversal's FAILED row and mint nothing, leaving a PAID payment with no
      // settled transaction. Refund history on the payment is left untouched
      // (#1765 / #1357 raise-only spirit).
      const mintedUpdate = await tx.paymentTransaction.updateMany({
        where: {
          paymentId: payment.id,
          source: PaymentSource.INTERNET_BANKING,
          kind: PaymentTransactionKind.PRIMARY,
          status: {
            notIn: [
              PaymentStatus.REFUNDED,
              PaymentStatus.PARTIALLY_REFUNDED,
              PaymentStatus.FAILED,
            ],
          },
        },
        data: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: manualPrimaryTransactionAmountCents,
          reason: "manual_mark_paid",
        },
      });

      if (mintedUpdate.count === 0) {
        await tx.paymentTransaction.create({
          data: {
            paymentId: payment.id,
            kind: PaymentTransactionKind.PRIMARY,
            source: PaymentSource.INTERNET_BANKING,
            stripePaymentIntentId: null,
            amountCents: manualPrimaryTransactionAmountCents,
            status: PaymentStatus.SUCCEEDED,
            reason: "manual_mark_paid",
          },
        });
      }

      // #2397 — the ADDITIONAL half, minted the same way and only when the
      // admin said this cash covers the outstanding extra. Same two deliberate
      // divergences as the PRIMARY mint above, for the same reasons: FAILED
      // rows are excluded from the update predicate (a reversal marks this
      // feature's own row FAILED at the old amount, and resurrecting it would
      // settle the extra at a stale figure), and count 0 CREATES
      // unconditionally rather than falling back to "any existing ADDITIONAL
      // row" — a fallback would adopt the member's stale, still-PENDING STRIPE
      // additional intent row and claim a card capture that never happened.
      //
      // A durable row rather than only the summary column, because
      // `reconcilePaymentAggregates` re-derives `additionalAmountCents` /
      // `additionalPaymentStatus` from the LATEST ADDITIONAL transaction: a
      // column-only write would be silently undone by the next ledger
      // reconcile and the member would start being chased again for cash the
      // club already holds.
      if (manualAdditionalSettlementCents > 0) {
        const mintedAdditional = await tx.paymentTransaction.updateMany({
          where: {
            paymentId: payment.id,
            source: PaymentSource.INTERNET_BANKING,
            kind: PaymentTransactionKind.ADDITIONAL,
            status: {
              notIn: [
                PaymentStatus.REFUNDED,
                PaymentStatus.PARTIALLY_REFUNDED,
                PaymentStatus.FAILED,
              ],
            },
          },
          data: {
            status: PaymentStatus.SUCCEEDED,
            amountCents: manualAdditionalSettlementCents,
            reason: MANUAL_MARK_PAID_ADDITIONAL_REASON,
          },
        });

        if (mintedAdditional.count === 0) {
          await tx.paymentTransaction.create({
            data: {
              paymentId: payment.id,
              kind: PaymentTransactionKind.ADDITIONAL,
              source: PaymentSource.INTERNET_BANKING,
              stripePaymentIntentId: null,
              amountCents: manualAdditionalSettlementCents,
              status: PaymentStatus.SUCCEEDED,
              reason: MANUAL_MARK_PAID_ADDITIONAL_REASON,
            },
          });
        }
      }
    }

    if (booking.status === BookingStatus.PAID) {
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      // #1992 — duplicate-capture detection. `already_paid` is the normal
      // exactly-once replay outcome for a success that carries the SAME intent
      // the booking settled with (webhook redelivery, the confirm-payment
      // route racing the webhook, payment-link reconcile, charge-saved-method
      // and cron-confirm-pending reruns replaying their `pending_charge_`
      // Stripe idempotency key, confirm-pending-guests retries). But a
      // DIFFERENT intent capturing against an already-PAID booking is double
      // money: the residual #1967 split-child window, where the /pay link
      // intent (client secret already in the member's browser) and the
      // settlement cron's saved-card charge both capture. Refund the arriving
      // duplicate automatically instead of stranding it behind a manual
      // reconcile. The refund debt is enqueued here, ATOMIC with this
      // transaction and BEFORE any Stripe call (the #1349 pattern); the Stripe
      // refund itself executes after commit, below.
      //
      // Distinctness predicate — refund the arriving intent ONLY when all of:
      //   (a) the arriving intent has no refund history (#1765 guard above —
      //       an already-(partly-)refunded replay stays plain already_paid);
      //   (b) ANOTHER captured PRIMARY transaction with net cash (SUCCEEDED or
      //       PARTIALLY_REFUNDED — deliberately NOT fully REFUNDED, so a #1765
      //       repay-generation replay arriving alongside its refunded
      //       predecessor is never treated as a duplicate) exists on this
      //       payment: either a STRIPE row under a different intent id, or —
      //       since #2262 guard 3 — ANY non-Stripe settled PRIMARY row. A cash
      //       settlement recorded by an admin, and a Xero-inbound internet
      //       banking settlement, are both real money already collected; a
      //       later stray Stripe capture on top of either is double money, and
      //       before the widening it fell through to plain `already_paid` and
      //       was silently kept. The non-Stripe arm carries no arriving-row
      //       exclusion and does not need one: upsertPaymentIntentTransaction
      //       hardcodes source STRIPE on both its create and update arms, so
      //       the row this settlement just wrote can never match it (pinned by
      //       a test, so a future "derive the source from the payment" refactor
      //       fails loudly instead of making a capture refund itself);
      //   (b′) that other capture's money is NOT already owned by the
      //       superseded-intent machinery (a live CANCEL_PAYMENT_INTENT /
      //       REFUND_SUPERSEDED_PAYMENT recovery operation — see
      //       SUPERSEDED_INTENT_OPERATION_TYPES). The handoff of a superseded
      //       intent's late capture sets it SUCCEEDED with a queued refund
      //       WITHOUT ever passing through this function, so from the ledger
      //       alone it is indistinguishable from a settlement; refunding the
      //       arriving capture against it would refund the REAL settlement
      //       while the cron refunds the superseded one — zero net cash;
      //   (c) no duplicate-capture refund has already been adjudicated for
      //       this booking against a DIFFERENT intent. Without (c), webhook
      //       replays of BOTH captures would refund both sides (Y settles, X
      //       arrives → refund X; Y's redelivery then sees X SUCCEEDED-and-
      //       different → refund Y too) and settle the booking at zero net
      //       cash. lock(1), held by every caller of this function, serialises
      //       the check-then-enqueue, so exactly one side of the pair can ever
      //       open a refund operation;
      //   (c′) belt-and-braces re-check of (b′) against the matched candidate
      //       directly (different query shape) — if a live superseded-intent
      //       operation owns the candidate's money, the arriving capture is
      //       the settlement side and stays plain already_paid.
      // All of these run inside the same lock(1) transaction.
      if (!refundedIntentHistory && settlement.kind === "stripe") {
        const { paymentIntentId, amountCents } = settlement;
        const liveSupersededIntentIds = await listLiveSupersededIntentIds(
          tx,
          payment.id
        );
        const otherSettledCapture = await tx.paymentTransaction.findFirst({
          where: {
            paymentId: payment.id,
            kind: PaymentTransactionKind.PRIMARY,
            status: {
              in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
            },
            OR: [
              {
                source: PaymentSource.STRIPE,
                stripePaymentIntentId: {
                  not: paymentIntentId,
                  notIn: liveSupersededIntentIds,
                },
                NOT: { stripePaymentIntentId: null },
              },
              { source: { not: PaymentSource.STRIPE } },
            ],
          },
          select: { id: true, stripePaymentIntentId: true },
        });

        if (otherSettledCapture) {
          const adjudicatedElsewhere =
            await findOtherDuplicateCaptureRefundOperation({
              bookingId: booking.id,
              paymentIntentId,
              store: tx,
            });

          // (c′) — the candidate's own intent id re-checked against the live
          // superseded-machinery operations. Skipped when (c) already settled
          // the adjudication.
          const supersededOwnsOtherCapture =
            adjudicatedElsewhere || !otherSettledCapture.stripePaymentIntentId
              ? null
              : await findLiveSupersededIntentOperation(
                  tx,
                  otherSettledCapture.stripePaymentIntentId
                );

          // Re-read the arriving duplicate's row AFTER the upsert above so the
          // frozen refund slice targets exactly this capture's transaction and
          // its outstanding captured amount — never a newest-first allocation
          // that could touch the settlement capture.
          const duplicateTransaction =
            adjudicatedElsewhere || supersededOwnsOtherCapture
              ? null
              : await findPaymentTransactionByIntentId({
                  paymentIntentId,
                  store: tx,
                });
          const duplicateRefundCents = duplicateTransaction
            ? Math.min(
                amountCents,
                duplicateTransaction.amountCents -
                  duplicateTransaction.refundedAmountCents
              )
            : 0;

          if (duplicateTransaction && duplicateRefundCents > 0) {
            const refundPlan = [
              {
                paymentTransactionId: duplicateTransaction.id,
                amountCents: duplicateRefundCents,
              },
            ];
            await enqueueDuplicateCaptureRefundRecovery({
              bookingId: booking.id,
              paymentId: payment.id,
              paymentIntentId,
              amountCents: duplicateRefundCents,
              allocationPlan: refundPlan,
              store: tx,
            });

            return {
              outcome: "duplicate_capture" as const,
              booking,
              paymentId: payment.id,
              bumpedBookingIds: [] as string[],
              refundPlan,
              plannedRefundCents: duplicateRefundCents,
              settledPaymentIntentId: otherSettledCapture.stripePaymentIntentId,
            };
          }
        }
      }

      // A refunded-history redelivery on an already-PAID booking (e.g. a
      // Stripe event replay after a partial goodwill refund) stays benign —
      // and, with the guard above, no longer clobbers the refund marker.
      return {
        outcome: "already_paid" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
      };
    }

    if (refundedIntentHistory) {
      // #1765 — the booking is not settled and the carried intent's money was
      // handed back. Re-admitting it would settle the booking at zero net
      // cash; the member owes a fresh payment (the create-payment-intent
      // route mints the repay intent at the current effective price).
      throw new Error(
        "Refunded payment intent cannot be re-admitted as settlement; the booking needs a fresh payment (#1765)"
      );
    }

    if (!PAYABLE_SUCCESS_STATUSES.has(booking.status)) {
      throw new Error(`Booking is not payable from status ${booking.status}`);
    }

    // #1641 — accept EITHER the credit-reduced effective price (new intents) OR
    // the full finalPriceCents (legacy in-flight intents minted before the fix).
    // A wrong-amount capture (e.g. a stale intent from a since-changed price, #1161)
    // equals neither and is still rejected. Full price is always a legitimate
    // settlement of a full-price booking's invoice, so admitting it can never
    // under-charge the member; new bookings never mint a full-price intent, so the
    // leniency does not re-open the double-charge. The ledger read is skipped
    // entirely for a full-price capture.
    //
    // The manual path has no arriving amount to validate: it DERIVED the
    // effective price under the MEMBER-CREDIT lock in prepareManualSettlement,
    // asserted the mirror there, and refused a figure that had moved since the
    // admin's dialog rendered.
    if (
      settlement.kind === "stripe" &&
      settlement.amountCents !== booking.finalPriceCents
    ) {
      const appliedCreditCents = await deriveBookingAppliedCreditCents(
        booking.id,
        tx
      );
      if (settlement.amountCents !== booking.finalPriceCents - appliedCreditCents) {
        throw new Error("Payment amount does not match booking total");
      }
    }

    const capacity = await checkCapacityForGuestRanges(
      bookingLodgeId,
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      booking.id,
      tx
    );

    // Since #737/#738 a PENDING booking holds no capacity, so there is no
    // synchronous bump that could free a real bed. An all-member booking that
    // does not fit against committed bookings is cancelled-and-refunded here,
    // never bumped into a full lodge (issue #738, carried over from R1). The
    // non-member portion of a mixed party is now its own provisional booking.
    if (!capacity.available && bookingHasCapacityOverride(booking)) {
      // Persisted capacity override (#1771): this booking was deliberately
      // admitted above the ceiling by an admin. Settle it instead of cancelling
      // — fall through to the PAID update below.
      //
      // Whole-lodge hold (ADR-001, issue #118) is DELIBERATELY not enforced on
      // this settle path (and the other persisted-override settlements: cron-
      // confirm-pending, switch-to-internet-banking, charge-saved-method,
      // payment-link, xero-inbound invoice-paid-effects, group-settlement).
      // Those settle a PRE-EXISTING overridden booking; a hold may have been
      // placed over it AFTERWARDS. Per ADR-001 decision 1 (conflicts are
      // allowed, surfaced, and manually resolved — no auto-displacement/refusal)
      // an already-admitted booking is not a "new admission", so auto-refusing
      // it here would contradict decision 1. The hold blocks only NEW admissions
      // (decision 5), enforced at the admission choke points (booking-create,
      // date/modify-plan, and the admin allowOverbook routes force-confirm /
      // confirm-pending-guests / capacity-hold).
      logger.info(
        { bookingId: booking.id },
        "Settling an over-capacity booking with a persisted capacity override (#1771); skipping the capacity cancel"
      );
    }
    if (
      !capacity.available &&
      !bookingHasCapacityOverride(booking) &&
      settlement.kind === "manual"
    ) {
      // B5 (#2262), owner-decided 28 Jul: REFUSE, do not mirror the Stripe
      // path's cancel-and-refund. No in-system money fact exists yet — the
      // transaction throws, nothing is written, and the admin still holds the
      // cash — so refusal leaves zero debt, where a cancel-and-refund would
      // record a cancellation and then reach for Stripe machinery that cannot
      // hand back banknotes. The INVARIANT is unchanged: the same capacity
      // check runs at the same point under the same locks, so an unpaid-for
      // bed can never be admitted into a full or exclusively held lodge.
      throw new ManualBookingPaymentError(
        "This booking no longer fits the lodge — nothing was recorded; resolve capacity (or cancel the booking) before recording the payment.",
        409
      );
    }
    if (
      !capacity.available &&
      !bookingHasCapacityOverride(booking) &&
      settlement.kind === "stripe"
    ) {
      const { paymentIntentId, amountCents } = settlement;
      // Status-guarded void (#1881, defense in depth): claim the cancel only
      // while the booking is still in a payable state. Under lock(1) the
      // post-lock re-read already established that, so count 0 is a "cannot
      // happen" — but guarding the write means a concurrent status transition
      // that somehow slipped the lock can never be clobbered back to CANCELLED.
      const voided = await tx.booking.updateMany({
        where: { id: booking.id, status: { in: [...PAYABLE_SUCCESS_STATUS_LIST] } },
        data: {
          status: BookingStatus.CANCELLED,
          draftExpiresAt: null,
          ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
          // Best-effort field clearing (#177): this settlement capacity-cancel
          // has no per-booking audit context, so it mirrors the capacity-hold
          // sibling — clear the stale hold, no released audit. NB this is the
          // NON-override branch; the documented decision-1 carve-out settlement
          // (the override branch above) is untouched.
          ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
        },
      });
      if (voided.count === 0) {
        throw new Error(
          "Booking status changed concurrently during the capacity-failed void (#1881)"
        );
      }
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      await restoreCreditFromBooking(booking.memberId, booking.id, tx);

      // Durable refund debt, ATOMIC with the cancel claim (mirrors the #1349
      // enqueue-then-execute pattern in booking-cancel): freeze the refund
      // allocation from this locked read and persist the recovery operation
      // BEFORE any Stripe call. A transient inline refund failure below — or
      // a process death between this commit and the refund — now leaves a
      // PENDING operation the recovery cron replays with backoff, instead of
      // the member's full charge stranded on a CANCELLED booking with only a
      // best-effort alert email as remediation. The frozen plan makes
      // inline-vs-cron replay exactly-once: both execute identical slices, so
      // both mint identical `capacity_claim_failed_<bookingId>_<pi>_<txn>_
      // <amount>` Stripe keys, Stripe answers repeats with the original
      // refunds, and the ledger dedupes on refund id.
      const { slices: refundPlan, plannedAmountCents: plannedRefundCents } =
        await planStripeRefundAllocation({
          paymentId: payment.id,
          amountCents,
          store: tx,
        });
      if (plannedRefundCents > 0) {
        await enqueueCapacityClaimFailedRefundRecovery({
          bookingId: booking.id,
          paymentId: payment.id,
          paymentIntentId,
          amountCents: plannedRefundCents,
          allocationPlan: refundPlan,
          store: tx,
        });
      }

      return {
        outcome: "capacity_failed" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
        refundPlan,
        plannedRefundCents,
      };
    }

    // B5 (#2262) — the manual settlement's own claim, and the analogue of the
    // subscription fence. Every guard-2 refusal condition that CAN be expressed
    // as a WHERE is re-asserted here, so an invoice minted (or a group
    // settlement flipped) between the read above and this write yields count 0
    // -> 409 rather than a double-apply. One clock read is shared by the
    // provenance columns, the audit row and the member's receipt.
    const manualSettledAt = new Date();
    if (settlement.kind === "manual") {
      const fenced = await tx.payment.updateMany({
        where: {
          id: payment.id,
          xeroInvoiceId: null,
          xeroRefundCreditNoteId: null,
          manuallyMarkedPaidAt: null,
          // M6 (#2262): the settled-FROM statuses, matching STATE_MACHINES.md
          // — the SAME list the read-time refusal above uses, so the two can
          // never drift (#2397).
          status: { in: [...MANUAL_SETTLE_FROM_PAYMENT_STATUS_LIST] },
          // L7: no refund history (re-asserting the read-time refusal).
          refundedAmountCents: 0,
          transactions: { none: { xeroInvoiceId: { not: null } } },
          booking: { organiserSettled: false },
          // #2397: re-assert the extra this settle reasoned about, exactly as
          // every other expressible refusal is re-asserted here. A card
          // additional that captured — or another delta recorded — between the
          // read above and this write yields count 0 -> 409, so the settle can
          // never stamp SUCCEEDED over a figure that has moved.
          //
          // #2397 F2: keyed on the OUTSTANDING delta, not on the SETTLED one,
          // so BOTH answers are fenced. The not-covered answer needs this at
          // least as much as the covered one: it derives the figure it records
          // (`amountOwing - uncollected`) from that same delta, and the
          // additional-capture writer takes no advisory lock (the confirm route
          // and the Stripe webhook both go straight to
          // `markPaymentIntentTransactionSucceeded`). Under read-committed a
          // capture landing between the read above and this write would
          // otherwise leave the club holding cash + card while `amountCents`
          // recorded only the cash — the delta UNDER-recorded, which is the
          // exact inverse of the rule this feature exists to enforce.
          ...(manualOutstandingAdditionalCents > 0
            ? {
                additionalAmountCents: manualOutstandingAdditionalCents,
                OR: [
                  { additionalPaymentStatus: null },
                  { additionalPaymentStatus: { not: "SUCCEEDED" } },
                ],
              }
            : {}),
        },
        data: {
          status: PaymentStatus.SUCCEEDED,
          // Guard 4: no new PaymentSource member. A manual settlement IS an
          // internet-banking payment as far as every two-way branch in the
          // codebase is concerned (refund method coercion, refund planning,
          // the reconciler); its manual-ness lives in the provenance columns.
          source: PaymentSource.INTERNET_BANKING,
          amountCents: settlementAmountCents,
          creditAppliedCents: mirrorCreditAppliedCents,
          manuallyMarkedPaidAt: manualSettledAt,
          manuallyMarkedPaidByMemberId: settlement.actingAdminMemberId,
          manualPaymentNote: settlement.note,
          manuallyMarkedPaidPreviousStatus: booking.status,
          // #2397: the one state every consumer already treats as settled —
          // the admin list chip, the booking panel, the reports figure, the
          // finance breakdown, the member's own pay door and the reminder cron
          // all key on this column being "SUCCEEDED".
          ...(manualAdditionalSettlementCents > 0
            ? { additionalPaymentStatus: "SUCCEEDED" }
            : {}),
        },
      });
      if (fenced.count === 0) {
        throw new ManualBookingPaymentError(
          "This booking's payment changed while you were recording it — refresh and try again.",
          409
        );
      }
    }

    // Status-guarded PAID claim (#1881, defense in depth alongside lock(1)):
    // only settle a still-payable booking. Under lock(1) count 0 cannot happen
    // (the re-read above already gated on this), but the guard means a cancel
    // that somehow raced past the lock cannot be resurrected to PAID.
    const claimed = await tx.booking.updateMany({
      where: { id: booking.id, status: { in: [...PAYABLE_SUCCESS_STATUS_LIST] } },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
    if (claimed.count === 0) {
      throw new Error(
        "Booking status changed concurrently during the PAID claim (#1881)"
      );
    }

    // #2265 (#2319; #2262 door 3). This is the single settle door every card
    // path funnels through — the Stripe webhook, the session confirm, the
    // public payment link, the saved-card charge and the auto-confirm cron —
    // AND the manual cash / off-Xero settlement, and by the time it runs, the
    // money has been captured for the amount the intent was minted at (Stripe)
    // or collected by hand for the full amount owing (manual). A stored credit
    // election can therefore no longer be honoured: applying it now would debit
    // the member's balance for cash already taken, which invents a charge
    // rather than honouring a choice. Cash collected outside the app means the
    // member's credit was NOT spent — so clear the election, and never leave a
    // PAID booking advertising an election nothing will act on. Both callers
    // report a non-null clear through reportUnappliedCreditElection after
    // commit, so the member's booking history says "your credit is still
    // available" and an operator can decide whether to refund the difference.
    //
    // Nearly always a no-op, and that is the point. Every minter of a primary
    // intent either consumes the election first (the pay step, whose consumption
    // is what makes the intent smaller) or cannot reach a booking that carries
    // one (the payment link now refuses such a booking outright;
    // charge-saved-method requires PENDING, a status no election carrier is ever
    // in). Guarding HERE rather than in each of those callers means the invariant
    // "no settled booking carries a stored election" holds by construction at the
    // point of settlement, instead of resting on the provenance of five callers
    // staying true — which is exactly the kind of incidental safety that quietly
    // stops being safe.
    //
    // Guarded claim on the exact amount read, so a pay-step consumer racing this
    // writer is never clobbered; see clearStaleCreditElection.
    const staleCreditElectionCents = await clearStaleCreditElection(tx, booking);

    await reconcileBedAllocationsForBookingWithLodgeLockHeld({
      bookingId: booking.id,
      db: tx,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    if (settlement.kind === "manual") {
      // Stripe-intent hygiene, belt-and-braces under guard 3. The member may
      // still hold a live /pay client secret for this booking; once the club
      // has the cash, that intent must not capture. Durable CANCEL_PAYMENT_INTENT
      // recovery operations are enqueued here, ATOMIC with the settlement and
      // BEFORE any Stripe call (the #1349 pattern, byte-for-byte the shape
      // booking-cancel uses); the best-effort Stripe cancel runs after commit.
      // If an intent captures first anyway, the widened duplicate-capture
      // predicate above auto-refunds it.
      // #2397 F4: the addition's own live intent is spared when — and only
      // when — the admin said the cash did NOT cover the addition, because the
      // club goes on asking for that money and this is the member's only door
      // to send it. Everything else, including the addition's intent on the
      // covered answer, is cancelled exactly as before.
      const { cancelledIntentIds: outstandingIntentIds, sparedIntentId } =
        await enqueueManualSettlementIntentCancellations(tx, {
          bookingId: booking.id,
          paymentId: payment.id,
          spareAdditionalPaymentIntentId:
            manualUncollectedAdditionalCents > 0
              ? manual?.additionalPaymentIntentId ?? null
              : null,
        });

      await createAuditLog(
        {
          action: MANUAL_MARK_PAID_AUDIT_ACTION,
          memberId: settlement.actingAdminMemberId,
          actorMemberId: settlement.actingAdminMemberId,
          subjectMemberId: booking.memberId,
          targetId: booking.id,
          entityType: "Payment",
          entityId: payment.id,
          category: "payment",
          severity: "important",
          outcome: "success",
          summary: "Booking payment manually marked paid (cash / off-Xero)",
          details: settlement.note,
          metadata: {
            bookingId: booking.id,
            paymentId: payment.id,
            effectiveAmountCents: settlementAmountCents,
            creditAppliedCents: mirrorCreditAppliedCents,
            previousStatus: booking.status,
            hasXeroInvoiceLink: false,
            cancelledPaymentIntentIds: outstandingIntentIds,
            // #2397 F4: the addition's live intent this settle deliberately did
            // NOT disarm, because the extra is still owed and this is the
            // member's door to pay it. Null on every other settlement — the
            // covered answer included — so the audit trail distinguishes "left
            // a way to pay" from "there was never anything to leave".
            sparedAdditionalPaymentIntentId: sparedIntentId,
            // #2262 door 3: a stored, unconsumed credit election this cash
            // settlement could not honour, cleared under the same locks by the
            // guarded claim above (null when the booking carried none). The
            // member-visible report rides the shared
            // UNAPPLIED_CREDIT_ELECTION_AUDIT_ACTION row written post-commit;
            // this key keeps the money trail complete on the mark-paid entry
            // itself — AND it is the record the reversal reads back to restore
            // the member's election (see `reverseManualBookingPayment`), which
            // is why it must record exactly what THIS settle cleared and null
            // when it cleared nothing.
            clearedCreditElectionCents: staleCreditElectionCents,
            // #2260 honesty rule: record the email decision BOTH ways, so a
            // reader can tell "chose not to email" from "no choice was offered".
            notifyMember: settlement.notifyMember,
            // #2397, the same honesty rule for the extra: record what was
            // outstanding, whether the admin was asked at all, and what they
            // answered — so a reader can tell "said the cash did not cover it"
            // from "there was no extra to ask about". The settled figure and the
            // status it replaced are ALSO what the reversal reads back, which is
            // why they must be exactly what this settle wrote.
            outstandingAdditionalCents: manualOutstandingAdditionalCents,
            additionalCoverageAnswer:
              settlement.additionalCoverage === null
                ? null
                : settlement.additionalCoverage.covered,
            // #2397 (owner decision, 31 Jul 2026): the three figures a later
            // reader needs to reconstruct which branch ran and what it meant.
            // `effectiveAmountCents` above is the settled figure that was
            // actually WRITTEN; this is what the booking still owed in total,
            // and what of that was deliberately left uncollected. On the covered
            // answer the two are `amountOwing` and 0; on the not-covered answer
            // `effectiveAmountCents + uncollectedAdditionalCents = amountOwing`.
            amountOwingCents: manualAmountOwingCents,
            uncollectedAdditionalCents: manualUncollectedAdditionalCents,
            settledAdditionalAmountCents:
              manualAdditionalSettlementCents > 0
                ? manualAdditionalSettlementCents
                : null,
            previousAdditionalPaymentStatus:
              manualAdditionalSettlementCents > 0
                ? manualPreviousAdditionalPaymentStatus
                : null,
          },
        },
        tx
      );

      // #2397 — the member-readable timeline entry. A second, dedicated audit
      // row rather than a field on the one above, because the booking history is
      // built from whitelisted audit ACTIONS: without its own action the extra
      // would be absorbed into the mark-paid row the timeline never renders, and
      // the money would move with nothing on the booking to say so.
      if (manualAdditionalSettlementCents > 0) {
        await createAuditLog(
          {
            action: MANUAL_MARK_PAID_ADDITIONAL_AUDIT_ACTION,
            memberId: settlement.actingAdminMemberId,
            actorMemberId: settlement.actingAdminMemberId,
            subjectMemberId: booking.memberId,
            targetId: booking.id,
            entityType: "Payment",
            entityId: payment.id,
            category: "payment",
            severity: "important",
            outcome: "success",
            summary:
              "Extra owing on a booking recorded as settled manually (cash / off-Xero)",
            // JSON, because the booking-history builder parses this field.
            details: JSON.stringify({
              additionalAmountCents: manualAdditionalSettlementCents,
            }),
            metadata: {
              bookingId: booking.id,
              paymentId: payment.id,
              additionalAmountCents: manualAdditionalSettlementCents,
              previousAdditionalPaymentStatus:
                manualPreviousAdditionalPaymentStatus,
              settlementAmountCents,
            },
          },
          tx
        );
      }

      return {
        outcome: "manual_paid" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
        effectiveAmountCents: settlementAmountCents,
        creditAppliedCents: mirrorCreditAppliedCents,
        previousStatus: booking.status,
        settledAt: manualSettledAt,
        outstandingIntentIds,
        staleCreditElectionCents,
        amountOwingCents: manualAmountOwingCents,
        outstandingAdditionalCents: manualOutstandingAdditionalCents,
        settledAdditionalAmountCents: manualAdditionalSettlementCents,
        uncollectedAdditionalCents: manualUncollectedAdditionalCents,
        sparedAdditionalPaymentIntentId: sparedIntentId,
      };
    }

    return {
      outcome: "paid" as const,
      booking,
      paymentId: payment.id,
      bumpedBookingIds: [] as string[],
      staleCreditElectionCents,
    };
}

export async function markBookingPaymentSucceeded({
  bookingId,
  paymentIntentId,
  amountCents,
  paymentMethodId,
}: {
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
}): Promise<MarkBookingPaymentSucceededResult> {
  const reconciliation = await prisma.$transaction((tx) =>
    settleBookingPaymentInTransaction(tx, bookingId, {
      kind: "stripe",
      paymentIntentId,
      amountCents,
      paymentMethodId,
    })
  );

  if (reconciliation.outcome === "manual_paid") {
    // Unreachable: the Stripe settlement source never produces it. Narrowing
    // only, so the branches below keep their exact shapes.
    throw new Error("Unexpected manual settlement outcome on the Stripe path");
  }

  if (
    reconciliation.outcome === "paid" &&
    reconciliation.staleCreditElectionCents != null
  ) {
    // #2265 (#2319). Post-commit, outside the transaction: the member paid the
    // full price while holding credit they had asked to spend, so say so on
    // their booking history and put it in front of an operator who can decide
    // whether to refund the difference. Their balance is untouched either way.
    await reportUnappliedCreditElection({
      bookingId,
      memberId: reconciliation.booking.memberId,
      memberFirstName: reconciliation.booking.member.firstName,
      memberLastName: reconciliation.booking.member.lastName,
      checkIn: reconciliation.booking.checkIn,
      checkOut: reconciliation.booking.checkOut,
      electionCents: reconciliation.staleCreditElectionCents,
      paidAmountCents: amountCents,
      source: "payment-reconciliation",
      reference: paymentIntentId,
      extraDetails: { paymentIntentId },
    });
  }

  if (reconciliation.outcome === "paid") {
    // Single durable "paid" fact for every payment path (session, webhook,
    // payment link, cron auto-charge). A provisional non-member child booking
    // (parentBookingId set) is recorded as confirmed/charged; everything else
    // is the member paying up front (issue #740).
    await recordBookingEvent({
      bookingId,
      type: reconciliation.booking.parentBookingId
        ? BookingEventType.NON_MEMBER_CONFIRMED
        : BookingEventType.MEMBER_PAID,
      actorMemberId: reconciliation.booking.memberId,
      amountCents,
    });
  }

  if (reconciliation.outcome === "duplicate_capture") {
    // #1992 — the arriving capture is duplicate money on a booking already
    // settled by a different intent. The durable refund debt committed with
    // the transaction above; everything below is the inline attempt at the
    // same frozen slice, executed OUTSIDE any database transaction. Loud on
    // purpose: money is moving automatically.
    const { refundPlan, plannedRefundCents, settledPaymentIntentId } =
      reconciliation;
    logger.error(
      {
        bookingId,
        duplicatePaymentIntentId: paymentIntentId,
        settledPaymentIntentId,
        refundCents: plannedRefundCents,
      },
      "Duplicate Stripe capture on an already-paid booking (#1992); auto-refunding the duplicate capture"
    );

    // #2008 — a durable, ADMIN-ONLY BookingEvent IS recorded for this refund
    // once its recovery operation reaches SUCCEEDED (see below), but it is a
    // REFUNDED event carrying the `duplicate_capture_refund` discriminator so
    // resolveBookingNarrative EXCLUDES it (isDuplicateCaptureRefundEvent) and
    // it can never masquerade as the settlement clause of a LATER member
    // cancellation. The rest of the audit trail is unchanged: the
    // PaymentRecoveryOperation row, the PaymentRefund ledger entries, this log
    // line and the admin alert below.
    try {
      await refundPaymentTransactions({
        paymentId: reconciliation.paymentId,
        amountCents: plannedRefundCents,
        reason: "requested_by_customer",
        allocation: refundPlan,
        // Shared with the recovery cron's replay (via
        // bookingModificationRefundReasonForKeyPrefix) so the two send a
        // byte-identical request body under the same
        // `duplicate_capture_refund_<bookingId>_<paymentIntentId>` key prefix
        // — Stripe replays the original refund instead of rejecting the
        // reused key with idempotency_error.
        metadata: buildBookingModificationRefundMetadata(
          bookingId,
          "duplicate_capture"
        ),
        idempotencyKeyPrefix: buildDuplicateCaptureRefundStripeKeyPrefix(
          bookingId,
          paymentIntentId
        ),
      });

      // Happy-path close of the pre-persisted operation. Best-effort: a lost
      // close leaves a PENDING row whose replay re-requests the identical
      // slice/keys, which Stripe answers with the original refund.
      const markResult = await markDuplicateCaptureRefundRecoverySucceeded({
        bookingId,
        paymentIntentId,
      }).catch((markErr) => {
        logger.error(
          { err: markErr, bookingId, paymentIntentId },
          "Failed to mark duplicate-capture refund recovery succeeded; the cron will replay the frozen plan idempotently"
        );
        return null;
      });

      // #2008 — record the admin-only history event EXACTLY ONCE, gated on this
      // call being the one that flipped the operation to SUCCEEDED (count > 0).
      // If the mark was lost or the cron already closed the operation, this
      // path records nothing and the cron-replay path owns the event, so the
      // inline and cron paths never double-record. Post-commit, base client.
      if (markResult && markResult.count > 0) {
        await recordDuplicateCaptureRefundEvent({
          bookingId,
          amountCents: plannedRefundCents,
          duplicatePaymentIntentId: paymentIntentId,
          settledPaymentIntentId: settledPaymentIntentId ?? null,
        });
      }

      // Alert the admins even on success: an automatic refund of a duplicate
      // charge is an anomaly worth eyes, and the alert is the operator's cue
      // to check how the double capture happened. Dedicated template (#2007)
      // whose success variant states the duplicate was refunded in full.
      sendAdminDuplicateCaptureRefundAlert({
        memberName: `${reconciliation.booking.member.firstName} ${reconciliation.booking.member.lastName}`,
        checkIn: reconciliation.booking.checkIn,
        checkOut: reconciliation.booking.checkOut,
        amountCents: plannedRefundCents,
        paymentIntentId,
        settledPaymentIntentId: settledPaymentIntentId ?? null,
        operationReference: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
          bookingId,
          paymentIntentId
        ),
        refundFailed: false,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId, paymentIntentId },
          "Failed to alert admins about the auto-refunded duplicate capture"
        )
      );

      return {
        outcome: "duplicate_capture_refunded",
        bookingId,
        bumpedBookingIds: [],
      };
    } catch (refundError) {
      // The refund debt already committed with the frozen slice, so nothing
      // needs enqueueing here: the recovery cron replays it with backoff and
      // alerts on exhaustion. Record the inline error for operator visibility
      // and alert immediately as well.
      logger.error(
        { err: refundError, bookingId, paymentIntentId },
        "Failed to auto-refund a duplicate capture; the pre-persisted recovery operation will replay the refund"
      );
      await recordDuplicateCaptureRefundRecoveryInlineError({
        bookingId,
        paymentIntentId,
        message:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
      }).catch((recordErr) =>
        logger.error(
          { err: recordErr, bookingId, paymentIntentId },
          "Failed to record inline duplicate-capture refund failure on the recovery operation"
        )
      );
      sendAdminDuplicateCaptureRefundAlert({
        memberName: `${reconciliation.booking.member.firstName} ${reconciliation.booking.member.lastName}`,
        checkIn: reconciliation.booking.checkIn,
        checkOut: reconciliation.booking.checkOut,
        amountCents: plannedRefundCents,
        paymentIntentId,
        settledPaymentIntentId: settledPaymentIntentId ?? null,
        operationReference: buildDuplicateCaptureRefundRecoveryIdempotencyKey(
          bookingId,
          paymentIntentId
        ),
        errorMessage:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
        refundFailed: true,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId, paymentIntentId },
          "Failed to alert admins about the failed duplicate-capture refund"
        )
      );

      return {
        outcome: "duplicate_capture_refund_failed",
        bookingId,
        bumpedBookingIds: [],
        refundError:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
      };
    }
  }

  if (reconciliation.outcome === "capacity_failed") {
    // Payment succeeded but the final capacity claim failed: the booking was
    // cancelled inside the transaction and is auto-refunded here (issue #740).
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: reconciliation.booking.memberId,
      amountCents,
      reason:
        "These dates filled up before payment could be secured, so the booking was cancelled and refunded.",
      snapshot: {
        policySummary:
          "These dates were no longer available when payment completed, so the full amount was refunded.",
        refundMethod: "card",
        refundPercentage: 100,
        paidAmountCents: amountCents,
        settledAmountCents: amountCents,
        retainedAmountCents: 0,
      },
    });

    // The refund debt was persisted INSIDE the claim transaction with the
    // frozen allocation plan (see the enqueue above): everything below is the
    // inline attempt at the same slices, and any failure leaves the PENDING
    // operation for the recovery cron — never a stranded charge that only an
    // alert email knows about.
    const { refundPlan, plannedRefundCents } = reconciliation;
    if (plannedRefundCents < amountCents) {
      // Mirror-vs-ledger drift (same guard as booking-cancel): refund what
      // the payment ledger actually shows refundable and surface the gap.
      logger.error(
        { bookingId, paymentIntentId, amountCents, plannedRefundCents },
        "Capacity-race refund plan covers less than the captured amount; refunding what the payment ledger shows refundable"
      );
    }

    try {
      if (refundPlan.length === 0 || plannedRefundCents <= 0) {
        throw new Error(
          "Capacity-race refund plan is empty: no captured Stripe transaction to refund"
        );
      }

      await refundPaymentTransactions({
        paymentId: reconciliation.paymentId,
        amountCents: plannedRefundCents,
        reason: "requested_by_customer",
        allocation: refundPlan,
        // Shared with the recovery cron's replay (via
        // bookingModificationRefundReasonForKeyPrefix) so the two send a
        // byte-identical request body under the same
        // `capacity_claim_failed_<bookingId>_<paymentIntentId>` key prefix —
        // Stripe replays the original refund instead of rejecting the reused
        // key with idempotency_error. The metadata deliberately carries only
        // values the cron can reconstruct from the persisted operation.
        metadata: buildBookingModificationRefundMetadata(
          bookingId,
          "capacity_claim_failed"
        ),
        idempotencyKeyPrefix: buildCapacityClaimFailedRefundStripeKeyPrefix(
          bookingId,
          paymentIntentId
        ),
      });

      // Happy-path close of the pre-persisted operation. Best-effort: a lost
      // close leaves a PENDING row whose replay re-requests the identical
      // slices/keys, which Stripe answers with the original refunds.
      await markCapacityClaimFailedRefundRecoverySucceeded({
        bookingId,
        paymentIntentId,
      }).catch((markErr) =>
        logger.error(
          { err: markErr, bookingId, paymentIntentId },
          "Failed to mark capacity-race refund recovery succeeded; the cron will replay the frozen plan idempotently"
        )
      );

      await recordBookingEvent({
        bookingId,
        type: BookingEventType.REFUNDED,
        actorMemberId: reconciliation.booking.memberId,
        amountCents,
        reason: "Automatic refund after lodge capacity was no longer available.",
      });

      return {
        outcome: "cancelled_refunded",
        bookingId,
        bumpedBookingIds: [],
      };
    } catch (refundError) {
      // The cancel claim already committed together with the recovery
      // operation, so nothing needs enqueueing here: the cron replays the
      // frozen plan with backoff and alerts on exhaustion. A partial success
      // has recorded its completed slices; the replay re-requests the SAME
      // slices/keys, so completed slices are replayed by Stripe, not
      // repeated, and only the remainder moves money. Record the inline
      // error on the operation and keep the immediate admin alert.
      logger.error(
        { err: refundError, bookingId, paymentIntentId },
        "Failed to auto-refund booking after final capacity claim failed; the pre-persisted recovery operation will replay the refund"
      );
      await recordCapacityClaimFailedRefundRecoveryInlineError({
        bookingId,
        paymentIntentId,
        message:
          refundError instanceof Error
            ? refundError.message
            : String(refundError),
      }).catch((recordErr) =>
        logger.error(
          { err: recordErr, bookingId, paymentIntentId },
          "Failed to record inline capacity-race refund failure on the recovery operation"
        )
      );
      await alertRefundFailure({
        booking: reconciliation.booking,
        paymentIntentId,
        amountCents,
        error: refundError,
      });

      return {
        outcome: "cancelled_refund_failed",
        bookingId,
        bumpedBookingIds: [],
        refundError:
          refundError instanceof Error ? refundError.message : String(refundError),
      };
    }
  }

  return {
    outcome: reconciliation.outcome,
    bookingId,
    bumpedBookingIds: reconciliation.bumpedBookingIds,
  };
}

/**
 * The audit action the manual cash / off-Xero settle writes (#2262 door 3).
 *
 * One constant rather than a literal per call site, because the REVERSAL reads
 * these rows back: it restores the credit election that the matching settle
 * cleared, and it finds that settle by this exact action string. A typo'd
 * literal on either side would silently strand the member's election, which is
 * precisely the failure the restoration exists to prevent.
 */
const MANUAL_MARK_PAID_AUDIT_ACTION =
  "booking-payment.manual-payment.mark-paid";

/**
 * #2397 — the audit action for the SECOND fact a covered settle records: the
 * outstanding upward-modification delta was settled by the same cash.
 *
 * It exists as its own action because the booking-history timeline is built
 * from a whitelist of audit actions (`src/lib/booking-history.ts`, fed by the
 * booking page), so this is what stops the extra being absorbed silently.
 */
const MANUAL_MARK_PAID_ADDITIONAL_AUDIT_ACTION =
  "booking-payment.manual-payment.additional-settled";

/**
 * The `reason` stamped on the manual ADDITIONAL PaymentTransaction, and the
 * marker the reversal looks for. A constant rather than a literal per call site
 * for the same reason as the audit action above: two writers and one reader.
 */
const MANUAL_MARK_PAID_ADDITIONAL_REASON = "manual_mark_paid_additional";

/**
 * Read `clearedCreditElectionCents` back off a mark-paid audit row's metadata.
 *
 * Defensive on purpose: `metadata` is free-form JSON, and rows written before
 * this key existed (or by a future writer that drops it) must read as "nothing
 * was cleared" rather than throw or restore a nonsense figure. Only a positive
 * integer counts — money stays in integer cents, and a zero or negative
 * "election" is not one.
 */
function readClearedCreditElectionCents(
  metadata: Prisma.JsonValue | null | undefined
): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as Prisma.JsonObject).clearedCreditElectionCents;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0
    ? raw
    : null;
}

/**
 * #2397 — read back what a mark-paid audit row says it settled of the booking's
 * outstanding extra, so the REVERSAL can put it back exactly as it was.
 *
 * Defensive for the same reason as the credit-election reader above: `metadata`
 * is free-form JSON, and every row written before this key existed must read as
 * "this settle covered no extra" rather than throw. Returns null in that case;
 * `previousStatus` is deliberately allowed to BE null, because a legacy delta
 * with no recorded status is a real state the reversal has to restore
 * faithfully.
 */
function readSettledAdditionalPayment(
  metadata: Prisma.JsonValue | null | undefined
): { amountCents: number; previousStatus: string | null } | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const object = metadata as Prisma.JsonObject;
  const amountCents = object.settledAdditionalAmountCents;
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0
  ) {
    return null;
  }
  const previousStatus = object.previousAdditionalPaymentStatus;
  return {
    amountCents,
    previousStatus: typeof previousStatus === "string" ? previousStatus : null,
  };
}

export type ManualBookingSettlementResult = {
  bookingId: string;
  paymentId: string;
  /**
   * What this settlement RECORDED AS RECEIVED, in integer cents — the figure
   * written to `Payment.amountCents`. It is `finalPriceCents - credit` less any
   * outstanding extra the admin said the cash did not cover (#2397), so it is
   * the money the club actually took and never the booking's whole worth.
   */
  effectiveAmountCents: number;
  creditAppliedCents: number;
  previousStatus: BookingStatus;
  settledAt: Date;
  /** Live Stripe intents this settlement queued a cancellation for. */
  outstandingIntentIds: string[];
  /**
   * #2262 door 3: a stored, unconsumed credit election (#2265) this cash
   * settlement could not honour, cleared inside the settle transaction and
   * reported post-commit (`reportUnappliedCreditElection`). Null when the
   * booking carried none — the overwhelmingly common case.
   */
  staleCreditElectionCents: number | null;
  memberFirstName: string;
  memberEmail: string | null;
  /**
   * #2397. `amountOwingCents` is everything the booking owed
   * (`finalPriceCents - credit`); `outstandingAdditionalCents` is the
   * uncollected upward-modification delta inside it (0 when there was none);
   * `settledAdditionalAmountCents` is how much of that delta the cash covered
   * and `uncollectedAdditionalCents` how much it did not. Always
   * `effectiveAmountCents + uncollectedAdditionalCents === amountOwingCents`.
   */
  amountOwingCents: number;
  outstandingAdditionalCents: number;
  settledAdditionalAmountCents: number;
  uncollectedAdditionalCents: number;
  /**
   * #2397 F4: the addition's live Stripe intent this settlement deliberately
   * left armed, because the extra it collects is still owed. Non-null ONLY on
   * the not-covered answer, and only when the member actually has such an
   * instrument — which is exactly the condition for telling them in the
   * confirmation email that they can pay the balance from their booking page.
   */
  sparedAdditionalPaymentIntentId: string | null;
};

/**
 * B5 (#2262) — record a cash / off-Xero bank-transfer settlement for a booking.
 *
 * A SIBLING ENTRY POINT into the settlement core above, not a second settlement
 * path: it executes the same lock ordering, the same post-lock re-read, the
 * same capacity check with its #1771 override carve-out, the same status-fenced
 * PAID claim and the same bed reconciliation as a Stripe capture, diverging only
 * where a Stripe intent id is intrinsically involved.
 *
 * NEVER calls Xero and NEVER creates or voids an invoice; it refuses outright
 * when any Xero invoice evidence — including a queued mint — exists.
 */
export async function markBookingPaymentManuallySettled({
  bookingId,
  actingAdminMemberId,
  note,
  expectedAmountCents,
  notifyMember,
  additionalCoverage = null,
}: {
  bookingId: string;
  actingAdminMemberId: string;
  note: string | null;
  expectedAmountCents: number;
  notifyMember: boolean;
  additionalCoverage?: ManualAdditionalCoverage | null;
}): Promise<ManualBookingSettlementResult> {
  const reconciliation = await prisma.$transaction((tx) =>
    settleBookingPaymentInTransaction(tx, bookingId, {
      kind: "manual",
      actingAdminMemberId,
      note,
      expectedAmountCents,
      notifyMember,
      additionalCoverage,
    })
  );

  if (reconciliation.outcome !== "manual_paid") {
    // Unreachable: the manual settlement source produces exactly this outcome
    // or throws. Narrowing only.
    throw new Error(
      `Unexpected settlement outcome on the manual path: ${reconciliation.outcome}`
    );
  }

  // #2265 (#2262 door 3). The settle cleared a stored credit election this cash
  // settlement could not honour — the admin collected the full amount owing
  // outside the app while the member held credit they had asked to spend, so
  // that credit was NOT spent and is still on their account. Reported through
  // the shared reporter, post-commit and best-effort by design, so the member's
  // booking history and the operator alert read identically however the clear
  // was reached (Stripe capture, Xero inbound, or this door).
  //
  // FIRST among the post-commit steps, deliberately. Everything after the commit
  // is best-effort, but they are not equally recoverable: `recordBookingEvent`
  // below is un-caught, so a throw there would abandon the rest of this function
  // — and the row this reporter writes is the ONLY place the member is ever told
  // their credit was not spent. The event, by contrast, is an internal timeline
  // fact an operator can reconstruct from the audit log. Ordering the member's
  // answer ahead of it shrinks the window in which a post-commit failure loses
  // the one thing the member reads. The reporter is itself internally
  // best-effort (it catches its own audit and email failures), so putting it
  // first cannot cost the event either.
  if (reconciliation.staleCreditElectionCents != null) {
    await reportUnappliedCreditElection({
      bookingId,
      memberId: reconciliation.booking.memberId,
      memberFirstName: reconciliation.booking.member.firstName,
      memberLastName: reconciliation.booking.member.lastName,
      checkIn: reconciliation.booking.checkIn,
      checkOut: reconciliation.booking.checkOut,
      electionCents: reconciliation.staleCreditElectionCents,
      paidAmountCents: reconciliation.effectiveAmountCents,
      source: "manual-mark-paid",
      // No Stripe intent and no Xero invoice exist by definition on this door,
      // so the booking id is the searchable reference.
      reference: bookingId,
      extraDetails: {
        paymentId: reconciliation.paymentId,
        actingAdminMemberId,
      },
    });
  }

  // The single durable "paid" fact, recorded by the same helper and with the
  // same event types every other settlement path uses — with the ACTING ADMIN
  // as the actor, so the history says who recorded it.
  await recordBookingEvent({
    bookingId,
    type: reconciliation.booking.parentBookingId
      ? BookingEventType.NON_MEMBER_CONFIRMED
      : BookingEventType.MEMBER_PAID,
    actorMemberId: actingAdminMemberId,
    amountCents: reconciliation.effectiveAmountCents,
    reason: "manual_mark_paid",
    snapshot: {
      kind: "manual_mark_paid",
      actingAdminMemberId,
      note,
      effectiveAmountCents: reconciliation.effectiveAmountCents,
      // #2397. Not an extra amount — a slice of `effectiveAmountCents` that the
      // admin confirmed the cash covered, recorded here so the durable event
      // says how the one figure was split.
      settledAdditionalAmountCents:
        reconciliation.settledAdditionalAmountCents || null,
    },
  });

  // Best-effort Stripe cancels, OUTSIDE the transaction. The durable
  // CANCEL_PAYMENT_INTENT operations committed with the settlement, so a
  // failure here only means the recovery cron does the work instead.
  for (const paymentIntentId of reconciliation.outstandingIntentIds) {
    await cancelPaymentIntentIfCancellable(paymentIntentId).catch((err) =>
      logger.warn(
        { err, bookingId, paymentIntentId },
        "Manual mark-paid: best-effort Stripe intent cancel failed; the recovery cron will retry"
      )
    );
  }

  return {
    bookingId,
    paymentId: reconciliation.paymentId,
    effectiveAmountCents: reconciliation.effectiveAmountCents,
    creditAppliedCents: reconciliation.creditAppliedCents,
    previousStatus: reconciliation.previousStatus,
    settledAt: reconciliation.settledAt,
    outstandingIntentIds: reconciliation.outstandingIntentIds,
    staleCreditElectionCents: reconciliation.staleCreditElectionCents,
    memberFirstName: reconciliation.booking.member.firstName,
    memberEmail: reconciliation.booking.member.email ?? null,
    amountOwingCents: reconciliation.amountOwingCents,
    outstandingAdditionalCents: reconciliation.outstandingAdditionalCents,
    sparedAdditionalPaymentIntentId:
      reconciliation.sparedAdditionalPaymentIntentId,
    settledAdditionalAmountCents: reconciliation.settledAdditionalAmountCents,
    uncollectedAdditionalCents: reconciliation.uncollectedAdditionalCents,
  };
}

export type ManualBookingReversalResult = {
  bookingId: string;
  paymentId: string;
  previousStatus: BookingStatus;
  restoredStatus: BookingStatus;
  reversedAmountCents: number;
  closedRecoveryOperationIds: string[];
  clearedInternetBankingHold: boolean;
  /**
   * #2262 door 3 / #2265: the stored credit election this reversal put BACK on
   * the booking, in integer cents — exactly what the matching mark-paid had
   * cleared. Null when that settle cleared nothing, or when the guarded restore
   * declined because a legitimate writer had already set an election since.
   */
  restoredCreditElectionCents: number | null;
  /**
   * #2397: the outstanding extra the matching mark-paid recorded as covered by
   * the cash, and which this reversal has put back to owing — in integer cents,
   * or null when that settle covered no extra (or the guarded restore declined
   * because the extra had legitimately been settled since).
   */
  restoredAdditionalAmountCents: number | null;
};

const MANUAL_REVERSAL_REFUSAL =
  "This payment can no longer be reversed — cancel the booking instead.";

/**
 * B5 (#2262) — reverse a manual mark-paid (direction "unpaid").
 *
 * Only ever permitted on a payment THIS feature marked paid, and only while
 * nothing has happened since that a reversal could not undo: no refund, no
 * settled Stripe money, no open hand-back task, and no Xero invoice or queued
 * mint acquired since the settle. Anything else is a cancellation, not a
 * reversal.
 *
 * HIGH #1 — the reversal DISARMS ITS OWN HYGIENE OPERATIONS. The mark-paid may
 * have queued CANCEL_PAYMENT_INTENT (and, via the cron's handoff,
 * REFUND_SUPERSEDED_PAYMENT) operations for a then-live intent X.
 * processCancelPaymentIntentOperation hands ANY succeeded intent to the refund
 * handoff with no booking-status check, so mark-paid -> reversal -> the
 * member's stale /pay tab captures X and legitimately settles the booking ->
 * the cron processes the now-stale cancel op would REFUND THE REAL SETTLEMENT,
 * leaving a PAID booking at zero net cash. Those operations must not outlive
 * the settlement they were minted to protect, so the reversal DELETES every
 * non-terminal one inside its own transaction (deletion, not a terminal
 * status flip: every webhook-side liveness predicate keys on
 * `status != SUCCEEDED`, so only a deleted row is invisible to all of them —
 * see the disarm comment in the body).
 *
 * The disarm is idempotent by construction: it is a status-fenced conditional
 * delete, so a replayed reversal deletes zero rows — and the reversal's own
 * fenced payment write has already 409'd by then. It can never close an
 * operation the reversal itself depends on: the reversal enqueues no recovery
 * work of its own and runs strictly after the settle whose operations it closes.
 */
export async function reverseManualBookingPayment({
  bookingId,
  actingAdminMemberId,
  note,
}: {
  bookingId: string;
  actingAdminMemberId: string;
  note: string | null;
}): Promise<ManualBookingReversalResult> {
  const reversal = await prisma.$transaction(async (tx) => {
    // Same two-tier ordering as the settlement body: global lock(1) first (this
    // moves booking status and money), then the per-lodge capacity lock,
    // because restoring a PAYMENT_PENDING booking RELEASES capacity.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const lockTarget = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true },
    });
    if (!lockTarget) {
      throw new ManualBookingPaymentError("Booking not found.", 404);
    }
    const bookingLodgeId = lockTarget.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true },
    });
    if (!booking) {
      throw new ManualBookingPaymentError("Booking not found.", 404);
    }
    const payment = booking.payment;
    if (!payment || !payment.manuallyMarkedPaidAt) {
      throw new ManualBookingPaymentError(
        "Only a manually recorded payment can be reversed here.",
        409
      );
    }
    if (booking.status !== BookingStatus.PAID) {
      throw new ManualBookingPaymentError(MANUAL_REVERSAL_REFUSAL, 409);
    }
    if (payment.refundedAmountCents !== 0) {
      throw new ManualBookingPaymentError(MANUAL_REVERSAL_REFUSAL, 409);
    }

    const refundRows = await tx.paymentRefund.count({
      where: { paymentId: payment.id },
    });
    if (refundRows > 0) {
      throw new ManualBookingPaymentError(MANUAL_REVERSAL_REFUSAL, 409);
    }

    const settledStripeTransaction = await tx.paymentTransaction.findFirst({
      where: {
        paymentId: payment.id,
        source: PaymentSource.STRIPE,
        status: {
          in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
        },
      },
      select: { id: true },
    });
    if (settledStripeTransaction) {
      throw new ManualBookingPaymentError(
        "A card payment has since settled this booking — reversing the manual record here would misstate the ledger.",
        409
      );
    }

    const openTask = await tx.manualRefundTask.findFirst({
      where: { paymentId: payment.id, status: "OPEN" },
      select: { id: true },
    });
    if (openTask) {
      throw new ManualBookingPaymentError(
        "There is an open manual refund task for this payment — resolve it before reversing the settlement.",
        409
      );
    }

    // Guard 2 again, for anything acquired SINCE the settle.
    await assertNoXeroInvoiceEvidence(tx, payment);

    // HIGH #1 — disarm, inside this transaction, before anything else is
    // written. The disarmed operations are DELETED, not flipped to a terminal
    // status: every webhook-side liveness predicate keys on
    // `status != SUCCEEDED` (queueSupersededPaymentIntentRefundRecovery,
    // listLiveSupersededIntentIds, findLiveSupersededIntentOperation), so a
    // FAILED "closed" row would still read as LIVE to all of them — a
    // post-reversal capture from a stale /pay tab would be handed to the
    // superseded-refund machinery (member charged, silently refunded, booking
    // never settles) and the intent id would sit in the duplicate-guard's
    // `notIn` exclusion forever. Deletion makes every one of those predicates
    // coherent at once, and it re-arms a later re-mark cleanly: the settle's
    // enqueue upsert finds no row and its CREATE arm fires with a fresh
    // PENDING status and nextRetryAt.
    //
    // Scope: every non-terminal CANCEL_PAYMENT_INTENT / REFUND_SUPERSEDED_
    // PAYMENT operation on this payment. That is exactly the set the settle
    // minted or adopted: the settle's own enqueue upserts on the shared
    // `payment_recovery_cancel_<txn>_<pi>` key, so a pre-existing cancel op
    // for a still-live intent IS the settle's op; and a member-owed
    // REFUND_SUPERSEDED_PAYMENT op can never be reached here, because the
    // handoff that creates one marks its transaction SUCCEEDED first and this
    // reversal already 409'd above on any settled Stripe transaction.
    //
    // The rows' full content is read first and preserved in the AuditLog
    // metadata and the reversal's BookingEvent snapshot (ids), so the audit
    // trail — not the queue — is where the closed operations live on.
    const doomedOperations = await tx.paymentRecoveryOperation.findMany({
      where: {
        paymentId: payment.id,
        type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
          ],
        },
      },
      select: {
        id: true,
        type: true,
        status: true,
        paymentIntentId: true,
        paymentTransactionId: true,
        amountCents: true,
        idempotencyKey: true,
        attempts: true,
        createdAt: true,
      },
    });
    // Status-fenced WRITE, idempotent by construction: a replayed reversal
    // deletes zero rows (and its own fenced payment write 409s). A worker that
    // already claimed one of these PROCESSING can no longer complete or hand
    // it off — its re-claim and its fenced completion both match nothing once
    // the row is gone (see handoffSucceededSupersededIntentToRefund /
    // completePaymentRecoveryOperation in payment-recovery.ts).
    await tx.paymentRecoveryOperation.deleteMany({
      where: {
        paymentId: payment.id,
        type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
          ],
        },
      },
    });

    // #2265 (#2262 door 3): RESTORE the credit election this settlement
    // cleared, so the reversal genuinely undoes the settle rather than leaving
    // the member's choice behind.
    //
    // Why restoring is the only honest answer. The election is stored on the
    // booking and there is NO post-create control that can put it back: the
    // only writer of `creditElectionCents` outside these settlement paths is
    // booking-create (`applyCreditCents` at creation time), and the pay route's
    // body is booking-id-only. So a member whose booking was marked paid and
    // then reversed would hold credit they had asked to spend, on a booking
    // that is payable again, with no way to re-elect it — they would be quietly
    // charged the full price a second time.
    //
    // Exactly what this settle cleared, and nothing else. The amount comes from
    // the mark-paid audit row's `clearedCreditElectionCents` (recorded
    // in-transaction by the settle, so it is the value that settle actually took
    // off the column, not a guess), and the restore is a GUARDED write matching
    // `creditElectionCents: null` — the mirror image of `clearStaleCreditElection`
    // in the settle. If a legitimate writer has since put an election on this
    // booking, the guard matches nothing and their value stands untouched. If
    // the settle cleared nothing, there is nothing to restore and no write
    // happens at all.
    //
    // The member is not re-notified: they were told the credit was not used and
    // is still available, which stays true throughout. A re-mark after this
    // reversal finds the restored election, clears it again and reports again —
    // once per settlement that took cash while the election stood, which is the
    // honest count.
    const lastManualSettleAudit = await tx.auditLog.findFirst({
      where: {
        action: MANUAL_MARK_PAID_AUDIT_ACTION,
        entityType: "Payment",
        entityId: payment.id,
      },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    });
    const clearedCreditElectionCents = readClearedCreditElectionCents(
      lastManualSettleAudit?.metadata
    );
    // #2397: what that same settle recorded of the booking's outstanding extra.
    const settledAdditional = readSettledAdditionalPayment(
      lastManualSettleAudit?.metadata
    );
    let restoredCreditElectionCents: number | null = null;
    if (clearedCreditElectionCents != null) {
      const restored = await tx.booking.updateMany({
        where: { id: booking.id, creditElectionCents: null },
        data: { creditElectionCents: clearedCreditElectionCents },
      });
      restoredCreditElectionCents =
        restored.count === 1 ? clearedCreditElectionCents : null;
    }

    // A stored DRAFT deliberately restores as PAYMENT_PENDING (owner-decided
    // 28 Jul). This is code-necessary, not taste: DRAFT is a payable status, so
    // a DRAFT booking CAN be settled, and the PAID claim cleared
    // `draftExpiresAt` — there is nothing left to restore, so a restored DRAFT
    // would be an expiry-less draft forever.
    const storedPreviousStatus =
      payment.manuallyMarkedPaidPreviousStatus ?? BookingStatus.PAYMENT_PENDING;
    const restoredStatus =
      storedPreviousStatus === BookingStatus.DRAFT
        ? BookingStatus.PAYMENT_PENDING
        : storedPreviousStatus;

    // IB hold-expiry carve-out. A restored CONFIRMED booking carrying an
    // already-passed internetBankingHoldUntil is exactly the shape
    // releaseExpiredInternetBankingHolds sweeps — the next cron run would
    // auto-cancel the booking and email the member minutes after a silent
    // reversal. Clear the deadline (rather than silently extending one the
    // member never agreed to): the booking keeps its beds with no expiry and an
    // admin must explicitly re-arm a hold if one is wanted.
    const clearInternetBankingHold =
      restoredStatus === BookingStatus.CONFIRMED &&
      payment.internetBankingHoldUntil !== null;

    const reversedPayment = await tx.payment.updateMany({
      where: {
        id: payment.id,
        manuallyMarkedPaidAt: { not: null },
        refundedAmountCents: 0,
      },
      data: {
        status: PaymentStatus.PENDING,
        // `source` is deliberately left as-is: the row is still an
        // internet-banking payment, it is simply no longer settled.
        manuallyMarkedPaidAt: null,
        manuallyMarkedPaidByMemberId: null,
        manualPaymentNote: null,
        manuallyMarkedPaidPreviousStatus: null,
        ...(clearInternetBankingHold ? { internetBankingHoldUntil: null } : {}),
      },
    });
    if (reversedPayment.count === 0) {
      throw new ManualBookingPaymentError(
        "This payment changed while you were reversing it — refresh and try again.",
        409
      );
    }

    const revertedBooking = await tx.booking.updateMany({
      where: { id: booking.id, status: BookingStatus.PAID },
      data: { status: restoredStatus },
    });
    if (revertedBooking.count === 0) {
      throw new ManualBookingPaymentError(
        "This booking changed while you were reversing the payment — refresh and try again.",
        409
      );
    }

    // History is preserved rather than deleted, and the row can never read
    // "unpaid (manual)". The settle mint's predicate deliberately skips FAILED
    // rows, so a later re-mark mints a FRESH row at the new amount instead of
    // resurrecting this one at a stale one.
    await tx.paymentTransaction.updateMany({
      where: {
        paymentId: payment.id,
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.INTERNET_BANKING,
        status: PaymentStatus.SUCCEEDED,
      },
      data: {
        status: PaymentStatus.FAILED,
        reason: "manual_mark_paid_reversed",
      },
    });

    // #2397 — the extra goes back to owing, or the reversal would leave a
    // booking that is unpaid again while its later addition still reads as
    // collected, and no surface would ever ask for it. Both halves, in the
    // order that keeps them consistent if either declines:
    //  * the durable ADDITIONAL row is marked FAILED (never deleted), same
    //    treatment and same reason-stamp shape as the PRIMARY row above, so a
    //    later re-mark mints a fresh row rather than resurrecting a stale one;
    //  * the summary column is restored with a GUARDED claim matching the exact
    //    figure and status this settle wrote. If a legitimate writer has settled
    //    the extra since (a card capture landing on the restored booking, say),
    //    the guard matches nothing and their value stands untouched.
    let restoredAdditionalAmountCents: number | null = null;
    if (settledAdditional) {
      await tx.paymentTransaction.updateMany({
        where: {
          paymentId: payment.id,
          kind: PaymentTransactionKind.ADDITIONAL,
          source: PaymentSource.INTERNET_BANKING,
          status: PaymentStatus.SUCCEEDED,
          reason: MANUAL_MARK_PAID_ADDITIONAL_REASON,
        },
        data: {
          status: PaymentStatus.FAILED,
          reason: "manual_mark_paid_additional_reversed",
        },
      });

      const restoredAdditional = await tx.payment.updateMany({
        where: {
          id: payment.id,
          additionalAmountCents: settledAdditional.amountCents,
          additionalPaymentStatus: "SUCCEEDED",
        },
        data: { additionalPaymentStatus: settledAdditional.previousStatus },
      });
      restoredAdditionalAmountCents =
        restoredAdditional.count === 1 ? settledAdditional.amountCents : null;
    }

    // Releases the claimed beds only when the restore lands on
    // PAYMENT_PENDING; a restored CONFIRMED booking deliberately keeps holding
    // capacity, because that is what CONFIRMED means.
    await reconcileBedAllocationsForBookingWithLodgeLockHeld({
      bookingId: booking.id,
      db: tx,
      previousRange: { checkIn: booking.checkIn, checkOut: booking.checkOut },
    });

    const closedRecoveryOperationIds = doomedOperations.map(
      (operation) => operation.id
    );
    // The deleted rows' content, preserved verbatim on the audit trail (the
    // queue row is gone by design — see the disarm above).
    const closedRecoveryOperations = doomedOperations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      status: operation.status,
      paymentIntentId: operation.paymentIntentId,
      paymentTransactionId: operation.paymentTransactionId,
      amountCents: operation.amountCents,
      idempotencyKey: operation.idempotencyKey,
      attempts: operation.attempts,
      createdAt: operation.createdAt.toISOString(),
    }));

    await createAuditLog(
      {
        action: "booking-payment.manual-payment.mark-unpaid",
        memberId: actingAdminMemberId,
        actorMemberId: actingAdminMemberId,
        subjectMemberId: booking.memberId,
        targetId: booking.id,
        entityType: "Payment",
        entityId: payment.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Manual booking payment reversed",
        details: note,
        metadata: {
          bookingId: booking.id,
          paymentId: payment.id,
          previousStatus: BookingStatus.PAID,
          storedPreviousStatus,
          restoredStatus,
          reversedAmountCents: payment.amountCents,
          closedRecoveryOperationIds,
          closedRecoveryOperations,
          clearedInternetBankingHold: clearInternetBankingHold,
          // #2265 (#2262 door 3). The member's credit election, put back on the
          // booking by this reversal — recorded BOTH ways, like the email
          // decision below: the cents restored, and the cents the matching
          // settle had cleared. They differ only when the restore's guard
          // declined (a legitimate writer had already put an election back),
          // in which case the settle's figure is the record of what was cleared
          // and the null says plainly that this reversal did not write it back.
          restoredCreditElectionCents,
          settleClearedCreditElectionCents: clearedCreditElectionCents,
          // #2397, recorded BOTH ways for the same reason: what this reversal
          // actually put back to owing, and what the matching settle had said
          // the cash covered. A null restored figure against a non-null settled
          // one says the guard declined because the extra was legitimately
          // settled again in the meantime.
          restoredAdditionalAmountCents,
          settleSettledAdditionalAmountCents:
            settledAdditional?.amountCents ?? null,
          // #2260: a reversal never emails the member. Recorded under its own
          // key so a raw metadata render cannot be misread as an admin having
          // declined a choice they were never offered.
          notifyMemberOffered: false,
        },
      },
      tx
    );

    return {
      booking,
      paymentId: payment.id,
      storedPreviousStatus,
      restoredStatus,
      reversedAmountCents: payment.amountCents,
      closedRecoveryOperationIds,
      clearedInternetBankingHold: clearInternetBankingHold,
      restoredCreditElectionCents,
      restoredAdditionalAmountCents,
    };
  });

  // Recorded as a CANCELLED event carrying the reversal discriminator (#2008
  // pattern): durable and never pruned, rendered honestly on the admin
  // timeline, and EXCLUDED from the member/admin narrative so a later genuine
  // cancellation is not misdated by it.
  const reversalSnapshot: ManualSettlementReversalEventSnapshot = {
    kind: MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND,
    storedPreviousStatus: reversal.storedPreviousStatus,
    restoredStatus: reversal.restoredStatus,
    closedRecoveryOperationIds: reversal.closedRecoveryOperationIds,
    clearedInternetBankingHold: reversal.clearedInternetBankingHold,
    note,
  };
  await recordBookingEvent({
    bookingId,
    type: BookingEventType.CANCELLED,
    actorMemberId: actingAdminMemberId,
    amountCents: reversal.reversedAmountCents,
    reason: MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
    snapshot: reversalSnapshot as unknown as Prisma.InputJsonValue,
  });

  return {
    bookingId,
    paymentId: reversal.paymentId,
    previousStatus: BookingStatus.PAID,
    restoredStatus: reversal.restoredStatus,
    reversedAmountCents: reversal.reversedAmountCents,
    closedRecoveryOperationIds: reversal.closedRecoveryOperationIds,
    clearedInternetBankingHold: reversal.clearedInternetBankingHold,
    restoredCreditElectionCents: reversal.restoredCreditElectionCents,
    restoredAdditionalAmountCents: reversal.restoredAdditionalAmountCents,
  };
}

export async function markBookingSetupIntentSucceeded({
  bookingId,
  setupIntentId,
  paymentMethodId,
}: {
  bookingId: string;
  setupIntentId: string;
  paymentMethodId: string;
}) {
  await prisma.payment.update({
    where: { bookingId },
    data: {
      stripePaymentMethodId: paymentMethodId,
      stripeSetupIntentId: setupIntentId,
    },
  });
}
