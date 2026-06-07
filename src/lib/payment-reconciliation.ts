import { prisma } from "@/lib/prisma";
import { BookingStatus, PaymentStatus, PaymentTransactionKind, Prisma } from "@prisma/client";
import {
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { bumpPendingBookings, sendBumpedNotifications } from "@/lib/bumping";
import { restoreCreditFromBooking } from "@/lib/member-credit";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

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

function isAllMemberBooking(booking: ReconciliationBooking) {
  return booking.guests.every((guest) => guest.isMember);
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        guests: true,
        member: true,
      },
    });

    if (!booking) {
      throw new Error("Booking not found");
    }

    const payment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents,
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

    if (amountCents !== booking.finalPriceCents) {
      throw new Error("Payment amount does not match booking total");
    }

    const capacity = await checkCapacityForGuestRanges(
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      booking.id,
      tx
    );

    let capacityRestored = capacity.available;
    let bumpedBookingIds: string[] = [];

    if (!capacityRestored && isAllMemberBooking(booking)) {
      const bumpResult = await bumpPendingBookings(
        booking.checkIn,
        booking.checkOut,
        booking.guests,
        tx
      );
      capacityRestored = bumpResult.capacityRestored;
      bumpedBookingIds = bumpResult.bumpedBookingIds;
    }

    if (!capacityRestored) {
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
      bumpedBookingIds,
    };
  });

  if (reconciliation.outcome === "capacity_failed") {
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

  if (reconciliation.bumpedBookingIds.length > 0) {
    const triggeringName = `${reconciliation.booking.member.firstName} ${reconciliation.booking.member.lastName}`;
    sendBumpedNotifications(
      reconciliation.bumpedBookingIds,
      triggeringName
    ).catch((err) =>
      logger.error(
        { err, bookingId, bumpedBookingIds: reconciliation.bumpedBookingIds },
        "Failed to send bump notifications after payment capacity claim"
      )
    );
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
