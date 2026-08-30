// Pass reporting plus action application (local field/link backfills, cancelled
// in-flight payment repair, late-capture refund, and outbox/retry draining) for
// the booking-vs-Xero repair tool. Extracted verbatim from
// xero-booking-repair.ts (#1208 item 2). Money stays in integer cents; provider
// calls stay outside DB transactions (unchanged).
import logger from "@/lib/logger";
import { PartialRefundError } from "@/lib/payment-transactions";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import type {
  BookingXeroRepairAction,
  BookingXeroRepairBookingSummary,
  BookingXeroRepairPassReport,
  XeroBookingRepairActionStatus,
} from "./xero-booking-repair-types";
import type { RepairDependencies } from "./xero-booking-repair-deps";
import { createCountMap } from "./xero-booking-repair-utils";

export function buildPassReport(pass: number, bookings: BookingXeroRepairBookingSummary[]): BookingXeroRepairPassReport {
  const bookingsWithFindings = bookings.filter((booking) => booking.findings.length > 0);
  const findings = bookingsWithFindings.flatMap((booking) => booking.findings.map((finding) => finding.code));
  const actions = bookingsWithFindings.flatMap((booking) => booking.actions.map((action) => action.type));
  const actionStatuses = bookingsWithFindings.flatMap((booking) =>
    booking.actions.map((action) => action.status)
  );

  return {
    pass,
    bookingsScanned: bookings.length,
    bookingsWithFindings: bookingsWithFindings.length,
    findingsByCode: createCountMap(findings),
    actionsByType: createCountMap(actions),
    actionStatuses: createCountMap(actionStatuses),
    bookings,
  };
}

async function applyLocalPrimaryInvoiceFieldRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const xeroInvoiceId = String(action.payload.xeroInvoiceId);
  const xeroInvoiceNumber =
    typeof action.payload.xeroInvoiceNumber === "string"
      ? action.payload.xeroInvoiceNumber
      : null;

  await deps.prisma.payment.update({
    where: { id: paymentId },
    data: {
      xeroInvoiceId,
      xeroInvoiceNumber,
    },
  });

  action.status = "applied";
  action.resultMessage = `Updated payment ${paymentId} with Xero invoice ${xeroInvoiceId}.`;
}

async function applyLocalPrimaryInvoiceLinkRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const xeroInvoiceId = String(action.payload.xeroInvoiceId);
  const xeroInvoiceNumber =
    typeof action.payload.xeroInvoiceNumber === "string"
      ? action.payload.xeroInvoiceNumber
      : null;

  await deps.upsertXeroObjectLink({
    localModel: "Payment",
    localId: paymentId,
    xeroObjectType: "INVOICE",
    xeroObjectId: xeroInvoiceId,
    xeroObjectNumber: xeroInvoiceNumber,
    xeroObjectUrl: buildXeroInvoiceUrl(xeroInvoiceId),
    role: "PRIMARY_INVOICE",
  });

  action.status = "applied";
  action.resultMessage = `Backfilled PRIMARY_INVOICE link for payment ${paymentId}.`;
}

async function applyLocalRefundCreditNoteFieldRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const xeroRefundCreditNoteId = String(action.payload.xeroRefundCreditNoteId);

  await deps.prisma.payment.update({
    where: { id: paymentId },
    data: {
      xeroRefundCreditNoteId,
    },
  });

  action.status = "applied";
  action.resultMessage = `Updated payment ${paymentId} with refund credit note ${xeroRefundCreditNoteId}.`;
}

async function applyLinkRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  await deps.upsertXeroObjectLink({
    localModel: String(action.payload.localModel),
    localId: String(action.payload.localId),
    xeroObjectType: String(action.payload.xeroObjectType),
    xeroObjectId: String(action.payload.xeroObjectId),
    xeroObjectNumber:
      typeof action.payload.xeroObjectNumber === "string"
        ? action.payload.xeroObjectNumber
        : null,
    xeroObjectUrl:
      typeof action.payload.xeroObjectUrl === "string"
        ? action.payload.xeroObjectUrl
        : null,
    role: String(action.payload.role),
  });

  action.status = "applied";
  action.resultMessage = `Backfilled ${String(action.payload.role)} link for ${String(action.payload.localModel)} ${String(action.payload.localId)}.`;
}

