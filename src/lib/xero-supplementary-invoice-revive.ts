/**
 * The one write that revives a retired supplementary invoice (#4382, #3641).
 * Split from `xero-supplementary-invoice-late-capture.ts` so that module stays
 * inside its size budget. Callers hold the supplementary-invoice anchor lock.
 * No email and no provider call.
 */
import type { Prisma } from "@prisma/client";

import { anchorCaptureHasReceipt } from "@/lib/additional-capture-receipt-link";
import { asRecord } from "@/lib/xero-json";
import { OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES } from "@/lib/xero-operation-outbox";
import {
  SUPPLEMENTARY_INVOICE_CREATE_WHERE,
  supplementaryInvoicesNamingIntentWhere,
} from "@/lib/xero-supplementary-invoice-statuses";
import {
  billedByOthers,
  CAPTURED_NOT_ISSUED_ERROR_CODE,
  COVERED_ERROR_CODE,
  captureRefusalFor,
  ISSUE_REFUSAL_TEXT,
  STALE_WAITING_PAYMENT_ERROR_CODE,
  type CapturedTransaction,
  type IssueRefusal,
} from "@/lib/xero-supplementary-invoice-late-capture";

export type RetiredInvoiceRevival =
  | { outcome: "requeued" }
  | { outcome: "already" }
  | { outcome: "refused"; reason: IssueRefusal };

/**
 * THE RETIRED-ROW STEP, one body for both callers (`INV-SSOT`). The caller
 * holds `lockSupplementaryInvoiceAnchor` on `anchorId` for the whole call.
 * No email and no provider call: the release sends the officer alert after
 * this returns `refused`.
 *
 * `stampRefusal` is false for the keep. A refusal (the capture does not cover
 * the invoice, the change is already linked, or another invoice is queued)
 * then writes nothing, so the after-commit release still stamps
 * `STALE_WAITING_PAYMENT_CAPTURED` and emails the officer together. A covering
 * invoice, and a revival with its older rows stamped covered, do commit.
 */
export async function reviveRetiredSupplementaryInvoice(
  tx: Prisma.TransactionClient,
  {
    operation,
    anchorId,
    supersededIds,
    paymentIntentId,
    transaction,
    bookingId,
    stampRefusal,
  }: {
    operation: {
      id: string;
      localModel: string;
      requestPayload: Prisma.JsonValue | null;
    };
    anchorId: string;
    /** Older retired rows on this change and intent: stamped covered when this revival or a covering invoice commits. */
    supersededIds: string[];
    paymentIntentId: string;
    transaction: CapturedTransaction;
    /** The capture's booking, for its receipt check (#3953); null with no capture. */
    bookingId: string | null;
    stampRefusal: boolean;
  },
): Promise<RetiredInvoiceRevival> {
  const retiredIds = [operation.id, ...supersededIds];
  const stampCovered = (ids: string[], message: string) =>
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

  // An invoice for this SAME request already on its way or sent (the repair
  // tool re-parked one on this intent and it has been released, or sent)
  // covers the capture. Checked first, because once that one is sent the
  // change carries an active link, and reading that as "already linked" is the
  // false alarm a correct booking must not raise.
  const covering = await tx.xeroSyncOperation.findFirst({
    where: {
      ...SUPPLEMENTARY_INVOICE_CREATE_WHERE,
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
      retiredIds,
      `Retired, and the linked payment was captured later; outbox operation ${covering.id} already invoices that payment.`,
    );
    return { outcome: "already" };
  }

  const others = await tx.xeroSyncOperation.findMany({
    where: { ...supplementaryInvoicesNamingIntentWhere(paymentIntentId), id: { notIn: retiredIds } },
    select: { requestPayload: true },
  });
  let refusal: IssueRefusal | null = captureRefusalFor(transaction, operation.requestPayload, billedByOthers(others));
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
          ...SUPPLEMENTARY_INVOICE_CREATE_WHERE,
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

  // The keep leaves a refusal for the after-commit release, stamp and alert
  // together. Nothing is written, including the older rows' covered stamps.
  if (refusal && !stampRefusal) return { outcome: "refused", reason: refusal };

  await stampCovered(
    supersededIds,
    `Retired, and superseded by the newer invoice ${operation.id} for the same payment request, which that payment's capture was decided against.`,
  );

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
    return claimed.count === 1 ? { outcome: "refused", reason: refusal } : { outcome: "already" };
  }

  // #3953 round 8 (`INV-PAY-139`): the capture's own receipt may already
  // record it - linked, RUNNING or with a decision stored, which it stores
  // under this same anchor lock - so the invoice is revived unpaid there:
  // it still bills the change, and the capture has one recorder.
  const payload = asRecord(operation.requestPayload) ?? {};
  const unpaid =
    bookingId !== null &&
    payload.recordPayment !== false &&
    (await anchorCaptureHasReceipt(tx, {
      bookingId,
      bookingModificationId: operation.localModel === "BookingModification" ? anchorId : null,
      paymentIntentId,
    }));
  const revived = await tx.xeroSyncOperation.updateMany({
    where: {
      id: operation.id,
      status: "CANCELLED",
      lastErrorCode: STALE_WAITING_PAYMENT_ERROR_CODE,
    },
    data: {
      ...(unpaid ? { requestPayload: { ...payload, recordPayment: false } as Prisma.InputJsonObject } : {}),
      status: "PENDING",
      startedAt: null,
      completedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  return revived.count === 1 ? { outcome: "requeued" } : { outcome: "already" };
}
