import "server-only";

import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import {
  isAdditionalOwedBookingStatus,
  isAdditionalPaymentOwed,
} from "@/lib/additional-payment-chase";
import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import { parseEditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import {
  editReviewChargeShareTaskSelect,
  editReviewChargeShareTaskWhere,
  isEditReviewChargeRequestRow,
} from "@/lib/edit-financial-review-charge-shape";
import logger from "@/lib/logger";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { cancelPaymentIntentIfCancellableWithResult } from "@/lib/stripe";
import { formatCents } from "@/lib/utils";

/**
 * WITHDRAW AN UNPAID ADDITIONAL-PAYMENT REQUEST (#3528, `INV-ADDPAY-040`,
 * stage 0 of programme #3527).
 *
 * A completed booking-edit financial review can ask the member to pay a figure
 * a person typed. When that figure turns out to be wrong - on a live
 * installation, a balance read off a Xero invoice that was itself wrong - the
 * request has to be taken back, and until now nothing could: the completed
 * task cannot be reopened (`INV-PAY-099`), the one intent-cancelling path is
 * the dead-recovery branch (`INV-PAY-057`), and the member's booking page keeps
 * showing the amount with a pay button. This is the undo, and it retires
 * EVERY instrument the request minted:
 *
 *   * the Stripe PaymentIntent (cancelled at the provider, FIRST);
 *   * the `ADDITIONAL` ledger row (FAILED, and stamped `withdrawnAt`, which is
 *     what makes the withdrawal durable - see `reconcilePaymentAggregates`);
 *   * the `Payment` summary columns (zeroed, behind a fence that re-asserts
 *     the exact values being retired, so a payment landing under us is a 409
 *     and changes nothing);
 *   * any `SUPPLEMENTARY_INVOICE` outbox operation parked `WAITING_PAYMENT`
 *     on that intent (CANCELLED with a reason, never executable);
 *   * any PENDING `CREATE_ADDITIONAL_PAYMENT_INTENT` recovery for the payment
 *     (FAILED terminally, so no retry mints the ask again).
 *
 * The source review task stays COMPLETED. The audit row written here is the
 * record: completed, then withdrawn, by whom, for how much, naming the task.
 *
 * ONLY A REVIEW-RAISED REQUEST CAN BE WITHDRAWN (D-3528-2). An ordinary
 * price-increase ask IS the booking's price - `INV-PAY-047`'s price term still
 * stands after the ask is gone, so the census would report the booking
 * "unasked" and the next edit would raise it again. The door for a wrong price
 * is editing the booking, which supersedes the ask; this door is for money a
 * person typed on top of the price, which is the one the issue describes and
 * the one whose withdrawal BALANCES the ledger.
 *
 * ORDER: the provider round trip runs before the transaction, never inside it
 * (`docs/CONCURRENCY_AND_LOCKING.md`: no lock across Stripe). Cancel-then-write
 * is the safe order: a crash between the two leaves the intent dead and the
 * columns live, so the booking still says "owing" and pressing the button
 * again converges - the cancel is a no-op on an already-cancelled intent and
 * the fence still matches. Write-then-cancel would leave a zeroed booking with
 * a live, payable intent. IDEMPOTENT ON RETRY BY CONSTRUCTION: the Stripe
 * helper reads the intent and only calls cancel on a cancellable status, so a
 * second press after a crash makes no provider call at all.
 *
 * WHAT THE OFFICER SEES when Stripe disagrees: an intent Stripe reports as
 * `succeeded` (the member paid; the webhook has not landed yet) is refused as
 * "already paid - that is a refund" and the ledger is not touched, because the
 * webhook is about to write SUCCEEDED and the fence would refuse anyway; an
 * intent in `processing` is one Stripe routinely refuses to cancel, so that
 * throw surfaces as a 502 with the ledger untouched and the officer told to
 * try again shortly.
 */

export type WithdrawAdditionalPaymentAskResult =
  | {
      ok: true;
      withdrawnAmountCents: number;
      paymentIntentId: string | null;
      /** Stripe's status after the cancel, or null when there was no intent. */
      intentStatus: string | null;
      retired: {
        xeroOperations: number;
        pendingRecoveries: number;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export const ADDITIONAL_ASK_WITHDRAWN_XERO_ERROR_CODE = "ADDITIONAL_ASK_WITHDRAWN";

export const ADDITIONAL_ASK_ALREADY_PAID_MESSAGE =
  "The member has already paid this request, so it cannot be withdrawn. Money that was paid and is not owed is a refund: use the refund path instead.";

export const ADDITIONAL_ASK_NOT_REVIEW_RAISED_MESSAGE =
  "This request was raised by a change to the booking's price, not by a financial review, so withdrawing it would leave the price unpaid. If the price is wrong, edit the booking; the request is replaced by the edit.";

export const ADDITIONAL_ASK_CHANGED_MESSAGE =
  "This request changed while you were withdrawing it - a payment may have landed. Refresh and check the booking before trying again.";

export async function withdrawAdditionalPaymentAsk(params: {
  bookingId: string;
  actorMemberId: string;
  auditRequest?: {
    id?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
  now?: Date;
}): Promise<WithdrawAdditionalPaymentAskResult> {
  const now = params.now ?? new Date();

  const booking = await prisma.booking.findUnique({
    where: { id: params.bookingId },
    select: {
      id: true,
      memberId: true,
      status: true,
      deletedAt: true,
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true } },
      modifications: { select: { id: true } },
      payment: {
        select: {
          id: true,
          additionalAmountCents: true,
          additionalPaymentStatus: true,
          additionalPaymentIntentId: true,
          transactions: {
            where: { kind: PaymentTransactionKind.ADDITIONAL },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              kind: true,
              source: true,
              status: true,
              amountCents: true,
              stripePaymentIntentId: true,
              reason: true,
              withdrawnAt: true,
            },
          },
        },
      },
    },
  });

  if (!booking) {
    return { ok: false, status: 404, error: "Booking not found" };
  }
  if (booking.deletedAt) {
    return {
      ok: false,
      status: 409,
      error: "This booking has been deleted, so there is no payment request to withdraw.",
    };
  }
  const payment = booking.payment;
  if (!isAdditionalOwedBookingStatus(booking.status)) {
    return {
      ok: false,
      status: 409,
      error:
        "This booking is not in a state where an additional payment is being collected, so there is nothing to withdraw.",
    };
  }
  if (!payment || !isAdditionalPaymentOwed({ bookingStatus: booking.status, payment })) {
    return {
      ok: false,
      status: 409,
      error: "This booking has no outstanding additional payment request to withdraw.",
    };
  }

  // The one live request is the newest ADDITIONAL row; the summary columns
  // mirror it (`reconcilePaymentAggregates`). A captured row is money the
  // member paid - a refund question, never a withdrawal - whatever the
  // summary column says in the moment before its webhook lands.
  const request = payment.transactions[0] ?? null;
  if (
    payment.additionalPaymentStatus === "SUCCEEDED" ||
    (request && isCapturedTransactionStatus(request.status))
  ) {
    return { ok: false, status: 409, error: ADDITIONAL_ASK_ALREADY_PAID_MESSAGE };
  }

  // D-3528-2: the request must be a completed financial review's. Matching is
  // exact equality on the typed reason against each of the booking's own
  // modifications - nothing slices an id out of the string (see
  // `buildEditFinancialReviewChargeReason`).
  const anchorModificationId =
    request && request.withdrawnAt === null
      ? (booking.modifications.find((modification) =>
          isEditReviewChargeRequestRow(request, modification.id),
        )?.id ?? null)
      : null;
  if (!request || !anchorModificationId) {
    return { ok: false, status: 409, error: ADDITIONAL_ASK_NOT_REVIEW_RAISED_MESSAGE };
  }

  // A recovery mid-mint holds a claim the worker is acting on; retiring it
  // under the worker would race a Stripe call. Refuse for now rather than
  // guess; the worker finishes in seconds.
  const processingRecovery = await prisma.paymentRecoveryOperation.findFirst({
    where: {
      paymentId: payment.id,
      type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
      status: PaymentRecoveryOperationStatus.PROCESSING,
    },
    select: { id: true },
  });
  if (processingRecovery) {
    return {
      ok: false,
      status: 409,
      error:
        "A background retry is setting this request up right now. Wait a minute and try again.",
    };
  }

  // THE PROVIDER ROUND TRIP, before any local write and outside any lock.
  const paymentIntentId = request.stripePaymentIntentId ?? payment.additionalPaymentIntentId;
  let intentStatus: string | null = null;
  if (paymentIntentId) {
    let result: Awaited<ReturnType<typeof cancelPaymentIntentIfCancellableWithResult>>;
    try {
      result = await cancelPaymentIntentIfCancellableWithResult(paymentIntentId, {
        // The club is withdrawing its own request; the member never declined it.
        cancellationReason: "abandoned",
      });
    } catch (err) {
      logger.error(
        { err, bookingId: booking.id, paymentId: payment.id, paymentIntentId },
        "Could not cancel the additional PaymentIntent for a withdrawal; the ledger was not touched",
      );
      return {
        ok: false,
        status: 502,
        error:
          "The card provider would not cancel this request just now (a payment may be in progress). Nothing was changed - try again shortly.",
      };
    }
    intentStatus = result.paymentIntent.status;
    if (intentStatus === "succeeded") {
      // Paid at the provider; the webhook that records it has not landed. The
      // fence below would refuse once it does, so refuse now, and say why.
      return { ok: false, status: 409, error: ADDITIONAL_ASK_ALREADY_PAID_MESSAGE };
    }
    if (!result.canceled && intentStatus !== "canceled") {
      // `processing` and friends: not cancellable and not dead. Leave it alone.
      return {
        ok: false,
        status: 409,
        error: `The card provider reports this request as "${intentStatus}", which cannot be withdrawn right now. Nothing was changed - try again shortly.`,
      };
    }
  }

  // The source tasks, for the record: every completed charge share anchored on
  // this edit. Read before the transaction; they are not written.
  const sourceTasks = await prisma.manualRefundTask.findMany({
    where: { bookingId: booking.id, ...editReviewChargeShareTaskWhere },
    select: editReviewChargeShareTaskSelect,
  });
  const sourceTaskIds = sourceTasks
    .filter(
      (task) =>
        parseEditFinancialReviewContext(task.reviewContext)?.bookingModificationId ===
        anchorModificationId,
    )
    .map((task) => task.id);

  const retired = await prisma.$transaction(async (tx) => {
    // Money side effect on a booking: the global money key, like the cancel
    // and settle paths (`docs/CONCURRENCY_AND_LOCKING.md`, tier 2). Taken
    // AFTER the provider round trip, never across it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    // THE FENCE (`INV-PAY-047`'s pattern): re-assert the exact values being
    // retired. A capture, a supersede or a second officer landing between the
    // read above and this write leaves the row different, matches nothing,
    // and this whole transaction rolls back with nothing changed.
    const zeroed = await tx.payment.updateMany({
      where: {
        id: payment.id,
        additionalAmountCents: payment.additionalAmountCents,
        additionalPaymentStatus: payment.additionalPaymentStatus,
        additionalPaymentIntentId: payment.additionalPaymentIntentId,
      },
      data: {
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        additionalPaymentIntentId: null,
      },
    });
    if (zeroed.count !== 1) {
      throw new WithdrawalFenceError();
    }

    // The ledger row: FAILED like every other retired ask, and STAMPED, which
    // is what the projection reads past. Guarded on not-captured for the same
    // reason the fence exists.
    const stamped = await tx.paymentTransaction.updateMany({
      where: {
        id: request.id,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED] },
        withdrawnAt: null,
      },
      data: { status: PaymentStatus.FAILED, withdrawnAt: now },
    });
    if (stamped.count !== 1) {
      throw new WithdrawalFenceError();
    }

    // The held Xero document, if any: CANCELLED with a reason the operator can
    // read, exactly as the stale reaper retires one. Scoped by the intent the
    // op is waiting on, which is the same field the reaper reads.
    const xeroOperations = paymentIntentId
      ? await tx.xeroSyncOperation.updateMany({
          where: {
            status: "WAITING_PAYMENT",
            direction: "OUTBOUND",
            requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
          },
          data: {
            status: "CANCELLED",
            completedAt: now,
            lastErrorCode: ADDITIONAL_ASK_WITHDRAWN_XERO_ERROR_CODE,
            lastErrorMessage:
              "Withdrawn: an officer withdrew the additional-payment request this invoice was waiting on.",
          },
        })
      : { count: 0 };

    // A pending retry would mint the ask again after we retired it.
    const pendingRecoveries = await tx.paymentRecoveryOperation.updateMany({
      where: {
        paymentId: payment.id,
        type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
        status: PaymentRecoveryOperationStatus.PENDING,
      },
      data: {
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: "Withdrawn: an officer withdrew the additional-payment request this retry would have raised.",
        nextRetryAt: null,
        processingStartedAt: null,
      },
    });

    return {
      xeroOperations: xeroOperations.count,
      pendingRecoveries: pendingRecoveries.count,
    };
  }).catch((err) => {
    if (err instanceof WithdrawalFenceError) return null;
    throw err;
  });

  if (!retired) {
    return { ok: false, status: 409, error: ADDITIONAL_ASK_CHANGED_MESSAGE };
  }

  await createAuditLog({
    action: "booking.additionalPayment.withdrawn",
    memberId: params.actorMemberId,
    actorMemberId: params.actorMemberId,
    subjectMemberId: bookingOwner(booking).memberId,
    targetId: booking.id,
    entityType: "Booking",
    entityId: booking.id,
    category: "payment",
    severity: "important",
    outcome: "success",
    summary: `Additional payment request of ${formatCents(payment.additionalAmountCents)} withdrawn`,
    details:
      "An officer withdrew a request for the member to pay an extra amount that a completed financial review had raised. The card request was cancelled with the card provider, the amount no longer shows as owing, and any Xero invoice waiting on that payment was retired without being sent. The review task that raised it stays completed; this record is the withdrawal.",
    metadata: {
      withdrawnAmountCents: payment.additionalAmountCents,
      previousAdditionalPaymentStatus: payment.additionalPaymentStatus,
      paymentIntentId,
      paymentIntentStatus: intentStatus,
      paymentTransactionId: request.id,
      bookingModificationId: anchorModificationId,
      sourceTaskIds,
      retiredXeroOperations: retired.xeroOperations,
      retiredPendingRecoveries: retired.pendingRecoveries,
    },
    requestId: params.auditRequest?.id,
    ipAddress: params.auditRequest?.ipAddress,
    userAgent: params.auditRequest?.userAgent,
  });

  return {
    ok: true,
    withdrawnAmountCents: payment.additionalAmountCents,
    paymentIntentId,
    intentStatus,
    retired,
  };
}

class WithdrawalFenceError extends Error {
  constructor() {
    super("withdrawal fence matched nothing");
    this.name = "WithdrawalFenceError";
  }
}
