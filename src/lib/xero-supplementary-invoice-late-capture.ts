/**
 * WHAT A CAPTURED ADDITIONAL PAYMENT DOES TO ITS XERO SUPPLEMENTARY INVOICE
 * (#3641, `INV-PAY-104`), split from `xero-operation-outbox.ts`, which owns the
 * queue, the release write and the per-anchor lock this module reuses. The
 * waiting-invoice reaper (`xero-waiting-invoice-reaper.ts`) sits above it.
 */
import type { PaymentStatus, Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { isLateCaptureRefundedBookingStatus } from "@/lib/additional-payment-chase";
import { classifyEditReviewChargeCapture } from "@/lib/xero-booking-repair-payments";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import {
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
  supplementaryInvoiceBilledCents,
} from "@/lib/xero-operation-outbox-payload";
import {
  OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES,
  attachPaymentIntentToWaitingSupplementaryInvoiceOperations,
  hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent,
  lockSupplementaryInvoiceAnchor,
  releaseWaitingSupplementaryInvoiceOperations,
} from "@/lib/xero-operation-outbox";

/**
 * The code the reaper stamps on an operation it retires, and the ONLY code the
 * re-queue below will revive. An operation CANCELLED for any other reason (an
 * officer withdrew the ask, the booking was settled by hand) stays retired
 * whatever happens to its PaymentIntent afterwards.
 */
export const STALE_WAITING_PAYMENT_ERROR_CODE = "STALE_WAITING_PAYMENT";

/**
 * The payment was captured and this invoice was deliberately NOT issued, and an
 * officer was told. The stamp IS the alert's claim: it is written by a
 * status-and-code guarded `updateMany`, so a replayed webhook, or the confirm
 * route racing it, finds nothing to claim and alerts nobody a second time.
 */
const CAPTURED_NOT_ISSUED_ERROR_CODE = "STALE_WAITING_PAYMENT_CAPTURED";

/**
 * A retired invoice another operation already answers: an invoice for the same
 * payment request is on its way or sent, or a newer retired row for the same
 * change was decided instead. Terminal and never revived, so a replay, or the
 * second late-success caller, finds nothing to revive or alert about.
 */
const COVERED_ERROR_CODE = "STALE_WAITING_PAYMENT_COVERED";

/**
 * What a captured additional payment did to its Xero supplementary invoice.
 * Every outcome is named, so "released nothing" is never silent.
 */
export type CapturedAdditionalPaymentXeroOutcome =
  /** A waiting invoice was released now. */
  | "released"
  /** An invoice the reaper had retired was re-queued now, from that same row. */
  | "requeued"
  /** An earlier call, or another invoice for the same request, already covers it. */
  | "already-released"
  /** No supplementary invoice was ever parked on this intent (no issued primary invoice, or Xero not in use). */
  | "none-queued"
  /** Issuing the invoice was not safe, so an officer was told instead, by this call. */
  | "alerted"
  /** An earlier capture of this intent already told an officer; nothing new. */
  | "already-alerted"
  /**
   * The capture is one that is REFUNDED rather than kept
   * (`lateCaptureRefundState`: an approved treasurer task, or with no task a
   * CANCELLED booking or a superseded intent), so no invoice is released or
   * re-queued for it; a waiting one is left for the reaper to retire. The
   * refund path's Xero correction counts on that.
   */
  | "left-retired"
  /**
   * #3635: a treasurer is still deciding whether to refund or keep it (an OPEN
   * #3639 approval task). Nothing is touched: a waiting invoice stays waiting
   * and a retired one stays retired, until the decision releases or retires it.
   */
  | "awaiting-decision";

type CaptureRefusal = "short-of-ask" | "not-captured" | "unreadable-invoice";

type IssueRefusal =
  | CaptureRefusal
  | "invoice-already-linked"
  | "another-invoice-queued";

const ISSUE_REFUSAL_TEXT: Record<IssueRefusal, string> = {
  "short-of-ask":
    "the card captured less than the invoice would bill, so issuing it would record more money as received than arrived",
  "not-captured":
    "no captured payment could be found for the payment request, so issuing it would record a payment that has not been seen",
  "unreadable-invoice":
    "the queued invoice's amount could not be read, so it could not be checked against the payment",
  "invoice-already-linked":
    "this booking change already has a supplementary invoice in Xero (raised since, probably by the booking-vs-Xero repair tool), so issuing it would bill it twice",
  "another-invoice-queued":
    "another supplementary invoice for this booking change is already queued, so issuing it would bill it twice",
};

type CapturedTransaction = { status: PaymentStatus; amountCents: number } | null;

/**
 * WHAT HAPPENS TO THIS CAPTURE'S MONEY: refunded, awaiting a treasurer, or
 * kept? (#3641 review round, delta D1; three-valued since #3635.)
 *
 * A #3639 treasurer-approval task, when one owns the capture, is the answer,
 * whatever the booking's status: OPEN is `awaiting-decision` (nothing may be
 * released or retired while the treasurer decides), COMPLETED is `refunded`
 * (the approval is the refund), DISMISSED is `kept` (owner decision 29 Sep
 * 2026, #3635: the kept money is invoiced and paid from the Stripe account like
 * any card payment) unless the capture has since been refunded in full (a
 * dashboard refund, closed without refunding as the payments guide says).
 *
 * With no task, the webhook's own routing decides, exactly as before. Two
 * populations are refunded by design and their waiting invoice must retire,
 * never be sent with a receipt for money being handed back:
 *   - a CANCELLED booking's late capture, refunded by
 *     `handleCancelledBookingAdditionalPaymentSucceeded`
 *     (`isLateCaptureRefundedBookingStatus`, the webhook's own routing test);
 *   - a SUPERSEDED intent's late capture (#3403), refunded through the
 *     supersede recovery: the intent carries a CANCEL_PAYMENT_INTENT (or
 *     REFUND_SUPERSEDED_PAYMENT) recovery, which is how the webhook finds it.
 * Everything else is kept. The late-capture release and the waiting-invoice
 * reaper both ask this, so "release only a capture the club keeps" has one
 * answer (`INV-SSOT`).
 */
export type LateCaptureRefundState = "refunded" | "awaiting-decision" | "kept";

export async function lateCaptureRefundState(params: {
  paymentIntentId: string;
  bookingStatus: string | null | undefined;
}): Promise<LateCaptureRefundState> {
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: params.paymentIntentId },
    select: { status: true },
  });
  if (task) {
    if (task.status === "OPEN") return "awaiting-decision";
    if (task.status !== "DISMISSED") return "refunded";
    // Closed without refunding - but the payments guide tells a treasurer who
    // already refunded it in the Stripe dashboard to close it that way too. A
    // capture fully refunded since is not kept money.
    const capture = await prisma.paymentTransaction.findFirst({
      where: { source: "STRIPE", stripePaymentIntentId: params.paymentIntentId },
      select: { amountCents: true, refundedAmountCents: true },
    });
    return capture && capture.refundedAmountCents >= capture.amountCents
      ? "refunded"
      : "kept";
  }
  if (isLateCaptureRefundedBookingStatus(params.bookingStatus)) return "refunded";
  const supersede = await prisma.paymentRecoveryOperation.findFirst({
    where: {
      paymentIntentId: params.paymentIntentId,
      type: { in: ["CANCEL_PAYMENT_INTENT", "REFUND_SUPERSEDED_PAYMENT"] },
    },
    select: { id: true },
  });
  return supersede !== null ? "refunded" : "kept";
}

