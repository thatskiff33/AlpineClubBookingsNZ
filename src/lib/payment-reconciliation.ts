import { prisma } from "@/lib/prisma";
import {
  BookingEventType,
  BookingStatus,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import {
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  deriveBookingAppliedCreditCents,
  restoreCreditFromBooking,
} from "@/lib/member-credit";
import { recordBookingEvent } from "@/lib/booking-events";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getDefaultLodgeId } from "@/lib/lodges";

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
    | "cancelled_refund_failed";
  bookingId: string;
  bumpedBookingIds: string[];
  refundError?: string;
};

const PAYABLE_SUCCESS_STATUSES = new Set<string>([
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PENDING,
  BookingStatus.DRAFT,
]);

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
  const reconciliation = await prisma.$transaction(async (tx) => {
    // Pre-lock read: only the lock key. lodgeId is immutable, so keying the
    // lock from this read is safe; every status/capacity-relevant field is
    // taken from the post-lock re-read below.
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

    // #1641 — split the captured amount into cash + credit so the mirror invariant
    // `amountCents + creditAppliedCents = finalPriceCents` holds for BOTH a new
    // effective capture (credit = applied) and a legacy full-price capture
    // (credit = 0, repaired locally by the audit — never a Xero over-allocation).
    // This is derived from the captured amount alone; the ledger is only read below
    // when the amount is NOT the full price (to admit the effective capture).
    const mirrorCreditAppliedCents = Math.max(
      0,
      booking.finalPriceCents - amountCents
    );

    const payment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents,
        creditAppliedCents: mirrorCreditAppliedCents,
        status: PaymentStatus.PENDING,
      },
      update: {},
    });

    await upsertPaymentIntentTransaction({
      paymentId: payment.id,
      kind: PaymentTransactionKind.PRIMARY,
      paymentIntentId,
      amountCents,
      status: PaymentStatus.SUCCEEDED,
      paymentMethodId,
      store: tx,
    });

    if (booking.status === BookingStatus.PAID) {
      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });
      return {
        outcome: "already_paid" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
      };
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
    if (amountCents !== booking.finalPriceCents) {
      const appliedCreditCents = await deriveBookingAppliedCreditCents(
        booking.id,
        tx
      );
      if (amountCents !== booking.finalPriceCents - appliedCreditCents) {
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
    if (!capacity.available) {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.CANCELLED,
          draftExpiresAt: null,
        },
      });
      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      await restoreCreditFromBooking(booking.memberId, booking.id, tx);

      return {
        outcome: "capacity_failed" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
      };
    }

    await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
    await reconcileBedAllocationsForBooking({
      bookingId: booking.id,
      db: tx,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    return {
      outcome: "paid" as const,
      booking,
      paymentId: payment.id,
      bumpedBookingIds: [] as string[],
    };
  });

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

    try {
      await refundPaymentTransactions({
        paymentId: reconciliation.paymentId,
        amountCents,
        reason: "requested_by_customer",
        metadata: {
          bookingId,
          paymentIntentId,
          reason: "capacity_claim_failed",
        },
        idempotencyKeyPrefix: `capacity_claim_failed_${bookingId}_${paymentIntentId}`,
      });

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
      logger.error(
        { err: refundError, bookingId, paymentIntentId },
        "Failed to auto-refund booking after final capacity claim failed"
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
