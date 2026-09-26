/**
 * The two inbound settlement conflicts the Xero invoice-paid loop raises
 * instead of settling quietly, and the one durable record they share.
 *
 * - B5 (#2262)'s reciprocal fence: Xero reports PAID on a booking an admin had
 *   already recorded as settled in cash / by an off-Xero bank transfer.
 * - #3638's second instrument: Xero reports PAID on a booking a card payment
 *   had already settled (`INV-PAY-102`).
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
  asSecondInstrumentSettlementConflictSnapshot,
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
 * The marker already recorded for (booking, conflict kind, invoice), if any:
 * the dedupe read before #2262's post-commit marker is written.
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
 * B5 (#2262)'s durable half. Records ONE admin-only marker BookingEvent per
 * (booking, conflict kind, invoice), then claims the cross-instance alert
 * cooldown and reports whether this caller holds it. Runs AFTER the
 * transaction: `recordBookingEvent` swallows its own failure, which must never
 * sit inside a transaction (see booking-events.ts), and the alert the caller
 * then sends is a provider call. Never changes money state.
 *
 * Self-healing rather than atomic: the #2262 fence is detected from committed
 * state on every delivery, so a crash between the commit and this write is
 * re-detected on the retry. #3638's second instrument does NOT use this: a
 * cancelled booking's conflict cannot be re-detected once its receipt is
 * recorded, so its marker is written inside the transaction instead
 * (`recordSecondInstrumentMarkerInTransaction`).
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
 * WHICH second-instrument conflict this is — it decides what the alert says.
 *
 * - `settled`: a card payment settled a PAID / COMPLETED booking, and Xero
 *   reports the invoice paid too — it may have been paid twice.
 * - `cancelledAfterCard`: a card payment settled the booking, the booking was
 *   cancelled (settling that card money under its policy), and the bank cash
 *   arrived afterwards.
 * - `cancelledAfterRefund`: #1765 — the card payment had been refunded before
 *   the booking moved to Internet Banking, the booking was cancelled, and the
 *   bank cash arrived afterwards. Nothing was paid twice; the bank money has
 *   nowhere to go.
 */
export type SecondInstrumentConflictKind =
  | "settled"
  | "cancelledAfterCard"
  | "cancelledAfterRefund";

/** What the detector found, and what the marker and alert are built from. */
export type SecondInstrumentSettlement = {
  source: PaymentSource;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
  conflictKind: SecondInstrumentConflictKind;
};

/**
 * #3638: the captured PRIMARY row of a DIFFERENT instrument — not Internet
 * Banking, so today a card payment — on a booking that instrument already
 * settled. Null when there is none, which is every ordinary Internet Banking
 * booking and every replay of one.
 *
 * - PAID / COMPLETED: the card row must still hold net cash — a capture
 *   refunded in full holds nothing twice — and #1765 refund history (a card row
 *   with a refund recorded before the booking moved to Internet Banking) is a
 *   repay-after-refund booking whose bank transfer is its repayment, not a
 *   second payment. A refund recorded after the switch is somebody acting on a
 *   live card payment, and is still raised.
 * - CANCELLED (only with `includeCancelled`, the pre-settlement read), while
 *   the bank cash is NEW: any capture, refunded or not, because this bank cash
 *   has nowhere to go — the credit-mint arm mints only for a payment that never
 *   settled. Once the bank cash is RECORDED (a captured Internet Banking PRIMARY
 *   row exists) it is null — a bank-first booking's replay must stay quiet —
 *   UNLESS this invoice's marker exists with its alert not yet confirmed sent,
 *   in which case the conflict is returned again from the marker so the alert
 *   is re-driven. The marker is written in the same transaction as the
 *   receipt (`recordSecondInstrumentMarkerInTransaction`), so "receipt
 *   recorded and no marker" really does mean no conflict was ever raised.
 *
 * Never a capture the #1992 duplicate-capture refund owns: the opposite order
 * (bank first, card second), whose durable refund operation already says which
 * side goes back (`INV-PAY-043`).
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
): Promise<SecondInstrumentSettlement | null> {
  const cancelled =
    includeCancelled && bookingStatus === BookingStatus.CANCELLED;
  if (!cancelled && !isPaidLikeBookingStatus(bookingStatus)) {
    return null;
  }
  if (cancelled) {
    const bankCashRecorded = await tx.paymentTransaction.findFirst({
      where: {
        paymentId,
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.INTERNET_BANKING,
        status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
      },
      select: { id: true },
    });
    if (bankCashRecorded) {
      const marker = await findSecondInstrumentMarker(tx, { bookingId, invoiceId });
      return marker && !marker.snapshot.alertSentAt
        ? settlementFromMarker(marker.snapshot)
        : null;
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
  if (holding.length === 0) return null;
  const history = await refundHistoryIds(tx, paymentId, holding);
  // PAID / COMPLETED drop #1765 history; a cancelled booking keeps it (the new
  // bank cash still has nowhere to go) and prefers a real card settlement.
  const candidates = cancelled
    ? [...holding].sort(
        (a, b) => Number(history.has(a.id)) - Number(history.has(b.id)),
      )
    : holding.filter((transaction) => !history.has(transaction.id));
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
  const settledBy = candidates.find(
    (transaction) =>
      !transaction.stripePaymentIntentId ||
      !ownedByDuplicateRefund.has(
        buildDuplicateCaptureRefundRecoveryIdempotencyKey(
          bookingId,
          transaction.stripePaymentIntentId,
        )
      )
  );
  if (!settledBy) return null;
  return {
    source: settledBy.source,
    stripePaymentIntentId: settledBy.stripePaymentIntentId,
    amountCents: settledBy.amountCents,
    refundedAmountCents: settledBy.refundedAmountCents,
    conflictKind: !cancelled
      ? "settled"
      : history.has(settledBy.id)
        ? "cancelledAfterRefund"
        : "cancelledAfterCard",
  };
}

/**
 * #1765 refund history: the ids of card rows with a counted refund recorded
 * before the payment's first Internet Banking PRIMARY row — the moment the
 * booking moved to Internet Banking. Empty with no Internet Banking row.
 */
