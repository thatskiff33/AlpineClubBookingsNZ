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
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  sendAdminManualSettlementConflictAlert,
  sendAdminPaymentFailureAlert,
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
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";

/**
 * B5 (#2262): repeat-alert window for the reciprocal fence. A webhook replay
 * must RE-COUNT the conflict (it is still unreconciled) without re-mailing the
 * admins every time Xero redelivers the same event. #3638's second-instrument
 * conflict shares it.
 */
const MANUAL_SETTLEMENT_CONFLICT_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * The durable half shared by both inbound settlement conflicts — B5 (#2262)'s
 * reciprocal fence and #3638's second instrument. Records ONE admin-only
 * marker BookingEvent per (booking, conflict kind, invoice), then claims the
 * cross-instance alert cooldown and reports whether this caller holds it. Runs
 * AFTER the transaction: `recordBookingEvent` swallows its own failure, which
 * must never sit inside a transaction (see booking-events.ts), and the alert
 * the caller then sends is a provider call. Never changes money state.
 *
 * Self-healing rather than atomic: each conflict is DETECTED from committed
 * state under lock(1) on every delivery, so a crash between the commit and this
 * write is re-detected, and the event recorded, on the retry or replay.
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
  const alreadyRecorded = await prisma.bookingEvent
    .findFirst({
      where: {
        bookingId,
        type: BookingEventType.CANCELLED,
        snapshot: { path: ["kind"], equals: snapshot.kind },
        AND: [{ snapshot: { path: ["invoiceId"], equals: invoiceId } }],
      },
      select: { id: true },
    })
    .catch((err) => {
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

/** The booking statuses that mean "already settled" for #3638's conflict. */
const SECOND_INSTRUMENT_SETTLED_BOOKING_STATUSES = new Set<BookingStatus>([
  BookingStatus.PAID,
  // The post-stay cron flips PAID -> COMPLETED, so a late bank transfer against
  // the emailed invoice lands on a completed booking (the #2262 fence's reason).
  BookingStatus.COMPLETED,
]);

/**
 * #3638: the captured PRIMARY row of a DIFFERENT instrument — not Internet
 * Banking, so today a card payment — that still holds net cash, on a booking
 * that is already settled. Null when there is none, which is every ordinary
 * Internet Banking booking and every replay of one.
 *
 * Read under the lock(1) the settle loop already holds, which the card
 * settlement takes too, so the settlement it looks for has either committed or
 * not started. PRIMARY only: an ADDITIONAL card row is a booking change paid by
 * card on top of an Internet Banking booking — one price paid once. A fully
 * refunded capture (the #1992 duplicate-capture refund of a card that landed
 * AFTER the bank transfer) holds nothing twice.
 */
export async function findSecondInstrumentSettlement(
  tx: Prisma.TransactionClient,
  paymentId: string,
  bookingStatus: BookingStatus,
) {
  if (!SECOND_INSTRUMENT_SETTLED_BOOKING_STATUSES.has(bookingStatus)) {
    return null;
  }
  const captured = await tx.paymentTransaction.findMany({
    where: {
      paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: { not: PaymentSource.INTERNET_BANKING },
      status: {
        in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
      },
    },
    select: {
      source: true,
      stripePaymentIntentId: true,
      amountCents: true,
      refundedAmountCents: true,
    },
  });
  return (
    captured.find(
      (transaction) => transaction.amountCents > transaction.refundedAmountCents
    ) ?? null
  );
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

  const cardNetCents = settledBy.amountCents - settledBy.refundedAmountCents;
  await sendAdminPaymentFailureAlert({
    memberName: `${bookingOwner(payment.booking).member.firstName} ${bookingOwner(payment.booking).member.lastName}`.trim(),
    checkIn: payment.booking.checkIn,
    checkOut: payment.booking.checkOut,
    amountCents: payment.amountCents,
    errorMessage: `This booking may have been paid TWICE. A card payment of ${formatCents(cardNetCents, format)} had already settled it, and Xero now reports its Internet Banking invoice${invoiceNumber ? ` ${invoiceNumber}` : ""} paid as well. The bank payment has been recorded against the booking; nothing was refunded or credited automatically. Check in Xero whether that payment is separate money from the member (then agree with them which payment to refund) or the card money matched to the invoice by hand.`,
    paymentIntentId: settledBy.stripePaymentIntentId ?? invoiceId,
  }, format).catch((err) =>
    logger.error(
      { err, bookingId: payment.bookingId, paymentId: payment.id, invoiceId },
      "Failed to alert admins about a booking settled by both a card payment and a Xero payment"
    )
  );
}
