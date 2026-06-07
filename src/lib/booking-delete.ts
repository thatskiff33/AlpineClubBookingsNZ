import {
  BookingStatus,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { deleteDraftBookingDependents } from "@/lib/draft-booking-cleanup";
import { prisma } from "@/lib/prisma";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

type BookingDeleteDb = Prisma.TransactionClient | typeof prisma;

type BookingDeleteActor = {
  memberId: string;
  role: string;
  ipAddress?: string | null;
};

export type BookingDeleteBlocker = {
  code: string;
  label: string;
  count: number;
};

export type DeleteBookingResult =
  | {
      status: 200;
      data: {
        success: true;
        mode: "hard-delete" | "soft-delete";
        bookingId: string;
        message: string;
      };
    }
  | { status: 400 | 403 | 404 | 409; error: string; blockers?: BookingDeleteBlocker[] };

type BookingForDelete = NonNullable<
  Awaited<ReturnType<typeof loadBookingForDelete>>
>;

const CAPTURED_PAYMENT_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
]);

export async function deleteBooking(input: {
  bookingId: string;
  actor: BookingDeleteActor;
  reason?: string | null;
}): Promise<DeleteBookingResult> {
  const booking = await loadBookingForDelete(prisma, input.bookingId);

  if (!booking) {
    return { status: 404, error: "Booking not found" };
  }

  if (booking.deletedAt && input.actor.role !== "ADMIN") {
    return { status: 404, error: "Booking not found" };
  }

  if (booking.status === BookingStatus.DRAFT) {
    if (
      booking.memberId !== input.actor.memberId &&
      input.actor.role !== "ADMIN"
    ) {
      return { status: 403, error: "Forbidden" };
    }

    return hardDeleteDraftBooking(input.bookingId, input.actor);
  }

  if (booking.status === BookingStatus.CANCELLED) {
    if (input.actor.role !== "ADMIN") {
      return {
        status: 403,
        error: "Only admins can delete cancelled bookings",
      };
    }

    const reason = input.reason?.trim();
    if (!reason) {
      return {
        status: 400,
        error: "A deletion reason is required for cancelled bookings",
      };
    }

    return softDeleteCancelledBooking(input.bookingId, input.actor, reason);
  }

  return {
    status: 400,
    error: "Only draft bookings and eligible cancelled bookings can be deleted",
  };
}

async function hardDeleteDraftBooking(
  bookingId: string,
  actor: BookingDeleteActor
): Promise<DeleteBookingResult> {
  return prisma.$transaction(async (tx) => {
    const booking = await loadBookingForDelete(tx, bookingId);

    if (!booking) {
      return { status: 404, error: "Booking not found" };
    }
    if (booking.status !== BookingStatus.DRAFT) {
      return {
        status: 400,
        error: "Only draft bookings can be hard-deleted",
      };
    }
    if (booking.memberId !== actor.memberId && actor.role !== "ADMIN") {
      return { status: 403, error: "Forbidden" };
    }

    await createAuditLog(
      {
        action: "booking.delete.draft",
        memberId: actor.memberId,
        targetId: booking.id,
        subjectMemberId: booking.memberId,
        entityType: "Booking",
        entityId: booking.id,
        category: "booking",
        severity: "critical",
        outcome: "success",
        summary: "Draft booking hard-deleted",
        details: "Draft booking hard-deleted before confirmation or payment",
        metadata: {
          mode: "hard-delete",
          booking: buildBookingSnapshot(booking),
        },
        ipAddress: actor.ipAddress ?? undefined,
      },
      tx
    );

    await deleteDraftBookingDependents(tx, [booking]);

    await tx.booking.delete({ where: { id: booking.id } });

    return {
      status: 200,
      data: {
        success: true,
        mode: "hard-delete",
        bookingId: booking.id,
        message: "Draft booking deleted",
      },
    };
  });
}