function getPaymentIntentIdsFromActionPayload(action: BookingXeroRepairAction) {
  const paymentIntentIds = new Set<string>();

  if (Array.isArray(action.payload.paymentIntentIds)) {
    for (const paymentIntentId of action.payload.paymentIntentIds) {
      if (typeof paymentIntentId === "string" && paymentIntentId.trim()) {
        paymentIntentIds.add(paymentIntentId);
      }
    }
  }

  if (
    typeof action.payload.stripePaymentIntentId === "string" &&
    action.payload.stripePaymentIntentId.trim()
  ) {
    paymentIntentIds.add(action.payload.stripePaymentIntentId);
  }

  return [...paymentIntentIds];
}

async function applyCancelledInFlightPaymentRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const bookingId = String(action.payload.bookingId);
  const paymentIntentIds = getPaymentIntentIdsFromActionPayload(action);

  if (paymentIntentIds.length === 0) {
    await deps.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: "FAILED",
        additionalPaymentStatus: "FAILED",
      },
    });
    action.status = "applied";
    action.resultMessage =
      "Marked the cancelled booking payment as failed because no Stripe payment intent id was stored.";
    return;
  }

  const terminalFailureStatuses = new Set([
    "canceled",
    "requires_payment_method",
    "requires_confirmation",
  ]);
  const terminalFailures: string[] = [];
  const succeededIntents: string[] = [];
  const nonTerminalIntents: string[] = [];

  for (const paymentIntentId of paymentIntentIds) {
    const cancelledIntent = await deps.cancelPaymentIntentIfCancellable(paymentIntentId);
    const latestIntent = cancelledIntent ?? (await deps.getPaymentIntent(paymentIntentId));

    if (latestIntent.status === "succeeded") {
      succeededIntents.push(paymentIntentId);
      continue;
    }

    if (!terminalFailureStatuses.has(latestIntent.status)) {
      nonTerminalIntents.push(`${paymentIntentId}:${latestIntent.status}`);
      continue;
    }

    terminalFailures.push(paymentIntentId);
  }

  if (succeededIntents.length > 0) {
    action.status = "failed";
    action.resultMessage = `Stripe reports ${succeededIntents.join(", ")} as succeeded. Re-run the repair so late-capture refund handling can apply.`;
    return;
  }

  if (nonTerminalIntents.length > 0) {
    action.status = "failed";
    action.resultMessage = `Stripe payment intents are still non-terminal: ${nonTerminalIntents.join(", ")}. Manual review is required.`;
    return;
  }

  for (const paymentIntentId of terminalFailures) {
    await deps.markPaymentIntentTransactionFailed({ paymentIntentId });
  }

  action.status = "applied";
  action.resultMessage = `Cancelled ${terminalFailures.length} Stripe payment intent(s) and marked their local transactions failed for cancelled booking ${bookingId}.`;
}