/**
 * Which retired row answers a capture, when a change has several on one intent
 * (#3641 review round, N1): the one billing the MOST. An ask on one change only
 * ever grows (the restate never lowers, `restatePendingSupplementaryInvoiceAmount`),
 * so the largest is the current ask whatever order the rows were written in; a
 * stale, smaller settlement replayed after a larger row was retired is newer
 * but not current. Ties go to the newest.
 */
function byCurrentAsk(
  a: { requestPayload: Prisma.JsonValue | null; createdAt: Date },
  b: { requestPayload: Prisma.JsonValue | null; createdAt: Date },
): number {
  const billed = (row: { requestPayload: Prisma.JsonValue | null }) =>
    supplementaryInvoiceBilledCents(row.requestPayload) ?? -1;
  return (
    billed(b) - billed(a) || b.createdAt.getTime() - a.createdAt.getTime()
  );
}

/**
 * IS IT SAFE TO ISSUE THIS INVOICE WITH THIS CAPTURE RECORDED AS ITS PAYMENT?
 * One rule for a still-waiting invoice and a retired one (#3641 review round):
 * the worker books the invoice's own net as the Stripe receipt, so an invoice
 * billing more than was captured would book money that never arrived. The
 * repair tool asks the same `classifyEditReviewChargeCapture`. Where it is not
 * safe the invoice is not issued and an officer is told; the difference is
 * collected by hand.
 */
