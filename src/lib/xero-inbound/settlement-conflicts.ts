/**
 * The two inbound settlement conflicts the Xero invoice-paid loop raises
 * instead of settling quietly, and the one durable record they share.
 *
 * - B5 (#2262)'s reciprocal fence: Xero reports PAID on a booking an admin had
 *   already recorded as settled in cash / by an off-Xero bank transfer.
 * - #3638's second instrument: Xero reports PAID on a booking a card payment
 *   had already settled (`INV-PAY-103`).
 *
 * Split out of `invoice-paid-effects.ts`, which calls these from its settle
 * loop: the detection runs inside that loop's lock(1) transaction, the record
 * and alert after it commits. Nothing here moves money.
 */
import {
  BookingEventType,
  BookingStatus,
  PaymentSource,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { isPaidLikeBookingStatus } from "@/lib/booking-status";
import {
  CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST,
  CAPTURED_TRANSACTION_STATUS_LIST,
  EXCLUDED_LEDGER_REFUND_STATUSES,
} from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  sendAdminManualSettlementConflictAlert,
  sendAdminSecondInstrumentSettlementConflictAlert,
} from "@/lib/email";
import { claimAlertCooldown } from "@/lib/alert-cooldown";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  MANUAL_SETTLEMENT_CONFLICT_EVENT_KIND,
  MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
  type ManualSettlementConflictEventSnapshot,
  type SecondInstrumentSettlementConflictEventSnapshot,
} from "@/lib/manual-settlement-reversal-event";
import { recordBookingEvent } from "@/lib/booking-events";
import { buildDuplicateCaptureRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";
import type { ClubFormat } from "@/lib/club-format";

/**
 * B5 (#2262): repeat-alert window for the reciprocal fence. A webhook replay
 * must RE-COUNT the conflict (it is still unreconciled) without re-mailing the
 * admins every time Xero redelivers the same event. #3638's second-instrument
 * conflict shares it.
 */
const MANUAL_SETTLEMENT_CONFLICT_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * The marker already recorded for (booking, conflict kind, invoice), if any.
 * The dedupe read before a marker is written, and — for #3638's cancelled
 * case — the idempotency record the detector itself reads (see
 * `findSecondInstrumentSettlement`).
 */
function findSettlementConflictMarker(
  store: Pick<Prisma.TransactionClient, "bookingEvent">,
  { bookingId, kind, invoiceId }: { bookingId: string; kind: string; invoiceId: string },
) {
  return store.bookingEvent.findFirst({
    where: {
      bookingId,
      type: BookingEventType.CANCELLED,
      snapshot: { path: ["kind"], equals: kind },
      AND: [{ snapshot: { path: ["invoiceId"], equals: invoiceId } }],
    },
    select: { id: true },
  });
}

/**
 * The durable half shared by both inbound settlement conflicts — B5 (#2262)'s
 * reciprocal fence and #3638's second instrument. Records ONE admin-only
 * marker BookingEvent per (booking, conflict kind, invoice), then claims the
 * cross-instance alert cooldown and reports whether this caller holds it. Runs
 * AFTER the transaction: `recordBookingEvent` swallows its own failure, which
 * must never sit inside a transaction (see booking-events.ts), and the alert
 * the caller then sends is a provider call. Never changes money state.
 *
 * Self-healing rather than atomic: a crash between the commit and this write
 * leaves no marker, and the conflict is detected again on the retry or replay
 * — the #2262 fence and the PAID / COMPLETED arms from the committed state
 * itself, #3638's cancelled case because the missing marker is what it reads.
 * Best-effort still: a marker write that fails on its own (the event helper
 * swallows it) is not retried unless the invoice event is delivered again.
 */
async function recordSettlementConflictMarker({
  bookingId,
  paymentId,
  amountCents,
  invoiceId,
  reason,
  snapshot,
  alertCooldownKeyPrefix,
}: {
  bookingId: string;
  paymentId: string;
  amountCents: number;
  invoiceId: string;
  reason: string;
  snapshot: { kind: string; invoiceId: string | null };
  alertCooldownKeyPrefix: string;
}): Promise<boolean> {
  // BEST-EFFORT once per (booking, kind, invoice): this is a read-then-create
  // with no unique key, so two concurrent replays of the same invoice event can
  // both pass the read and record twice. That duplicate is harmless — the
  // event is an admin-only history marker, the alert below has its own
  // cross-instance cooldown, and no money state keys off the event — so a
  // unique constraint is deliberately not added. A DIFFERENT invoice reporting
  // paid against the same payment still records its own conflict.
  const alreadyRecorded = await findSettlementConflictMarker(prisma, {
    bookingId,
    kind: snapshot.kind,
    invoiceId,
  }).catch((err) => {
    logger.error(
      { err, bookingId, invoiceId, kind: snapshot.kind },
      "Failed to look up an existing settlement-conflict event; recording a fresh one"
    );
    return null;
  });

  if (!alreadyRecorded) {
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: null,
      amountCents,
      reason,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    });
  }

  return claimAlertCooldown({
    key: `${alertCooldownKeyPrefix}:${paymentId}:${invoiceId}`,
    windowMs: MANUAL_SETTLEMENT_CONFLICT_ALERT_COOLDOWN_MS,
  }).catch((err) => {
    logger.error(
      { err, paymentId, invoiceId, kind: snapshot.kind },
      "Failed to claim the settlement-conflict alert cooldown; sending anyway rather than staying silent about unreconciled money"
    );
    return true;
  });
}