async function softDeleteCancelledBooking(
  bookingId: string,
  actor: BookingDeleteActor,
  reason: string
): Promise<DeleteBookingResult> {
  return prisma.$transaction(async (tx) => {
    const booking = await loadBookingForDelete(tx, bookingId);

    if (!booking) {
      return { status: 404, error: "Booking not found" };
    }
    if (booking.status !== BookingStatus.CANCELLED) {
      return {
        status: 400,
        error: "Only cancelled bookings can be soft-deleted",
      };
    }
    if (booking.deletedAt) {
      return {
        status: 409,
        error: "Booking has already been deleted",
      };
    }

    const blockers = await getCancelledBookingDeleteBlockers(tx, booking);
    if (blockers.length > 0) {
      return {
        status: 409,
        error:
          "Cancelled booking cannot be deleted because financial or Xero history exists",
        blockers,
      };
    }

    const deletedAt = new Date();
    await createAuditLog(
      {
        action: "booking.delete.cancelled.soft",
        memberId: actor.memberId,
        targetId: booking.id,
        subjectMemberId: booking.memberId,
        entityType: "Booking",
        entityId: booking.id,
        category: "booking",
        severity: "critical",
        outcome: "success",
        summary: "Cancelled booking soft-deleted",
        details: reason,
        metadata: {
          mode: "soft-delete",
          deletedAt: deletedAt.toISOString(),
          reason,
          booking: buildBookingSnapshot(booking),
        },
        ipAddress: actor.ipAddress ?? undefined,
      },
      tx
    );

    await tx.booking.update({
      where: { id: booking.id },
      data: {
        deletedAt,
        deletedById: actor.memberId,
        deletedReason: reason,
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
      status: 200,
      data: {
        success: true,
        mode: "soft-delete",
        bookingId: booking.id,
        message: "Cancelled booking deleted",
      },
    };
  });
}

async function loadBookingForDelete(db: BookingDeleteDb, bookingId: string) {
  return db.booking.findUnique({
    where: { id: bookingId },
    include: {
      promoRedemption: {
        select: {
          id: true,
          promoCodeId: true,
          discountCents: true,
          freeNightsUsed: true,
          eligibleGuestCount: true,
        },
      },
      guests: {
        select: {
          id: true,
          ageTier: true,
          isMember: true,
          priceCents: true,
          stayStart: true,
          stayEnd: true,
        },
      },
      payment: {
        select: {
          id: true,
          status: true,
          amountCents: true,
          refundedAmountCents: true,
          changeFeeCents: true,
          additionalAmountCents: true,
          additionalPaymentStatus: true,
          creditAppliedCents: true,
          stripePaymentIntentId: true,
          additionalPaymentIntentId: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
          xeroRefundCreditNoteId: true,
        },
      },
      modifications: {
        select: {
          id: true,
          modificationType: true,
          priceDiffCents: true,
          changeFeeCents: true,
          createdAt: true,
        },
      },
      _count: {
        select: {
          guests: true,
          changeRequests: true,
          refundRequests: true,
          paymentRecoveryOperations: true,
        },
      },
    },
  });
}

async function getCancelledBookingDeleteBlockers(
  tx: Prisma.TransactionClient,
  booking: BookingForDelete
) {
  const blockers: BookingDeleteBlocker[] = [];
  const paymentId = booking.payment?.id;
  const modificationIds = booking.modifications.map((modification) => modification.id);
  const xeroRecordScopes = [
    { localModel: "Booking", localId: booking.id },
    ...(paymentId ? [{ localModel: "Payment", localId: paymentId }] : []),
    ...modificationIds.map((localId) => ({
      localModel: "BookingModification",
      localId,
    })),
  ];

  const [
    financialPaymentTransactionCount,
    paymentRefundCount,
    refundRequestCount,
    memberCreditCount,
    paymentRecoveryCount,
    xeroObjectLinkCount,
    xeroSyncOperationCount,
  ] = await Promise.all([
    paymentId
      ? tx.paymentTransaction.count({
          where: {
            paymentId,
            OR: [
              { status: { in: Array.from(CAPTURED_PAYMENT_STATUSES) } },
              { refundedAmountCents: { gt: 0 } },
            ],
          },
        })
      : Promise.resolve(0),
    paymentId ? tx.paymentRefund.count({ where: { paymentId } }) : Promise.resolve(0),
    tx.refundRequest.count({ where: { bookingId: booking.id } }),
    tx.memberCredit.count({
      where: {
        OR: [
          { sourceBookingId: booking.id },
          { appliedToBookingId: booking.id },
        ],
      },
    }),
    tx.paymentRecoveryOperation.count({
      where: { bookingId: booking.id },
    }),
    tx.xeroObjectLink.count({
      where: { OR: xeroRecordScopes },
    }),
    tx.xeroSyncOperation.count({
      where: { OR: xeroRecordScopes },
    }),
  ]);

  addBlocker(
    blockers,
    "captured_payment",
    "Captured, refunded, or credited payment exists",
    hasCapturedOrCreditedPayment(booking.payment) ? 1 : 0
  );
  addBlocker(
    blockers,
    "payment_transaction",
    "Captured or refunded payment transaction history exists",
    financialPaymentTransactionCount
  );
  addBlocker(
    blockers,
    "payment_refund",
    "Payment refund history exists",
    paymentRefundCount
  );
  addBlocker(
    blockers,
    "refund_request",
    "Refund request history exists",
    refundRequestCount
  );
  addBlocker(
    blockers,
    "member_credit",
    "Member credit history exists",
    memberCreditCount
  );
  addBlocker(
    blockers,
    "xero_payment_reference",
    "Xero payment reference exists",
    hasXeroPaymentReference(booking.payment) ? 1 : 0
  );
  addBlocker(
    blockers,
    "xero_object_link",
    "Xero object link exists",
    xeroObjectLinkCount
  );
  addBlocker(
    blockers,
    "xero_sync_operation",
    "Xero sync or outbox history exists",
    xeroSyncOperationCount
  );
  addBlocker(
    blockers,
    "payment_recovery",
    "Payment recovery history exists",
    paymentRecoveryCount
  );
  addBlocker(
    blockers,
    "financial_modification",
    "Booking modification with financial effect exists",
    booking.modifications.filter(
      (modification) =>
        modification.priceDiffCents !== 0 || modification.changeFeeCents !== 0
    ).length
  );

  return blockers;
}

function addBlocker(
  blockers: BookingDeleteBlocker[],
  code: string,
  label: string,
  count: number
) {
  if (count > 0) {
    blockers.push({ code, label, count });
  }
}

function hasCapturedOrCreditedPayment(
  payment: BookingForDelete["payment"]
): boolean {
  if (!payment) {
    return false;
  }

  return (
    CAPTURED_PAYMENT_STATUSES.has(payment.status) ||
    payment.refundedAmountCents > 0 ||
    payment.creditAppliedCents > 0 ||
    payment.additionalPaymentStatus === "SUCCEEDED"
  );
}

function hasXeroPaymentReference(payment: BookingForDelete["payment"]): boolean {
  if (!payment) {
    return false;
  }

  return Boolean(
    payment.xeroInvoiceId ||
      payment.xeroInvoiceNumber ||
      payment.xeroRefundCreditNoteId
  );
}

function buildBookingSnapshot(booking: BookingForDelete) {
  return {
    id: booking.id,
    memberId: booking.memberId,
    status: booking.status,
    checkIn: booking.checkIn.toISOString(),
    checkOut: booking.checkOut.toISOString(),
    totalPriceCents: booking.totalPriceCents,
    discountCents: booking.discountCents,
    finalPriceCents: booking.finalPriceCents,
    hasNonMembers: booking.hasNonMembers,
    draftExpiresAt: booking.draftExpiresAt?.toISOString() ?? null,
    deletedAt: booking.deletedAt?.toISOString() ?? null,
    deletedById: booking.deletedById,
    guestCount: booking._count.guests,
    changeRequestCount: booking._count.changeRequests,
    refundRequestCount: booking._count.refundRequests,
    paymentRecoveryOperationCount: booking._count.paymentRecoveryOperations,
    paymentId: booking.payment?.id ?? null,
    promoRedemption: booking.promoRedemption
      ? {
          id: booking.promoRedemption.id,
          promoCodeId: booking.promoRedemption.promoCodeId,
          discountCents: booking.promoRedemption.discountCents,
          freeNightsUsed: booking.promoRedemption.freeNightsUsed,
          eligibleGuestCount: booking.promoRedemption.eligibleGuestCount,
        }
      : null,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}
