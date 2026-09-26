/**
 * THE LATE-SUCCESS RELEASE of a Xero supplementary invoice (#3641,
 * `INV-PAY-105`), split from `xero-operation-outbox.ts`, which owns the queue,
 * the reaper and the per-anchor lock this module reuses.
 */
import type { PaymentStatus, Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { isAdditionalPayableBookingStatus } from "@/lib/additional-payment-chase";
import { classifyEditReviewChargeCapture } from "@/lib/xero-booking-repair-payments";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import {
  OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES,
  STALE_WAITING_PAYMENT_CAPTURED_ERROR_CODE,
  STALE_WAITING_PAYMENT_ERROR_CODE,
  XERO_SUPPLEMENTARY_INVOICE_LOCK_NAMESPACE,
  hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
  supplementaryInvoicePayload,
} from "@/lib/xero-operation-outbox";

/**
 * What a captured additional payment did to its Xero supplementary invoice
 * (#3641). Every outcome is named, so "released nothing" is never silent.
 */
export type CapturedAdditionalPaymentXeroOutcome =
  /** A waiting invoice was released now. */
  | "released"
  /** An invoice the reaper had retired was re-queued now, from that same row. */
  | "requeued"
  /** An earlier call already released or re-queued it: a replayed webhook, or the other late-success caller. */
  | "already-released"
  /** No supplementary invoice was ever parked on this intent (no issued primary invoice, or Xero not in use). */
  | "none-queued"
  /** The invoice was retired and re-issuing it was not safe, so an officer was told instead. */
  | "alerted"
  /**
   * The invoice was retired and the booking can no longer take this money
   * (cancelled or bumped). The cancelled-booking late-capture path refunds it
   * and owns its Xero correction, which counts on this invoice staying unsent.
   */
  | "left-retired";

type RetiredInvoiceRequeueRefusal =
  | "short-of-ask"
  | "not-captured"
  | "invoice-already-linked"
  | "another-invoice-queued";

const RETIRED_INVOICE_REQUEUE_REFUSAL_TEXT: Record<
  RetiredInvoiceRequeueRefusal,
  string
> = {
  "short-of-ask":
    "the card captured less than the invoice would bill, so re-issuing it would record more money as received than arrived",
  "not-captured":
    "no captured payment could be found for the payment request, so re-issuing it would record a payment that has not been seen",
  "invoice-already-linked":
    "this booking change already has a supplementary invoice in Xero (raised since, probably by the booking-vs-Xero repair tool), so re-issuing would bill it twice",
  "another-invoice-queued":
    "another supplementary invoice for this booking change is already queued, so re-issuing would bill it twice",
};

/**
 * THE LATE-SUCCESS RELEASE (#3641, `INV-PAY-105`). Every caller that has just
 * seen an additional PaymentIntent captured calls this instead of
 * `releaseXeroSupplementaryInvoiceOperationsForPaymentIntent`.
 *
 * It releases the waiting invoice as before. When there is none to release it
 * looks for one the reaper RETIRED (CANCELLED, `STALE_WAITING_PAYMENT`) and
 * re-queues THAT ROW rather than minting a new one: its payload, correlation key
 * and idempotency key are the ones the invoice was always going to be sent
 * with, so no second key can reach Xero.
 *
 * EXACTLY ONCE, and why. The re-queue runs under the per-anchor
 * supplementary-invoice lock (`XERO_SUPPLEMENTARY_INVOICE_LOCK_NAMESPACE`,
 * `docs/CONCURRENCY_AND_LOCKING.md`), the same lock
 * `enqueueXeroSupplementaryInvoiceOperation` decides "does this change already
 * have an invoice going out?" under, and its write is an `updateMany` guarded on
 * the retired status AND code. The webhook and the confirm route racing, or a
 * replay of either, therefore serialise: one wins the write, every later caller
 * matches nothing and reports `already-released`.
 *
 * WHERE IT ALERTS INSTEAD, and why each is unsafe to re-issue:
 *   - the capture is short of what the invoice bills (or no capture is found),
 *     via the repair tool's own `classifyEditReviewChargeCapture`: re-issuing
 *     with the card payment recorded would book the full figure as received.
 *     The repair tool retires exactly such an invoice unsent on purpose
 *     (`xero-booking-repair-passes.ts`), and a replay must not undo that;
 *   - the change already has an active supplementary-invoice link, or another
 *     outstanding invoice for a different ask: a second invoice for one change
 *     is the failure the anchor lock exists to prevent.
 * The alert is claimed by stamping `STALE_WAITING_PAYMENT_CAPTURED` on the
 * retired row under the same lock, so it fires once however often the capture
 * is replayed, and the row itself records that the money arrived.
 *
 * WHERE IT DOES NEITHER: a booking that can no longer take the money
 * (cancelled or bumped). That capture is refunded and alerted by the
 * cancelled-booking late-capture path, whose Xero correction assumes this
 * invoice was never sent, so the row stays retired (`left-retired`).
 */
export async function releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(
  paymentIntentId: string,
): Promise<{
  released: number;
  queueOperationIds: string[];
  outcome: CapturedAdditionalPaymentXeroOutcome;
}> {
  const released =
    await releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
      paymentIntentId,
    );

  const retiredOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "CANCELLED",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      lastErrorCode: {
        in: [
          STALE_WAITING_PAYMENT_ERROR_CODE,
          STALE_WAITING_PAYMENT_CAPTURED_ERROR_CODE,
        ],
      },
      requestPayload: {
        path: ["paymentIntentId"],
        equals: paymentIntentId,
      },
    },
    select: {
      id: true,
      localModel: true,
      localId: true,
      lastErrorCode: true,
      requestPayload: true,
    },
  });

  if (retiredOperations.length === 0) {
    if (released.released > 0) {
      return { ...released, outcome: "released" };
    }
    const alreadyReleased =
      await hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent(
        paymentIntentId,
      );
    if (!alreadyReleased) {
      logger.info(
        { paymentIntentId },
        "Captured additional payment has no Xero supplementary invoice parked on it",
      );
    }
    return {
      ...released,
      outcome: alreadyReleased ? "already-released" : "none-queued",
    };
  }

  const transaction = await prisma.paymentTransaction.findFirst({
    where: { source: "STRIPE", stripePaymentIntentId: paymentIntentId },
    select: { status: true, amountCents: true },
  });

  const requeuedIds: string[] = [];
  let alerted = false;
  let leftRetired = false;
  for (const operation of retiredOperations) {
    if (operation.lastErrorCode === STALE_WAITING_PAYMENT_CAPTURED_ERROR_CODE) {
      // Already alerted by an earlier capture of this intent; nothing new to say.
      alerted = true;
      continue;
    }
    // A cancelled booking's late capture is refunded by
    // `handleCancelledBookingAdditionalPaymentSucceeded`, which decides whether
    // Xero needs a corrective credit note from whether this invoice was ever
    // released. Re-issuing it afterwards (the confirm route does not re-check
    // the booking's lifecycle) would bill money that is being handed back with
    // no note against it. The booking's own lifecycle, by the pay door's list.
    const bookingId = supplementaryInvoicePayload(operation.requestPayload)
      ?.bookingId;
    const booking =
      typeof bookingId === "string"
        ? await prisma.booking.findUnique({
            where: { id: bookingId },
            select: { status: true },
          })
        : null;
    if (!isAdditionalPayableBookingStatus(booking?.status)) {
      leftRetired = true;
      logger.warn(
        { paymentIntentId, queueOperationId: operation.id, bookingId },
        "Captured additional payment met a retired Xero supplementary invoice on a booking that can no longer take it; left retired",
      );
      continue;
    }
    const verdict = await requeueRetiredSupplementaryInvoiceOperation({
      operation,
      paymentIntentId,
      transaction,
    });
    if (verdict.outcome === "requeued") {
      requeuedIds.push(operation.id);
    } else if (verdict.outcome === "refused") {
      alerted = true;
      if (verdict.claimedAlert) {
        await alertRetiredSupplementaryInvoiceCaptured({
          operationId: operation.id,
          localModel: operation.localModel,
          localId: operation.localId,
          paymentIntentId,
          reason: verdict.reason,
        });
      }
    }
  }

  if (requeuedIds.length > 0) {
    logger.warn(
      { paymentIntentId, queueOperationIds: requeuedIds },
      "Re-queued a Xero supplementary invoice the reaper had retired before its payment was captured",
    );
  }

  const queueOperationIds = [...released.queueOperationIds, ...requeuedIds];
  const total = released.released + requeuedIds.length;
  return {
    released: total,
    queueOperationIds,
    outcome:
      requeuedIds.length > 0
        ? "requeued"
        : released.released > 0
          ? "released"
          : alerted
            ? "alerted"
            : leftRetired
              ? "left-retired"
              : "already-released",
  };
}