type ConflictPayment = Prisma.PaymentGetPayload<{
  // #3369: the owner may be an Organisation; bookingOwner() reads both.
  include: { booking: { include: { member: true, organisation: { select: { name: true, email: true } } } } };
}>;

/**
 * B5 (#2262): the durable half of the reciprocal fence. Records the conflict
 * ONCE per (payment, invoice) as an admin-only BookingEvent, then alerts the
 * admins behind a cross-instance cooldown. Runs AFTER the transaction — the
 * provider call must never sit inside one — and never changes money state.
 */
export async function recordManualSettlementConflict({
  payment,
  bookingStatus,
  invoiceId,
  invoiceNumber,
  format,
}: {
  payment: ConflictPayment;
  bookingStatus: BookingStatus;
  invoiceId: string;
  invoiceNumber: string | null;
  /** The club's format (#3565), resolved before any transaction by the caller. */
  format: ClubFormat;
}) {
  const snapshot: ManualSettlementConflictEventSnapshot = {
    kind: MANUAL_SETTLEMENT_CONFLICT_EVENT_KIND,
    invoiceId,
    invoiceNumber,
    bookingStatus,
  };

  const holdsClaim = await recordSettlementConflictMarker({
    bookingId: payment.bookingId,
    paymentId: payment.id,
    amountCents: payment.amountCents,
    invoiceId,
    reason: MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
    snapshot,
    alertCooldownKeyPrefix: "manual-settlement-conflict",
  });
  if (!holdsClaim) return;

  await sendAdminManualSettlementConflictAlert({
    memberName: `${bookingOwner(payment.booking).member.firstName} ${bookingOwner(payment.booking).member.lastName}`,
    checkIn: payment.booking.checkIn,
    checkOut: payment.booking.checkOut,
    amountCents: payment.amountCents,
    bookingId: payment.bookingId,
    bookingStatus,
    xeroInvoiceNumber: invoiceNumber,
    // Cross-lane #2283: Xero deep links are BUILT, never hand-rolled.
    xeroInvoiceUrl: buildXeroInvoiceUrl(invoiceId),
  }, format).catch((err) =>
    logger.error(
      { err, bookingId: payment.bookingId, paymentId: payment.id, invoiceId },
      "Failed to alert admins about a manual-settlement vs Xero payment conflict"
    )
  );
}