function captureRefusalFor(
  transaction: CapturedTransaction,
  requestPayload: Prisma.JsonValue | null,
): CaptureRefusal | null {
  const billedCents = supplementaryInvoiceBilledCents(requestPayload);
  if (billedCents === null) return "unreadable-invoice";
  if (!transaction) return "not-captured";
  const capture = classifyEditReviewChargeCapture(transaction, billedCents);
  return capture === "covers-ask" ? null : capture;
}

const SUPPLEMENTARY_INVOICE_CREATE = {
  direction: "OUTBOUND",
  entityType: "INVOICE",
  operationType: "CREATE",
  queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
} as const;

/**
 * THE LATE-SUCCESS RELEASE (#3641, `INV-PAY-104`). Every caller that has seen
 * an additional PaymentIntent captured calls this: the Stripe webhook's two
 * arms, the confirm route's two arms, and the reaper when it finds a waiting
 * invoice whose payment already arrived.
 *
 * 1. A WAITING invoice on the intent is released, unless the capture does not
 *    cover it (`captureRefusalFor`), in which case it is cancelled unsent and an
 *    officer is told, once.
 * 2. An invoice the reaper RETIRED (`STALE_WAITING_PAYMENT`) is re-queued from
 *    THAT ROW, never a new one: its payload, correlation key and idempotency key
 *    are the ones it was always going to be sent with, so no second key can
 *    reach Xero. Only ONE retired row per booking change is decided, the one
 *    billing the most (`byCurrentAsk`: a raised ask queues a second row on the
 *    same intent, and reviving a smaller one would under-invoice); the others
 *    are stamped covered.
 *
 * EXACTLY ONCE, and why. The re-queue runs under the per-anchor
 * supplementary-invoice lock (`lockSupplementaryInvoiceAnchor`), the lock
 * `enqueueXeroSupplementaryInvoiceOperation` decides "does this change already
 * have an invoice going out?" under, and every write is an `updateMany` guarded
 * on the retired status AND code. The two callers racing, or a replay, serialise:
 * one wins the write, every later caller matches nothing.
 *
 * WHERE IT ALERTS INSTEAD: the capture does not cover the invoice, or the change
 * already has an active supplementary-invoice link, or another outstanding
 * invoice for a different ask. An invoice for this SAME request already on its
 * way or sent is not a reason to alert: that one covers the capture, and the
 * retired row is stamped covered so the second caller does not alert either.
 *
 * WHERE IT DOES NEITHER: a refunded capture (`lateCaptureRefundState`: an
 * approved treasurer task, or with no task a CANCELLED booking or a superseded
 * intent). Nothing is released or revived, waiting or retired, because the
 * refund path's Xero correction assumes the invoice was never sent
 * (`left-retired`). Nor while a treasurer is still deciding
 * (`awaiting-decision`). A kept capture - including one on a CANCELLED booking
 * whose treasurer task was dismissed (#3635) - is released, re-queued or
 * alerted like any booking; the dismissal calls this itself.
 */