async function applyLateCaptureRefundRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const refundAmountCents = Number(action.payload.refundAmountCents);
  const bookingId = String(action.payload.bookingId);
  const invoiceId =
    typeof action.payload.invoiceId === "string"
      ? action.payload.invoiceId
      : null;

  if (!Number.isFinite(refundAmountCents) || refundAmountCents <= 0) {
    action.status = "failed";
    action.resultMessage = "Late-capture repair payload is incomplete.";
    return;
  }

  let refundResult: Awaited<
    ReturnType<typeof deps.refundPaymentTransactions>
  >;
  try {
    refundResult = await deps.refundPaymentTransactions({
      paymentId,
      amountCents: refundAmountCents,
      reason: "requested_by_customer",
      metadata: {
        bookingId,
        reason: "cancelled_booking_late_capture_repair",
      },
      idempotencyKeyPrefix: `late_cancel_refund_repair_${bookingId}`,
    });
  } catch (error) {
    // #1495: a multi-slice refund can fail partway — earlier slices already
    // refunded at Stripe and recorded to the ledger. Queue the Xero refund
    // credit note for that recorded portion BEFORE rethrowing, so Xero stays
    // consistent with what actually moved instead of understating refunds
    // until the amount-mismatch arm surfaces the drift. The note is sized from
    // the recorded refund ledger by enqueueXeroRefundCreditNoteOperation
    // (capped at the provider-backed cash evidence minus already-covered —
    // resolveStripeCashRefundEvidence, #2902/INV-PAY-050; the slices just
    // recorded ARE that evidence here), so passing the
    // completed portion produces exactly the delta that moved; the operator's
    // re-run for the remainder then enqueues only the still-uncovered slice
    // under a distinct cumulative-watermark correlation key, never double-noting.
    if (
      invoiceId &&
      error instanceof PartialRefundError &&
      error.completedRefundCents > 0
    ) {
      try {
        await deps.enqueueXeroRefundCreditNoteOperation(
          paymentId,
          error.completedRefundCents
        );
      } catch (enqueueError) {
        // Best-effort: never let an enqueue failure mask the refund error the
        // operator needs to see. The amount-mismatch arm still surfaces any
        // residual drift on a later scan.
        logger.error(
          {
            err: enqueueError,
            bookingId,
            paymentId,
            completedRefundCents: error.completedRefundCents,
          },
          "Failed to queue Xero refund credit note for the completed slices of a partially-failed late-capture refund"
        );
      }
    }
    throw error;
  }

  if (invoiceId) {
    await deps.enqueueXeroRefundCreditNoteOperation(paymentId, refundAmountCents);
  }

  const refundIds = refundResult.refunds.map((refund) => refund.refundId).filter(Boolean);
  action.status = invoiceId ? "queued" : "applied";
  action.resultMessage = invoiceId
    ? `Refunded ${refundResult.refunds.length} Stripe payment intent(s) (${refundIds.join(", ")}) and queued the matching Xero refund credit note.`
    : `Refunded ${refundResult.refunds.length} Stripe payment intent(s) (${refundIds.join(", ")}). No Xero invoice was linked, so no refund credit note was queued.`;
}