async function refundHistoryIds(
  tx: Prisma.TransactionClient,
  paymentId: string,
  rows: readonly { id: string; refundedAmountCents: number }[],
): Promise<Set<string>> {
  const refunded = rows.filter((row) => row.refundedAmountCents > 0);
  if (refunded.length === 0) return new Set();
  const movedToBank = await tx.paymentTransaction.findFirst({
    where: {
      paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.INTERNET_BANKING,
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!movedToBank) return new Set();
  const earlierRefunds = await tx.paymentRefund.findMany({
    where: {
      paymentTransactionId: { in: refunded.map((row) => row.id) },
      createdAt: { lt: movedToBank.createdAt },
      status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES },
    },
    select: { paymentTransactionId: true },
  });
  return new Set(
    earlierRefunds.flatMap((refund) =>
      refund.paymentTransactionId ? [refund.paymentTransactionId] : [],
    ),
  );
}

type SecondInstrumentMarker = {
  id: string;
  snapshot: SecondInstrumentSettlementConflictEventSnapshot;
};

/** This invoice's second-instrument marker for the booking, if any. */
async function findSecondInstrumentMarker(
  store: Pick<Prisma.TransactionClient, "bookingEvent">,
  { bookingId, invoiceId }: { bookingId: string; invoiceId: string },
): Promise<SecondInstrumentMarker | null> {
  const row = await store.bookingEvent.findFirst({
    where: {
      bookingId,
      type: BookingEventType.CANCELLED,
      snapshot: {
        path: ["kind"],
        equals: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
      },
      AND: [{ snapshot: { path: ["invoiceId"], equals: invoiceId } }],
    },
    select: { id: true, snapshot: true },
  });
  const snapshot = row ? asSecondInstrumentSettlementConflictSnapshot(row.snapshot) : null;
  return row && snapshot ? { id: row.id, snapshot } : null;
}

function settlementFromMarker(
  snapshot: SecondInstrumentSettlementConflictEventSnapshot,
): SecondInstrumentSettlement {
  return {
    source: snapshot.settledBySource as PaymentSource,
    stripePaymentIntentId: snapshot.settledByPaymentIntentId,
    amountCents: snapshot.cardAmountCents,
    refundedAmountCents: snapshot.cardRefundedAmountCents,
    conflictKind: snapshot.conflictKind,
  };
}

/**
 * #3638: the durable conflict record, written INSIDE the settle transaction so
 * it commits or rolls back with the bank receipt. A crash after the commit
 * therefore always leaves the marker behind, with its alert not yet confirmed
 * sent, and the retry re-drives the alert from it (see
 * `findSecondInstrumentSettlement`). Once per (booking, invoice): the dedupe
 * read runs under the settle loop's lock(1), so two deliveries cannot both
 * write one.
 *
 * A direct `tx.bookingEvent.create`, deliberately NOT `recordBookingEvent`:
 * that helper swallows a failed insert, which inside a transaction would leave
 * it aborted. Here a failed insert propagates and rolls the receipt back, and
 * the delivery is retried — the outcome this record exists for. The exception
 * is recorded at the ban in `booking-events.ts`.
 */
export async function recordSecondInstrumentMarkerInTransaction(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    amountCents,
    bookingStatus,
    invoiceId,
    invoiceNumber,
    settledBy,
  }: {
    bookingId: string;
    amountCents: number;
    bookingStatus: BookingStatus;
    invoiceId: string;
    invoiceNumber: string | null;
    settledBy: SecondInstrumentSettlement;
  },
): Promise<SecondInstrumentMarker> {
  const existing = await findSecondInstrumentMarker(tx, { bookingId, invoiceId });
  if (existing) return existing;
  const snapshot: SecondInstrumentSettlementConflictEventSnapshot = {
    kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
    invoiceId,
    invoiceNumber,
    bookingStatus,
    conflictKind: settledBy.conflictKind,
    settledBySource: settledBy.source,
    settledByPaymentIntentId: settledBy.stripePaymentIntentId,
    cardAmountCents: settledBy.amountCents,
    cardRefundedAmountCents: settledBy.refundedAmountCents,
    alertSentAt: null,
  };
  const created = await tx.bookingEvent.create({
    data: {
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: null,
      amountCents,
      reason: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { id: created.id, snapshot };
}

/**
 * How long one sender holds the right to send a marker's alert. Long enough to
 * cover an SES call, so concurrent post-commit senders do not both mail; short
 * enough that a process killed mid-send leaves the alert to the next delivery
 * within minutes rather than a day.
 */
const SECOND_INSTRUMENT_ALERT_IN_FLIGHT_MS = 10 * 60 * 1000;

/**
 * #3638: the alert for a second instrument, after the settle transaction has
 * committed. Sent ONCE per marker: skipped when the marker records it as sent,
 * and recorded on the marker (`alertSentAt`) only after the send succeeds, so
 * a crash or a failed send leaves it to be re-sent on the next delivery of the
 * invoice. The bank receipt was recorded, because the money did arrive;
 * nothing was refunded, credited or re-settled — which payment goes back is the
 * member's and the treasurer's decision.
 */
export async function raiseSecondInstrumentSettlementAlert({
  payment,
  marker,
  invoiceId,
  format,
}: {
  payment: ConflictPayment;
  marker: SecondInstrumentMarker;
  invoiceId: string;
  /** The club's format (#3565), resolved before any transaction by the caller. */
  format: ClubFormat;
}) {
  if (marker.snapshot.alertSentAt) return;
  const holdsClaim = await claimAlertCooldown({
    key: `second-instrument-alert:${marker.id}`,
    windowMs: SECOND_INSTRUMENT_ALERT_IN_FLIGHT_MS,
  }).catch((err) => {
    logger.error(
      { err, markerId: marker.id, invoiceId },
      "Failed to claim the second-instrument alert; sending anyway rather than staying silent about unreconciled money"
    );
    return true;
  });
  if (!holdsClaim) return;

  const { snapshot } = marker;
  try {
    // Its own unmuteable alert, with the booking and the Xero invoice one
    // click away — not the generic "Payment Failed" mail the payment-failure
    // preference can silence.
    await sendAdminSecondInstrumentSettlementConflictAlert({
      memberName: `${bookingOwner(payment.booking).member.firstName} ${bookingOwner(payment.booking).member.lastName}`.trim(),
      checkIn: payment.booking.checkIn,
      checkOut: payment.booking.checkOut,
      bookingId: payment.bookingId,
      bookingStatus: snapshot.bookingStatus,
      conflictKind: snapshot.conflictKind,
      invoiceAmountCents: payment.amountCents,
      cardHeldCents: snapshot.cardAmountCents - snapshot.cardRefundedAmountCents,
      cardPaymentIntentId: snapshot.settledByPaymentIntentId,
      xeroInvoiceNumber: snapshot.invoiceNumber,
      // Cross-lane #2283: Xero deep links are BUILT, never hand-rolled.
      xeroInvoiceUrl: buildXeroInvoiceUrl(invoiceId),
    }, format);
  } catch (err) {
    logger.error(
      { err, bookingId: payment.bookingId, paymentId: payment.id, invoiceId },
      "Failed to alert admins about a booking settled by both a card payment and a Xero payment; the marker keeps it pending for the next delivery"
    );
    return;
  }

  await prisma.bookingEvent
    .update({
      where: { id: marker.id },
      data: {
        snapshot: {
          ...snapshot,
          alertSentAt: new Date().toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    })
    .catch((err) =>
      logger.error(
        { err, markerId: marker.id, invoiceId },
        "Sent the second-instrument alert but could not record it on the marker; the next delivery may send it once more"
      )
    );
}
