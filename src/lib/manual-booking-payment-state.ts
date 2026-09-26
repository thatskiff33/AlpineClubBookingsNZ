import "server-only";

import { BookingStatus, PaymentSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  isManualSettleFromPaymentStatus,
  MANUAL_CAPTURED_PAYMENT_REFUSAL,
} from "@/lib/booking-payment-state";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { isAdditionalAmountUncollected } from "@/lib/unpaid-finished-stays";
import type { BookingManualPaymentState } from "@/components/admin/booking-manual-payment-controls";

/**
 * B5 (#2262): what the admin booking page should OFFER for the cash / off-Xero
 * payment controls.
 *
 * Read-only and advisory. The server-side settlement path re-derives every one
 * of these conditions under `lock(1)` + the per-lodge lock and re-asserts the
 * expressible ones inside its fenced write, so a stale page can only ever cause
 * a 409, never a wrong write. This exists so an admin is not offered an action
 * that is certain to be refused, and is told why when it is not offered.
 */
const PAYABLE_STATUSES: BookingStatus[] = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PENDING,
  BookingStatus.DRAFT,
];

export async function getBookingManualPaymentState(
  bookingId: string
): Promise<BookingManualPaymentState | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      finalPriceCents: true,
      organiserSettled: true,
      // #2265 (#2262 delta MED-3): the member's stored, unconsumed credit
      // election. Advisory only — the settle re-reads it under the locks — but
      // the dialog must be able to warn BEFORE the cash is recorded, because
      // that click is the last preventable moment.
      creditElectionCents: true,
      payment: {
        select: {
          id: true,
          // #2397: a payment that has already taken money cannot also be
          // recorded as cash. Restated here rather than imported, like every
          // other guard in this advisory module — see the header note.
          status: true,
          // #2397: the upward-modification delta and whether it was ever
          // collected. Advisory, like everything else here — the settle
          // re-derives it under the locks and 409s on a mismatch — but the
          // dialog cannot ask about an extra it does not know exists.
          additionalAmountCents: true,
          additionalPaymentStatus: true,
          xeroInvoiceId: true,
          xeroRefundCreditNoteId: true,
          refundedAmountCents: true,
          internetBankingHoldUntil: true,
          manuallyMarkedPaidAt: true,
          manualPaymentNote: true,
          manuallyMarkedPaidBy: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!booking) return null;

  const payment = booking.payment;
  const appliedCredit = await prisma.memberCredit.aggregate({
    where: { appliedToBookingId: booking.id, type: "BOOKING_APPLIED" },
    _sum: { amountCents: true },
  });
  const creditAppliedCents = Math.max(0, -(appliedCredit._sum.amountCents ?? 0));
  const amountOwingCents = booking.finalPriceCents - creditAppliedCents;

  const manuallyMarkedPaidAt = payment?.manuallyMarkedPaidAt ?? null;
  const manuallyMarkedPaidByName = payment?.manuallyMarkedPaidBy
    ? `${payment.manuallyMarkedPaidBy.firstName} ${payment.manuallyMarkedPaidBy.lastName}`
    : null;

  // Xero evidence — the same set the settle-time refusal reads, minus the
  // in-flight-mint lookup, which the server re-checks under the lock.
  let xeroBlocked = false;
  if (payment) {
    if (payment.xeroInvoiceId || payment.xeroRefundCreditNoteId) {
      xeroBlocked = true;
    } else {
      const [stampedTransaction, activeLink, mintOperation] = await Promise.all([
        prisma.paymentTransaction.findFirst({
          where: { paymentId: payment.id, xeroInvoiceId: { not: null } },
          select: { id: true },
        }),
        prisma.xeroObjectLink.findFirst({
          where: {
            localModel: "Payment",
            localId: payment.id,
            xeroObjectType: "INVOICE",
            role: "PRIMARY_INVOICE",
            active: true,
          },
          select: { id: true },
        }),
        prisma.xeroSyncOperation.findFirst({
          where: {
            direction: "OUTBOUND",
            entityType: "INVOICE",
            operationType: "CREATE",
            localModel: "Payment",
            localId: payment.id,
            status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT", "SUCCEEDED"] },
          },
          select: { id: true },
        }),
      ]);
      xeroBlocked = Boolean(stampedTransaction || activeLink || mintOperation);
    }
  }

  // #2397: the three PAYMENT-level refusals in this chain — refund history,
  // then already-captured, then Xero evidence — are ordered EXACTLY as
  // `prepareManualSettlement` (src/lib/payment-reconciliation.ts) orders them,
  // so a booking that trips more than one is told the same thing before the
  // click and after it. The reasons for that order are recorded there; change
  // both files together. (The booking-level reasons above are this page's own:
  // a manually settled booking is PAID, and naming the manual settlement is
  // more useful to an admin than "already paid".)
  let markPaidBlockedReason: string | null = null;
  if (manuallyMarkedPaidAt) {
    markPaidBlockedReason =
      "This booking's payment is already recorded as a manual settlement.";
  } else if (booking.status === BookingStatus.PAID) {
    markPaidBlockedReason = "This booking is already paid.";
  } else if (!PAYABLE_STATUSES.includes(booking.status)) {
    markPaidBlockedReason = `This booking cannot be paid from status ${booking.status}.`;
  } else if (booking.organiserSettled) {
    markPaidBlockedReason =
      "This booking was settled as part of a group booking — record the payment against the group settlement instead.";
  } else if ((payment?.refundedAmountCents ?? 0) !== 0) {
    markPaidBlockedReason =
      "This booking's payment already carries refund history — it cannot be recorded as a manual settlement. Cancel and rebook, or resolve the refund first.";
  } else if (payment && !isManualSettleFromPaymentStatus(payment.status)) {
    // #2397: the advisory twin of `prepareManualSettlement`'s captured-payment
    // refusal. A card capture that stranded before its status promotion (#1418)
    // leaves a payable booking holding a SUCCEEDED payment — and an upward
    // modification in that window is the one non-circular way a booking here
    // acquires an uncollected extra. Without this the whole dialog opened,
    // asked the admin whether the cash covered that extra, and then refused
    // every answer with a message that said the booking had changed when
    // nothing had.
    markPaidBlockedReason = MANUAL_CAPTURED_PAYMENT_REFUSAL;
  } else if (xeroBlocked) {
    markPaidBlockedReason =
      "This booking has a Xero invoice (or one on its way) — record the payment against the invoice in Xero instead.";
  } else if (amountOwingCents <= 0) {
    markPaidBlockedReason =
      "This booking has nothing owing — use Force confirm / Confirm pending guests instead.";
  }

  let reverseBlockedReason: string | null = null;
  if (manuallyMarkedPaidAt) {
    if (booking.status !== BookingStatus.PAID) {
      reverseBlockedReason =
        "This booking is no longer paid — cancel the booking instead.";
    } else if ((payment?.refundedAmountCents ?? 0) !== 0) {
      reverseBlockedReason =
        "Money has already been refunded against this payment — cancel the booking instead.";
    } else if (xeroBlocked) {
      reverseBlockedReason =
        "A Xero invoice has since been raised for this booking — reconcile it in Xero instead.";
    } else if (payment) {
      const [openTask, settledStripe] = await Promise.all([
        prisma.manualRefundTask.findFirst({
          where: { paymentId: payment.id, status: "OPEN" },
          select: { id: true },
        }),
        prisma.paymentTransaction.findFirst({
          where: {
            paymentId: payment.id,
            source: PaymentSource.STRIPE,
            status: {
              in: [...CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST],
            },
          },
          select: { id: true },
        }),
      ]);
      if (openTask) {
        reverseBlockedReason =
          "There is an open manual refund task for this payment — resolve it before reversing the settlement.";
      } else if (settledStripe) {
        reverseBlockedReason =
          "A card payment has since settled this booking — reversing the manual record would misstate the ledger.";
      }
    }
  }

  return {
    amountOwingCents,
    // #2397. The same MONEY-half predicate the settle uses; the booking-status
    // half is constant-true here because recording this payment always lands the
    // booking on PAID (see isAdditionalAmountUncollected).
    outstandingAdditionalCents: isAdditionalAmountUncollected(payment)
      ? payment.additionalAmountCents
      : 0,
    storedCreditElectionCents: booking.creditElectionCents,
    canMarkPaid: markPaidBlockedReason === null,
    markPaidBlockedReason,
    manuallyMarkedPaidAt: manuallyMarkedPaidAt
      ? manuallyMarkedPaidAt.toISOString()
      : null,
    manuallyMarkedPaidByName,
    manualPaymentNote: payment?.manualPaymentNote ?? null,
    canReverse: manuallyMarkedPaidAt !== null && reverseBlockedReason === null,
    reverseBlockedReason,
  };
}