async function applyQueuedAction(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  switch (action.type) {
    case "QUEUE_PRIMARY_INVOICE": {
      const result = await deps.enqueueXeroBookingInvoiceOperation(
        String(action.payload.bookingId)
      );
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_PRIMARY_INVOICE_UPDATE": {
      const result = await deps.enqueueXeroBookingInvoiceUpdateOperation(
        String(action.payload.bookingId)
      );
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_SUPPLEMENTARY_INVOICE": {
      /**
       * #3187: the payment half of the ask travels WITH it.
       *
       * The enqueue defaults `recordPayment` to true, which is right for the
       * arm this action was built for - an ordinary price increase whose card
       * was captured before the invoice was queued - and wrong for a booking
       * edit priced by a completed financial review, where the invoice may BE
       * the unpaid ask. The classifier decides that from the ledger
       * (`planEditReviewChargeInvoicePayment`) and puts its answer on the
       * payload; an action carrying no answer keeps the enqueue's own defaults,
       * so nothing the tool already repaired changes behaviour.
       */
      const recordPayment =
        typeof action.payload.recordPayment === "boolean"
          ? action.payload.recordPayment
          : undefined;
      const waitForConfirmedAdditionalPayment =
        typeof action.payload.waitForConfirmedAdditionalPayment === "boolean"
          ? action.payload.waitForConfirmedAdditionalPayment
          : undefined;
      const paymentIntentId =
        typeof action.payload.paymentIntentId === "string"
          ? action.payload.paymentIntentId
          : undefined;
      const result = await deps.enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId: String(action.payload.bookingId),
          bookingModificationId:
            typeof action.payload.bookingModificationId === "string"
              ? action.payload.bookingModificationId
              : undefined,
          priceDiffCents: Number(action.payload.priceDiffCents),
          changeFeeCents: Number(action.payload.changeFeeCents),
        },
        {
          recordPayment,
          waitForConfirmedAdditionalPayment,
          paymentIntentId,
        }
      );
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_MODIFICATION_CREDIT_NOTE": {
      const result = await deps.enqueueXeroModificationCreditNoteOperation({
        bookingId: String(action.payload.bookingId),
        bookingModificationId:
          typeof action.payload.bookingModificationId === "string"
            ? action.payload.bookingModificationId
            : undefined,
        refundAmountCents: Number(action.payload.refundAmountCents),
      });
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_ACCOUNT_CREDIT_NOTE": {
      const result = await deps.enqueueXeroAccountCreditNoteOperation(
        String(action.payload.paymentId),
        Number(action.payload.refundAmountCents)
      );
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_REFUND_CREDIT_NOTE": {
      const result = await deps.enqueueXeroRefundCreditNoteOperation(
        String(action.payload.paymentId),
        Number(action.payload.refundAmountCents)
      );
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_CREDIT_NOTE_ALLOCATION": {
      const result = await deps.enqueueXeroCreditNoteAllocationOperation({
        localModel: action.payload.localModel as "Payment" | "Booking" | "BookingModification",
        localId: String(action.payload.localId),
        creditNoteId: String(action.payload.creditNoteId),
        invoiceId: String(action.payload.invoiceId),
        amountCents: Number(action.payload.amountCents),
        role:
          typeof action.payload.role === "string"
            ? action.payload.role
            : undefined,
      });
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "REQUEUE_XERO_OPERATION": {
      const result = await deps.enqueueXeroSyncOperationRetry(
        String(action.payload.operationId)
      );
      action.status = "queued";
      action.resultMessage = result.message;
      return;
    }
    case "SYNC_PAYMENT_PRIMARY_INVOICE_FIELD":
      await applyLocalPrimaryInvoiceFieldRepair(action, deps);
      return;
    case "SYNC_PAYMENT_PRIMARY_INVOICE_LINK":
      await applyLocalPrimaryInvoiceLinkRepair(action, deps);
      return;
    case "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD":
      await applyLocalRefundCreditNoteFieldRepair(action, deps);
      return;
    case "SYNC_BOOKING_SCOPED_LINK":
      await applyLinkRepair(action, deps);
      return;
    case "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT":
      await applyCancelledInFlightPaymentRepair(action, deps);
      return;
    case "AUTO_REFUND_LATE_CAPTURED_PAYMENT":
      await applyLateCaptureRefundRepair(action, deps);
      return;
    case "MARK_MANUAL_REVIEW":
      action.status = "manual_review";
      action.resultMessage = String(action.payload.reason);
      return;
  }
}

export async function applyActionsForPass(
  bookings: BookingXeroRepairBookingSummary[],
  deps: RepairDependencies,
  xeroConnectionAvailable: boolean,
  // #1491: exact keys an operator explicitly confirmed for execution even
  // though they are not safeToAutoApply (from the dry-run report).
  forcedActionKeys?: Set<string>
) {
  let hasStateChanges = false;

  for (const booking of bookings) {
    for (const action of booking.actions) {
      const operatorForced = forcedActionKeys?.has(action.key) ?? false;
      if (
        (!action.safeToAutoApply && !operatorForced) ||
        action.status !== "planned"
      ) {
        continue;
      }

      try {
        await applyQueuedAction(action, deps);
        const updatedStatus = action.status as XeroBookingRepairActionStatus;
        if (updatedStatus !== "failed" && updatedStatus !== "manual_review") {
          hasStateChanges = true;
        }
      } catch (error) {
        action.status = "failed";
        action.resultMessage =
          error instanceof Error ? error.message : "Unknown repair error";
        logger.error(
          {
            err: error,
            bookingId: booking.bookingId,
            actionKey: action.key,
            actionType: action.type,
          },
          "Failed to apply booking/Xero repair action"
        );
      }
    }
  }

  if (xeroConnectionAvailable) {
    const [outboxResult, retryResult] = await Promise.all([
      deps.processQueuedXeroOutboxOperations({ limit: 50 }),
      deps.processQueuedXeroOperationRetries({ limit: 50 }),
    ]);

    if (
      outboxResult.processed > 0 ||
      retryResult.processed > 0 ||
      outboxResult.succeeded > 0 ||
      retryResult.succeeded > 0
    ) {
      hasStateChanges = true;
    }
  }

  return hasStateChanges;
}