/**
 * #3638: the captured PRIMARY row of a DIFFERENT instrument — not Internet
 * Banking, so today a card payment — on a booking that instrument already
 * settled. Null when there is none, which is every ordinary Internet Banking
 * booking and every replay of one.
 *
 * - PAID / COMPLETED: the card row must still hold net cash — a capture
 *   refunded in full holds nothing twice.
 * - CANCELLED (only with `includeCancelled`, the pre-settlement read): any
 *   capture, refunded or not, because the cancellation already settled the
 *   card money under its own policy and this bank cash has nowhere to go —
 *   the credit-mint arm mints only for a payment that never settled. Once the
 *   bank cash is RECORDED (a captured Internet Banking PRIMARY row exists) it
 *   stays a conflict until this invoice's marker exists: the marker is written
 *   after the receipt commits, so a crash in between must be raised on the
 *   retry, and a replay after the marker is not raised again.
 *
 * Never these, which are not a second instrument:
 * - a capture the #1992 duplicate-capture refund owns: the opposite order
 *   (bank first, card second), whose durable refund operation already says
 *   which side goes back (`INV-PAY-043`);
 * - #1765 refund history, where the booking is not cancelled or the bank cash
 *   is already recorded: a card row with a refund recorded before the booking
 *   moved to Internet Banking. That is a repay-after-refund booking — the
 *   switch lets it through because the card can no longer charge — and the
 *   bank transfer is its repayment, not a second payment. A refund recorded
 *   after the switch is not history: someone was already acting on a live card
 *   payment, and it is raised.
 *
 * Read under the lock(1) the settle loop already holds, which the card
 * settlement takes too, so the settlement it looks for has either committed or
 * not started. PRIMARY only: an ADDITIONAL card row is a booking change paid by
 * card on top of an Internet Banking booking — one price paid once.
 */
export async function findSecondInstrumentSettlement(
  tx: Prisma.TransactionClient,
  {
    paymentId,
    bookingId,
    bookingStatus,
    invoiceId,
    includeCancelled,
  }: {
    paymentId: string;
    bookingId: string;
    bookingStatus: BookingStatus;
    invoiceId: string;
    includeCancelled: boolean;
  },
) {
  const cancelled =
    includeCancelled && bookingStatus === BookingStatus.CANCELLED;
  if (!cancelled && !isPaidLikeBookingStatus(bookingStatus)) {
    return null;
  }
  let bankCashRecorded = false;
  if (cancelled) {
    bankCashRecorded =
      (await tx.paymentTransaction.findFirst({
        where: {
          paymentId,
          kind: PaymentTransactionKind.PRIMARY,
          source: PaymentSource.INTERNET_BANKING,
          status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
        },
        select: { id: true },
      })) !== null;
    if (
      bankCashRecorded &&
      (await findSettlementConflictMarker(tx, {
        bookingId,
        kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
        invoiceId,
      }))
    ) {
      return null;
    }
  }
  const captured = await tx.paymentTransaction.findMany({
    where: {
      paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: { not: PaymentSource.INTERNET_BANKING },
      status: {
        in: cancelled
          ? [...CAPTURED_TRANSACTION_STATUS_LIST]
          : [...CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST],
      },
    },
    select: {
      id: true,
      source: true,
      stripePaymentIntentId: true,
      amountCents: true,
      refundedAmountCents: true,
    },
  });
  const holding = cancelled
    ? captured
    : captured.filter(
        (transaction) => transaction.amountCents > transaction.refundedAmountCents
      );
  const candidates =
    !cancelled || bankCashRecorded
      ? await withoutRefundHistory(tx, paymentId, holding)
      : holding;
  if (candidates.length === 0) return null;

  const duplicateKeys = candidates.flatMap((transaction) =>
    transaction.stripePaymentIntentId
      ? [
          buildDuplicateCaptureRefundRecoveryIdempotencyKey(
            bookingId,
            transaction.stripePaymentIntentId,
          ),
        ]
      : []
  );
  const duplicateRefunds =
    duplicateKeys.length > 0
      ? await tx.paymentRecoveryOperation.findMany({
          where: { idempotencyKey: { in: duplicateKeys } },
          select: { idempotencyKey: true },
        })
      : [];
  const ownedByDuplicateRefund = new Set(
    duplicateRefunds.map((operation) => operation.idempotencyKey)
  );
  return (
    candidates.find(
      (transaction) =>
        !transaction.stripePaymentIntentId ||
        !ownedByDuplicateRefund.has(
          buildDuplicateCaptureRefundRecoveryIdempotencyKey(
            bookingId,
            transaction.stripePaymentIntentId,
          )
        )
    ) ?? null
  );
}