export async function releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(
  paymentIntentId: string,
): Promise<{
  released: number;
  queueOperationIds: string[];
  outcome: CapturedAdditionalPaymentXeroOutcome;
}> {
  const captured = await prisma.paymentTransaction.findFirst({
    where: { source: "STRIPE", stripePaymentIntentId: paymentIntentId },
    select: {
      status: true,
      amountCents: true,
      payment: { select: { booking: { select: { status: true } } } },
    },
  });
  const transaction: CapturedTransaction = captured
    ? { status: captured.status, amountCents: captured.amountCents }
    : null;

  // Only a capture the club KEEPS is invoiced. A refunded one releases and
  // revives nothing: a waiting invoice is left for the reaper to retire, a
  // retired one stays retired. One awaiting a treasurer's decision is left
  // exactly as it is.
  const refundState = await lateCaptureRefundState({
    paymentIntentId,
    bookingStatus: captured?.payment?.booking?.status,
  });
  if (refundState === "refunded") {
    logger.warn(
      { paymentIntentId },
      "Captured additional payment is one that is refunded; its Xero supplementary invoice is left unsent",
    );
    return { released: 0, queueOperationIds: [], outcome: "left-retired" };
  }
  if (refundState === "awaiting-decision") {
    logger.info(
      { paymentIntentId },
      "Captured additional payment is awaiting a treasurer's refund decision; its Xero supplementary invoice is left as it is",
    );
    return { released: 0, queueOperationIds: [], outcome: "awaiting-decision" };
  }

  const waiting = await releaseWaitingInvoicesForCapture(
    paymentIntentId,
    transaction,
  );

  const retiredOperations = (
    await prisma.xeroSyncOperation.findMany({
      where: {
        ...SUPPLEMENTARY_INVOICE_CREATE,
        status: "CANCELLED",
        // Every supplementary enqueue writes both; the lock needs the anchor.
        localModel: { not: null },
        localId: { not: null },
        lastErrorCode: {
          in: [STALE_WAITING_PAYMENT_ERROR_CODE, CAPTURED_NOT_ISSUED_ERROR_CODE],
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
        createdAt: true,
      },
    })
  ).sort(byCurrentAsk);

  const byAnchor = new Map<string, typeof retiredOperations>();
  for (const operation of retiredOperations) {
    const anchorId = operation.localId as string;
    byAnchor.set(anchorId, [...(byAnchor.get(anchorId) ?? []), operation]);
  }

  const requeuedIds: string[] = [];
  let alerted = waiting.alerted;
  let alreadyAlerted = false;
  for (const [anchorId, operations] of byAnchor) {
    const [newest, ...older] = operations;
    if (!newest) continue;
    if (newest.lastErrorCode === CAPTURED_NOT_ISSUED_ERROR_CODE) {
      alreadyAlerted = true;
      continue;
    }
    const verdict = await requeueRetiredSupplementaryInvoiceOperation({
      operation: { ...newest, localModel: newest.localModel as string },
      anchorId,
      supersededIds: older
        .filter((row) => row.lastErrorCode === STALE_WAITING_PAYMENT_ERROR_CODE)
        .map((row) => row.id),
      paymentIntentId,
      transaction,
    });
    if (verdict.outcome === "requeued") {
      requeuedIds.push(newest.id);
    } else if (verdict.outcome === "refused") {
      alerted = true;
      await alertInvoiceNotIssuedOnCapture({
        operationId: newest.id,
        localModel: newest.localModel,
        localId: newest.localId,
        paymentIntentId,
        reason: verdict.reason,
        wasRetired: true,
      });
    }
  }

  if (requeuedIds.length > 0) {
    logger.warn(
      { paymentIntentId, queueOperationIds: requeuedIds },
      "Re-queued a Xero supplementary invoice the reaper had retired before its payment was captured",
    );
  }

  const released = waiting.released + requeuedIds.length;
  const queueOperationIds = [
    ...new Set([...waiting.queueOperationIds, ...requeuedIds]),
  ];
  let outcome: CapturedAdditionalPaymentXeroOutcome;
  if (requeuedIds.length > 0) outcome = "requeued";
  else if (waiting.released > 0) outcome = "released";
  else if (alerted) outcome = "alerted";
  else if (alreadyAlerted) outcome = "already-alerted";
  else if (retiredOperations.length > 0) outcome = "already-released";
  else {
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
    outcome = alreadyReleased ? "already-released" : "none-queued";
  }
  return { released, queueOperationIds, outcome };
}

/**
 * Step 1: the still-waiting invoices on this intent. Each that the capture
 * covers is released through the outbox's one release write; each it does not
 * is cancelled unsent (guarded on WAITING_PAYMENT, which is also the alert's
 * claim) and an officer is told.
 */
async function releaseWaitingInvoicesForCapture(
  paymentIntentId: string,
  transaction: CapturedTransaction,
): Promise<{ released: number; queueOperationIds: string[]; alerted: boolean }> {
  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      ...SUPPLEMENTARY_INVOICE_CREATE,
      status: "WAITING_PAYMENT",
      requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
    select: { id: true, localModel: true, localId: true, requestPayload: true },
  });

  const issuableIds: string[] = [];
  let alerted = false;
  for (const operation of waitingOperations) {
    const refusal = captureRefusalFor(transaction, operation.requestPayload);
    if (!refusal) {
      issuableIds.push(operation.id);
      continue;
    }
    const claimed = await prisma.xeroSyncOperation.updateMany({
      where: { id: operation.id, status: "WAITING_PAYMENT" },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        lastErrorCode: CAPTURED_NOT_ISSUED_ERROR_CODE,
        lastErrorMessage: `The linked payment was captured, and this invoice was not issued: ${ISSUE_REFUSAL_TEXT[refusal]}.`,
      },
    });
    if (claimed.count === 1) {
      alerted = true;
      await alertInvoiceNotIssuedOnCapture({
        operationId: operation.id,
        localModel: operation.localModel,
        localId: operation.localId,
        paymentIntentId,
        reason: refusal,
        wasRetired: false,
      });
    }
  }

  const released = await releaseWaitingSupplementaryInvoiceOperations(issuableIds);
  return { ...released, alerted };
}

