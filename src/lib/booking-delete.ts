import {
  BookingStatus,
  CreditType,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";
import { createAuditLog, logAudit } from "@/lib/audit";
import { deleteDraftBookingDependents } from "@/lib/draft-booking-cleanup";
import logger from "@/lib/logger";
import { markPaymentIntentTransactionFailed } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { cancelPaymentIntentIfCancellableWithResult } from "@/lib/stripe";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import { formatCents } from "@/lib/utils";

type BookingDeleteDb = Prisma.TransactionClient | typeof prisma;

type BookingDeleteActor = {
  memberId: string;
  role: string;
  ipAddress?: string | null;
};

type BookingDeleteBlocker = {
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
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
  const outcome = await softDeleteCancelledBookingInTransaction(
    bookingId,
    actor,
    reason
  );

  // #2700 — the deletion is committed; now make sure nothing can still be paid
  // against it. See `cancelInFlightPaymentIntentsAfterSoftDelete` for why this
  // is here at all and why it runs AFTER the commit.
  if (outcome.result.status === 200) {
    await cancelInFlightPaymentIntentsAfterSoftDelete(
      bookingId,
      outcome.payment,
      actor
    );
  }

  return outcome.result;
}

type SoftDeleteOutcome = {
  result: DeleteBookingResult;
  payment: BookingForDelete["payment"] | null;
};

/**
 * Close the window in which money can still be captured against a booking the
 * club has just deleted (#2700, owner decision 10 Aug 2026, part 1).
 *
 * THE RACE THIS EXISTS FOR. An admin deletes a cancelled booking while its
 * owner is sitting on the Stripe payment page for a modification. Deletion does
 * not touch Stripe, so the PaymentIntent stays live and the member can still
 * pay. `getCancelledBookingDeleteBlockers` cannot prevent it: that gate counts
 * CAPTURED PaymentTransactions (`CAPTURED_PAYMENT_STATUSES`) and a
 * `SUCCEEDED` additional payment, so an intent that has NOT yet captured is
 * exactly the state it permits — and exactly the state that can capture a
 * moment later. Cancelling the intent is what actually shuts the window.
 *
 * "MOSTLY CLOSES" IS THE HONEST CLAIM, NOT "CLOSES". Between the commit above
 * and the Stripe call below the member can still confirm, and Stripe can
 * capture between our retrieve and our cancel. That residue is deliberate and
 * is what the other half of the decision covers: `confirm-modification-payment`
 * records the capture and raises an OPEN `ManualRefundTask`
 * (`deleted-booking-modification-payment.ts`). Part 1 makes the race rare;
 * part 2 makes it safe when it still fires.
 *
 * WHY AFTER THE COMMIT, NOT INSIDE IT. Two reasons, both binding. A Stripe call
 * inside a booking transaction would hold the global `pg_advisory_xact_lock(1)`
 * across a network round trip to a live provider, which `AGENTS.md` forbids
 * ("keep external provider calls outside long database transactions"). And a
 * provider timeout would roll back a deletion the admin was told nothing about.
 * Committing first means the booking is definitively deleted and the Stripe
 * tidy-up is best-effort on top of it.
 *
 * WHY IT NEVER THROWS. The deletion is already durable. Turning a completed
 * delete into a 500 would tell the admin it failed when it did not, and invite
 * a retry that answers `409 Booking has already been deleted`. Every failure is
 * logged loudly instead, and the capture it might let through is caught by the
 * `ManualRefundTask` path.
 *
 * BOTH INTENTS, NOT JUST THE MODIFICATION ONE. The decision was written about
 * the modification payment because that is the surface #2700 found, but the
 * base intent is the same hazard for the same reason, and a cancelled booking's
 * base intent is normally already terminal — so cancelling it is a no-op in the
 * ordinary case and a real fix in the case where it is not.
 * `cancelPaymentIntentIfCancellableWithResult` only acts on a genuinely
 * in-flight status and reports whether it did, so this is idempotent.
 *
 * THE LEDGER IS ONLY TOUCHED WHEN STRIPE CONFIRMS THE CANCEL. If Stripe reports
 * `canceled: false` the intent reached a terminal state on its own — possibly
 * `succeeded`, with the confirm endpoint not yet run — and marking the local
 * transaction FAILED there would write a lie that the confirm endpoint would
 * then have to overwrite. `markPaymentIntentTransactionFailed` additionally
 * refuses to move an already-captured row, so the two guards agree.
 *
 * A FAILURE IS AUDITED, NOT ONLY LOGGED. Swallowing the error is right (see
 * above), but swallowing it into a log line alone left the one outcome anybody
 * needs to act on — "the window did not close, money may still be capturable
 * against a booking that no longer exists" — visible only to whoever greps the
 * server log. The soft-delete's own audit entry is written INSIDE the
 * transaction, before Stripe is called, so it cannot carry this; a second entry
 * with `outcome: "failure"` is written here instead, and lands on the same
 * `/admin/audit-log` screen as the deletion it belongs to. `logAudit` is
 * fire-and-forget by construction, so auditing the failure cannot itself become
 * a new way for this best-effort path to throw.
 */
async function cancelInFlightPaymentIntentsAfterSoftDelete(
  bookingId: string,
  payment: BookingForDelete["payment"] | null,
  actor: BookingDeleteActor
): Promise<void> {
  if (!payment) return;

  // De-duplicated: the two columns are normally distinct, but a legacy row can
  // carry the same id in both and Stripe must not be asked twice.
  const intentIds = Array.from(
    new Set(
      [payment.stripePaymentIntentId, payment.additionalPaymentIntentId].filter(
        (intentId): intentId is string => Boolean(intentId)
      )
    )
  );

  for (const paymentIntentId of intentIds) {
    try {
      const { canceled } = await cancelPaymentIntentIfCancellableWithResult(
        paymentIntentId
      );

      if (!canceled) {
        logger.info(
          { bookingId, paymentIntentId },
          "Soft-deleted booking: PaymentIntent was not in a cancellable state, left as-is"
        );
        continue;
      }

      await markPaymentIntentTransactionFailed({ paymentIntentId });
      logger.info(
        { bookingId, paymentIntentId },
        "Soft-deleted booking: cancelled the in-flight PaymentIntent so nothing further can be captured"
      );
    } catch (err) {
      // Never rethrow: see "WHY IT NEVER THROWS" above.
      logger.error(
        { err, bookingId, paymentIntentId },
        "Soft-deleted booking: FAILED to cancel an in-flight PaymentIntent - money may still be capturable against a deleted booking"
      );
      logAudit({
        action: "booking.delete.payment_intent_cancel.failed",
        memberId: actor.memberId,
        targetId: bookingId,
        entityType: "Booking",
        entityId: bookingId,
        category: "payment",
        severity: "critical",
        outcome: "failure",
        summary:
          "Could not cancel an in-flight PaymentIntent after soft-deleting a booking",
        details:
          "The booking is deleted, but its Stripe PaymentIntent could not be cancelled, so a capture against the deleted booking is still possible. If one lands it is recorded and raised as a manual refund task (INV-ADDPAY-036); check Stripe for this intent.",
        metadata: {
          paymentIntentId,
          paymentId: payment.id,
          error: err instanceof Error ? err.message : String(err),
        },
        ipAddress: actor.ipAddress ?? undefined,
      });
    }
  }
}

async function softDeleteCancelledBookingInTransaction(
  bookingId: string,
  actor: BookingDeleteActor,
  reason: string
): Promise<SoftDeleteOutcome> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const booking = await loadBookingForDelete(tx, bookingId);

    if (!booking) {
      return { result: { status: 404, error: "Booking not found" }, payment: null };
    }
    if (booking.status !== BookingStatus.CANCELLED) {
      return {
        result: {
          status: 400,
          error: "Only cancelled bookings can be soft-deleted",
        },
        payment: null,
      };
    }
    if (booking.deletedAt) {
      return {
        result: {
          status: 409,
          error: "Booking has already been deleted",
        },
        payment: null,
      };
    }

    const blockers = await getCancelledBookingDeleteBlockers(tx, booking);
    if (blockers.length > 0) {
      return {
        result: {
          status: 409,
          error:
            "Cancelled booking cannot be deleted because financial or Xero history exists",
          blockers,
        },
        payment: null,
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
    await reconcileBedAllocationsForBookingWithGlobalLockHeld({
      bookingId: booking.id,
      db: tx,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    return {
      result: {
        status: 200,
        data: {
          success: true,
          mode: "soft-delete",
          bookingId: booking.id,
          message: "Cancelled booking deleted",
        },
      },
      // Carried out of the transaction so the Stripe tidy-up above needs no
      // second read of a booking that is now deleted.
      payment: booking.payment,
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
    memberCreditRows,
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
    tx.memberCredit.findMany({
      where: {
        OR: [
          { sourceBookingId: booking.id },
          { appliedToBookingId: booking.id },
        ],
      },
      select: { amountCents: true, type: true, xeroCreditNoteId: true },
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

  // #1547 (owner decision 2026-07-07, net-zero unblock, FINAL): a CANCELLED
  // booking whose applied credit was fully reversed no longer blocks deletion.
  const creditNetCents = memberCreditRows.reduce((sum, row) => sum + row.amountCents, 0);
  // net-zero = the applied credit was fully reversed (−X BOOKING_APPLIED + X
  // CANCELLATION_REFUND).
  // type restriction = an ADMIN_ADJUSTMENT / BOOKING_MODIFICATION_REFUND
  // referencing this booking is real financial history that must still block,
  // even if it happens to net to zero against the applied rows.
  const creditRowsAreReversalOnly = memberCreditRows.every(
    (row) =>
      row.type === CreditType.BOOKING_APPLIED ||
      row.type === CreditType.CANCELLATION_REFUND
  );
  // xeroCreditNoteId = an external accounting artifact (a Xero credit note
  // exists / was allocated) that must still block regardless of ledger netting.
  const creditRowsCarryXeroNote = memberCreditRows.some(
    (row) => row.xeroCreditNoteId !== null
  );
  const creditFullyRestored =
    memberCreditRows.length > 0 &&
    creditNetCents === 0 &&
    creditRowsAreReversalOnly &&
    !creditRowsCarryXeroNote;

  addBlocker(
    blockers,
    "captured_payment",
    "Captured, refunded, or credited payment exists",
    hasCapturedOrCreditedPayment(booking.payment, creditFullyRestored) ? 1 : 0
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
    `Member credit history exists (${memberCreditRows.length} row${
      memberCreditRows.length === 1 ? "" : "s"
    }, net ${formatCents(creditNetCents)})`,
    memberCreditRows.length > 0 && !creditFullyRestored ? memberCreditRows.length : 0
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
    "Net booking modification financial effect exists",
    getNetFinancialModificationEffectCents(booking.modifications) === 0
      ? 0
      : countFinancialModificationRows(booking.modifications)
  );

  return blockers;
}

function getNetFinancialModificationEffectCents(
  modifications: BookingForDelete["modifications"]
): number {
  return modifications.reduce(
    (total, modification) =>
      total + modification.priceDiffCents + modification.changeFeeCents,
    0
  );
}

function countFinancialModificationRows(
  modifications: BookingForDelete["modifications"]
): number {
  return modifications.filter(
    (modification) =>
      modification.priceDiffCents !== 0 || modification.changeFeeCents !== 0
  ).length;
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
  payment: BookingForDelete["payment"],
  creditFullyRestored = false
): boolean {
  if (!payment) {
    return false;
  }

  return (
    CAPTURED_PAYMENT_STATUSES.has(payment.status) ||
    payment.refundedAmountCents > 0 ||
    // #1547: the applied-credit mirror no longer blocks once the ledger proves
    // that applied credit was fully reversed (net-zero, reversal-only, no Xero
    // note). Waive ONLY this clause. The SUCCEEDED / refund / additional-payment
    // clauses stay untouched — they independently block any coincidental
    // net-zero that also involves captured money.
    (payment.creditAppliedCents > 0 && !creditFullyRestored) ||
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