/**
 * Drop #1765 refund history: card rows with a counted refund recorded before
 * the payment's first Internet Banking PRIMARY row — the moment the booking
 * moved to Internet Banking. With no Internet Banking row nothing is dropped.
 */
async function withoutRefundHistory<
  T extends { id: string; refundedAmountCents: number },
>(tx: Prisma.TransactionClient, paymentId: string, rows: T[]): Promise<T[]> {
  const refunded = rows.filter((row) => row.refundedAmountCents > 0);
  if (refunded.length === 0) return rows;
  const movedToBank = await tx.paymentTransaction.findFirst({
    where: {
      paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.INTERNET_BANKING,
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!movedToBank) return rows;
  const earlierRefunds = await tx.paymentRefund.findMany({
    where: {
      paymentTransactionId: { in: refunded.map((row) => row.id) },
      createdAt: { lt: movedToBank.createdAt },
      status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES },
    },
    select: { paymentTransactionId: true },
  });
  const history = new Set(earlierRefunds.map((refund) => refund.paymentTransactionId));
  return rows.filter((row) => !history.has(row.id));
}

type SecondInstrumentSettlement = NonNullable<
  Awaited<ReturnType<typeof findSecondInstrumentSettlement>>
>;

/**
 * #3638: the durable record and alert for a second instrument. The bank
 * receipt was recorded, because the money did arrive; nothing was refunded,
 * credited or re-settled, because which payment goes back is the member's and
 * the treasurer's decision, and an automatic refund on a race would be a new
 * money-moving path.
 */
export async function recordSecondInstrumentSettlementConflict({
  payment,
  bookingStatus,
  settledBy,
  invoiceId,
  invoiceNumber,
  format,
}: {
  payment: ConflictPayment;
  bookingStatus: BookingStatus;
  settledBy: SecondInstrumentSettlement;
  invoiceId: string;
  invoiceNumber: string | null;
  /** The club's format (#3565), resolved before any transaction by the caller. */
  format: ClubFormat;
}) {
  const snapshot: SecondInstrumentSettlementConflictEventSnapshot = {
    kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
    invoiceId,
    invoiceNumber,
    bookingStatus,
    settledBySource: settledBy.source,
    settledByPaymentIntentId: settledBy.stripePaymentIntentId,
  };

  const holdsClaim = await recordSettlementConflictMarker({
    bookingId: payment.bookingId,
    paymentId: payment.id,
    amountCents: payment.amountCents,
    invoiceId,
    reason: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
    snapshot,
    alertCooldownKeyPrefix: "second-instrument-settlement-conflict",
  });
  if (!holdsClaim) return;

  // Its own unmuteable alert, naming the double payment, with the booking and
  // the Xero invoice one click away — not the generic "Payment Failed" mail the
  // payment-failure preference can silence.
  await sendAdminSecondInstrumentSettlementConflictAlert({
    memberName: `${bookingOwner(payment.booking).member.firstName} ${bookingOwner(payment.booking).member.lastName}`.trim(),
    checkIn: payment.booking.checkIn,
    checkOut: payment.booking.checkOut,
    bookingId: payment.bookingId,
    bookingStatus,
    bookingCancelled: bookingStatus === BookingStatus.CANCELLED,
    invoiceAmountCents: payment.amountCents,
    cardHeldCents: settledBy.amountCents - settledBy.refundedAmountCents,
    cardPaymentIntentId: settledBy.stripePaymentIntentId,
    xeroInvoiceNumber: invoiceNumber,
    // Cross-lane #2283: Xero deep links are BUILT, never hand-rolled.
    xeroInvoiceUrl: buildXeroInvoiceUrl(invoiceId),
  }, format).catch((err) =>
    logger.error(
      { err, bookingId: payment.bookingId, paymentId: payment.id, invoiceId },
      "Failed to alert admins about a booking settled by both a card payment and a Xero payment"
    )
  );
}