async function requeueRetiredSupplementaryInvoiceOperation({
  operation,
  paymentIntentId,
  transaction,
}: {
  operation: {
    id: string;
    localModel: string | null;
    localId: string | null;
    requestPayload: Prisma.JsonValue | null;
  };
  paymentIntentId: string;
  transaction: { status: PaymentStatus; amountCents: number } | null;
}): Promise<
  | { outcome: "requeued" }
  | { outcome: "already" }
  | {
      outcome: "refused";
      reason: RetiredInvoiceRequeueRefusal;
      claimedAlert: boolean;
    }
> {
  const payload = supplementaryInvoicePayload(operation.requestPayload);
  const askCents =
    Number(payload?.priceDiffCents ?? 0) + Number(payload?.changeFeeCents ?? 0);
  const capture = transaction
    ? classifyEditReviewChargeCapture(transaction, askCents)
    : "not-captured";
  // The anchor the enqueue locks on. A retired supplementary row always
  // carries one; the operation id stands in only so a malformed row still
  // serialises against its own replays.
  const anchorId = operation.localId ?? operation.id;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${XERO_SUPPLEMENTARY_INVOICE_LOCK_NAMESPACE}), hashtext(${anchorId}))`;

    let refusal: RetiredInvoiceRequeueRefusal | null =
      capture === "covers-ask" ? null : capture;

    if (!refusal && operation.localModel && operation.localId) {
      const existingLink = await tx.xeroObjectLink.findFirst({
        where: {
          localModel: operation.localModel,
          localId: operation.localId,
          xeroObjectType: "INVOICE",
          role: "SUPPLEMENTARY_INVOICE",
          active: true,
        },
        select: { id: true },
      });
      if (existingLink) {
        refusal = "invoice-already-linked";
      } else {
        const outstanding = await tx.xeroSyncOperation.findFirst({
          where: {
            id: { not: operation.id },
            direction: "OUTBOUND",
            entityType: "INVOICE",
            operationType: "CREATE",
            localModel: operation.localModel,
            localId: operation.localId,
            queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
            status: { in: [...OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES] },
          },
          select: { id: true, requestPayload: true },
        });
        if (outstanding) {
          // The same ask already has an invoice on its way (the repair tool
          // re-parked one on this intent, and the release above let it go):
          // this capture is covered, and reviving the old row would be the
          // second invoice.
          if (
            supplementaryInvoicePayload(outstanding.requestPayload)
              ?.paymentIntentId === paymentIntentId
          ) {
            return { outcome: "already" as const };
          }
          refusal = "another-invoice-queued";
        }
      }
    }

    if (refusal) {
      const claimed = await tx.xeroSyncOperation.updateMany({
        where: {
          id: operation.id,
          status: "CANCELLED",
          lastErrorCode: STALE_WAITING_PAYMENT_ERROR_CODE,
        },
        data: {
          lastErrorCode: STALE_WAITING_PAYMENT_CAPTURED_ERROR_CODE,
          lastErrorMessage: `The linked payment was captured after this invoice was retired, and it was not re-issued: ${RETIRED_INVOICE_REQUEUE_REFUSAL_TEXT[refusal]}.`,
        },
      });
      return {
        outcome: "refused" as const,
        reason: refusal,
        claimedAlert: claimed.count === 1,
      };
    }

    const revived = await tx.xeroSyncOperation.updateMany({
      where: {
        id: operation.id,
        status: "CANCELLED",
        lastErrorCode: STALE_WAITING_PAYMENT_ERROR_CODE,
      },
      data: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    return revived.count === 1
      ? { outcome: "requeued" as const }
      : { outcome: "already" as const };
  });
}

/** Best-effort; never throws. The retired row's own stamp is the durable record. */
async function alertRetiredSupplementaryInvoiceCaptured(params: {
  operationId: string;
  localModel: string | null;
  localId: string | null;
  paymentIntentId: string;
  reason: RetiredInvoiceRequeueRefusal;
}): Promise<void> {
  const errorMessage = `A card payment (${params.paymentIntentId}) for a booking change was captured after its waiting Xero supplementary invoice had been retired, and the invoice was not re-issued automatically because ${RETIRED_INVOICE_REQUEUE_REFUSAL_TEXT[params.reason]}. Stripe holds this money; check Xero has an invoice naming it (${params.localModel ?? "record"} ${params.localId ?? "unknown"}, outbox operation ${params.operationId}).`;
  logger.error(
    { ...params },
    "Captured additional payment met a retired Xero supplementary invoice that could not be re-issued",
  );
  try {
    await sendAdminXeroSyncErrorAlert({
      errorType: "SUPPLEMENTARY_INVOICE_RETIRED_BEFORE_CAPTURE",
      operation: `Supplementary invoice for captured payment ${params.paymentIntentId}`,
      errorMessage,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error(
      { err, operationId: params.operationId },
      "Failed to send the retired-supplementary-invoice capture alert",
    );
  }
}