async function requeueRetiredSupplementaryInvoiceOperation({
  operation,
  anchorId,
  supersededIds,
  paymentIntentId,
  transaction,
}: {
  operation: {
    id: string;
    localModel: string;
    requestPayload: Prisma.JsonValue | null;
  };
  anchorId: string;
  /** Older retired rows on this change and intent: stamped covered, whatever is decided here. */
  supersededIds: string[];
  paymentIntentId: string;
  transaction: CapturedTransaction;
}): Promise<
  | { outcome: "requeued" }
  | { outcome: "already" }
  | { outcome: "refused"; reason: IssueRefusal }
> {
  const captureRefusal = captureRefusalFor(transaction, operation.requestPayload);
  const retiredIds = [operation.id, ...supersededIds];
  const stampCovered = (tx: Prisma.TransactionClient, ids: string[], message: string) =>
    ids.length === 0
      ? Promise.resolve()
      : tx.xeroSyncOperation.updateMany({
          where: {
            id: { in: ids },
            status: "CANCELLED",
            lastErrorCode: STALE_WAITING_PAYMENT_ERROR_CODE,
          },
          data: { lastErrorCode: COVERED_ERROR_CODE, lastErrorMessage: message },
        });

  return prisma.$transaction(async (tx) => {
    await lockSupplementaryInvoiceAnchor(tx, anchorId);

    // An invoice for this SAME request already on its way or sent (the repair
    // tool re-parked one on this intent and it has been released, or sent)
    // covers the capture. Checked first, because once that one is sent the
    // change carries an active link, and reading that as "already linked" is the
    // false alarm a correct booking must not raise.
    const covering = await tx.xeroSyncOperation.findFirst({
      where: {
        ...SUPPLEMENTARY_INVOICE_CREATE,
        id: { notIn: retiredIds },
        localModel: operation.localModel,
        localId: anchorId,
        status: { not: "CANCELLED" },
        requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
      },
      select: { id: true },
    });
    if (covering) {
      await stampCovered(
        tx,
        retiredIds,
        `Retired, and the linked payment was captured later; outbox operation ${covering.id} already invoices that payment.`,
      );
      return { outcome: "already" as const };
    }

    await stampCovered(
      tx,
      supersededIds,
      `Retired, and superseded by the newer invoice ${operation.id} for the same payment request, which that payment's capture was decided against.`,
    );

    let refusal: IssueRefusal | null = captureRefusal;
    if (!refusal) {
      const existingLink = await tx.xeroObjectLink.findFirst({
        where: {
          localModel: operation.localModel,
          localId: anchorId,
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
            ...SUPPLEMENTARY_INVOICE_CREATE,
            id: { notIn: retiredIds },
            localModel: operation.localModel,
            localId: anchorId,
            status: { in: [...OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES] },
          },
          select: { id: true },
        });
        if (outstanding) refusal = "another-invoice-queued";
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
          lastErrorCode: CAPTURED_NOT_ISSUED_ERROR_CODE,
          lastErrorMessage: `The linked payment was captured after this invoice was retired, and it was not re-issued: ${ISSUE_REFUSAL_TEXT[refusal]}.`,
        },
      });
      // Lost the claim: another caller already revived, covered or alerted it.
      return claimed.count === 1
        ? { outcome: "refused" as const, reason: refusal }
        : { outcome: "already" as const };
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

/**
 * THE RECOVERY'S ATTACH, which must not strand an invoice (#3641 review round).
 * A failed mint's recovery points the change's waiting invoice at the intent it
 * finally minted, the only thing that lets a capture release it. When that
 * write failed it was logged and forgotten, and the invoice then waited on no
 * intent until the age backstop retired it while the member paid. Now an
 * officer is told. A capture that lands BEFORE a successful attach is picked up
 * by the reaper, which releases a waiting invoice whose payment has arrived.
 */
export async function attachRecoveredIntentToWaitingSupplementaryInvoice(params: {
  bookingModificationId: string;
  paymentIntentId: string;
  recoveryOperationId: string;
}): Promise<void> {
  try {
    await attachPaymentIntentToWaitingSupplementaryInvoiceOperations({
      bookingModificationId: params.bookingModificationId,
      paymentIntentId: params.paymentIntentId,
    });
  } catch (err) {
    logger.error(
      { err, ...params },
      "Failed to attach recovered additional intent to waiting Xero operations",
    );
    try {
      await sendAdminXeroSyncErrorAlert({
        errorType: "SUPPLEMENTARY_INVOICE_INTENT_NOT_ATTACHED",
        operation: `Supplementary invoice for booking change ${params.bookingModificationId}`,
        errorMessage: `A recovered card payment request (${params.paymentIntentId}) could not be linked to this booking change's waiting Xero supplementary invoice, so paying it will not release that invoice. Check the change's Xero invoice once the member pays (payment recovery operation ${params.recoveryOperationId}).`,
        timestamp: new Date(),
      });
    } catch (alertErr) {
      logger.error(
        { err: alertErr, ...params },
        "Failed to send the unattached-supplementary-invoice alert",
      );
    }
  }
}

/** Best-effort; never throws. The operation's own stamp is the durable record. */
async function alertInvoiceNotIssuedOnCapture(params: {
  operationId: string;
  localModel: string | null;
  localId: string | null;
  paymentIntentId: string;
  reason: IssueRefusal;
  wasRetired: boolean;
}): Promise<void> {
  const when = params.wasRetired
    ? "after its waiting Xero supplementary invoice had been retired, and the invoice was not re-issued automatically"
    : "and its waiting Xero supplementary invoice was not issued automatically";
  const errorMessage = `A card payment (${params.paymentIntentId}) for a booking change was captured ${when} because ${ISSUE_REFUSAL_TEXT[params.reason]}. Stripe holds this money; check Xero has an invoice naming it (${params.localModel ?? "record"} ${params.localId ?? "unknown"}, outbox operation ${params.operationId}).`;
  logger.error(
    { ...params },
    "Captured additional payment met a Xero supplementary invoice that could not be issued",
  );
  try {
    await sendAdminXeroSyncErrorAlert({
      errorType: "SUPPLEMENTARY_INVOICE_NOT_ISSUED_ON_CAPTURE",
      operation: `Supplementary invoice for captured payment ${params.paymentIntentId}`,
      errorMessage,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error(
      { err, operationId: params.operationId },
      "Failed to send the supplementary-invoice capture alert",
    );
  }
}
