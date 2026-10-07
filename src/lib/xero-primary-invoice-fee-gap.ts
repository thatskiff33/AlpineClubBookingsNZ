/**
 * #3955 review X4 (`INV-PAY-119`): the primary invoice bills the change fee
 * recorded on the payment (`recordedChangeFeeCents`), but it is built before
 * Xero is asked for anything. Two things can leave it billing less:
 *
 *  - a finished-stay correction that recorded a fee on the unpaid booking while
 *    the create was in flight (its lines were already built); and
 *  - a lost response retried under the same idempotency key, which makes Xero
 *    hand back the ORIGINAL invoice whatever the retry's payload now says.
 *
 * So the create compares the fee on the invoice Xero returned with the fee the
 * payment records once its link is persisted, and bills any gap on a
 * supplementary invoice — never dropped. The correction claims its fee write
 * against the invoice link it read, which is what makes a read after the link
 * is persisted complete: a fee written after it is refused, and the edit
 * routes it again on its next approval.
 *
 * RETRY-SAFE (#3955 round 3, finding 2). What the invoice billed is recorded on
 * the create operation BEFORE the link is persisted
 * ({@link recordPrimaryInvoiceBilledFee}). A run that dies after persisting the
 * link — before or inside the check — is re-driven through the create's
 * "invoice already exists" exit, which re-runs the check from that record
 * ({@link recheckPrimaryInvoiceChangeFeeGap}). The check is idempotent: the gap
 * for one primary invoice is fixed once its link is persisted, so a gap already
 * queued on one of its anchors is not queued again.
 */
import { PaymentSource } from "@prisma/client";
import type { LineItem } from "xero-node";

import { hasCapturedPayment, recordedChangeFeeCents } from "@/lib/booking-payment-state";
import { FEE_ON_PRIMARY_INVOICE_PATH } from "@/lib/booking-finished-stay-correction";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { asRecord } from "@/lib/xero-json";
import {
  CHANGE_FEE_LINE_DESCRIPTION,
  invoiceLineItemsTotalCents,
} from "@/lib/xero-modification-line-items";
import { enqueueXeroSupplementaryInvoiceOperation } from "@/lib/xero-operation-outbox";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { sanitizeForJson } from "@/lib/xero-sync";

/** The change fee an invoice's lines bill: its change-fee lines, as Xero adds them. */
export function billedChangeFeeCents(lineItems: ReadonlyArray<LineItem>): number {
  return invoiceLineItemsTotalCents(
    lineItems.filter((line) => line.description === CHANGE_FEE_LINE_DESCRIPTION),
  );
}

/** What a primary invoice billed, as the gap check needs it. */
export interface PrimaryInvoiceBilledFee {
  readonly xeroInvoiceId: string;
  /** Its change-fee lines. */
  readonly billedChangeFeeCents: number;
  /** All its lines: what a Stripe payment recorded against it can have settled. */
  readonly billedTotalCents: number;
}

export function primaryInvoiceBilledFee(
  xeroInvoiceId: string,
  lineItems: ReadonlyArray<LineItem>,
): PrimaryInvoiceBilledFee {
  return {
    xeroInvoiceId,
    billedChangeFeeCents: billedChangeFeeCents(lineItems),
    billedTotalCents: invoiceLineItemsTotalCents(lineItems),
  };
}

/** The create operation's payload key the billed figure is kept under. */
const BILLED_FEE_KEY = "primaryInvoiceBilledFee";

/**
 * Records what the invoice billed on the create operation, merged into its
 * payload. Called after Xero returned the invoice and BEFORE the payment's link
 * is persisted, so every persisted link has a record a retry can read. The
 * handler's wholesale payload rewrites all happen before the provider call, so
 * nothing later in the run removes it.
 */
export async function recordPrimaryInvoiceBilledFee(
  operationId: string,
  billed: PrimaryInvoiceBilledFee,
): Promise<void> {
  const operation = await prisma.xeroSyncOperation.findUnique({
    where: { id: operationId },
    select: { requestPayload: true },
  });
  await prisma.xeroSyncOperation.update({
    where: { id: operationId },
    data: {
      requestPayload: sanitizeForJson({
        ...(asRecord(operation?.requestPayload) ?? {}),
        [BILLED_FEE_KEY]: billed,
      }),
    },
  });
}

async function readPrimaryInvoiceBilledFee(
  bookingId: string,
  xeroInvoiceId: string,
): Promise<PrimaryInvoiceBilledFee | null> {
  const operation = await prisma.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
      requestPayload: { path: [BILLED_FEE_KEY, "xeroInvoiceId"], equals: xeroInvoiceId },
    },
    orderBy: { createdAt: "desc" },
    select: { requestPayload: true },
  });
  const record = asRecord(asRecord(operation?.requestPayload)?.[BILLED_FEE_KEY]);
  if (
    !record ||
    typeof record.billedChangeFeeCents !== "number" ||
    typeof record.billedTotalCents !== "number"
  ) {
    return null;
  }
  return {
    xeroInvoiceId,
    billedChangeFeeCents: record.billedChangeFeeCents,
    billedTotalCents: record.billedTotalCents,
  };
}

export type PrimaryInvoiceChangeFeeGapResult = {
  gapCents: number;
  queueOperationId: string | null;
  /** The gap was already queued by an earlier run of this check. */
  alreadyQueued: boolean;
};

const NO_GAP: PrimaryInvoiceChangeFeeGapResult = { gapCents: 0, queueOperationId: null, alreadyQueued: false };

/**
 * The create's "invoice already exists" exit re-runs the check from the figure
 * recorded before the link was persisted. An invoice with no record was raised
 * before the check existed, or by a run that never persisted its link through
 * this module; there is nothing to compare, so nothing is billed.
 */
export async function recheckPrimaryInvoiceChangeFeeGap(input: {
  bookingId: string;
  xeroInvoiceId: string;
  createdByMemberId?: string;
}): Promise<PrimaryInvoiceChangeFeeGapResult> {
  const billed = await readPrimaryInvoiceBilledFee(input.bookingId, input.xeroInvoiceId);
  if (!billed) return NO_GAP;
  return queuePrimaryInvoiceChangeFeeGap({
    bookingId: input.bookingId,
    billed,
    createdByMemberId: input.createdByMemberId,
  });
}

/**
 * Bills the gap between the fee the payment records and the fee the primary
 * invoice billed. Run only after the payment's invoice link is persisted.
 *
 * THE ANCHOR is a finished-stay correction that routed its fee to the primary
 * invoice (`feeOnPrimaryInvoice`): one made while no invoice was linked, whose
 * claimed fee write (`recordFinishedStayFeeOwed`) therefore committed before
 * the link was persisted. None of those raised a document of its own, so a
 * supplementary invoice on one of them is this gap's and nothing else's —
 * which is also how a re-run knows the gap is already queued, and why it never
 * raises another edit's queued figure. The ordinary settled edit's fee write is
 * not claimed against the link (`INV-PAY-119`, #3980), so a gap no correction
 * explains has no anchor and is reported, not billed.
 */
export async function queuePrimaryInvoiceChangeFeeGap(input: {
  bookingId: string;
  billed: PrimaryInvoiceBilledFee;
  createdByMemberId?: string;
}): Promise<PrimaryInvoiceChangeFeeGapResult> {
  const { bookingId, billed } = input;
  const payment = await prisma.payment.findUnique({
    where: { bookingId },
    select: {
      changeFeeCents: true,
      source: true,
      status: true,
      amountCents: true,
      refundedAmountCents: true,
    },
  });
  const recordedCents = recordedChangeFeeCents(payment);
  const gapCents = recordedCents - billed.billedChangeFeeCents;
  const context = {
    bookingId,
    xeroInvoiceId: billed.xeroInvoiceId,
    billedCents: billed.billedChangeFeeCents,
    recordedChangeFeeCents: recordedCents,
  };
  if (gapCents <= 0) {
    if (gapCents < 0) {
      // No writer lowers a recorded fee, so an invoice billing MORE than the
      // payment records was built from figures that no longer stand. Loud, not
      // corrected: a credit note is a treasurer's decision.
      logger.error(
        context,
        "The booking's primary Xero invoice bills more change fee than its payment records (#3955 X4)",
      );
    }
    return NO_GAP;
  }

  const anchors = await prisma.bookingModification.findMany({
    where: {
      bookingId,
      changeFeeCents: { gt: 0 },
      newData: { path: [...FEE_ON_PRIMARY_INVOICE_PATH], equals: true },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (anchors.length === 0) {
    logger.error(
      { ...context, gapCents },
      "The booking's primary Xero invoice bills less change fee than its payment records, and no finished-stay correction routed a fee to it to anchor the remainder on (#3955 X4, #3980)",
    );
    return { gapCents, queueOperationId: null, alreadyQueued: false };
  }

  const anchorIds = anchors.map((anchor) => anchor.id);
  const [earlierOperation, earlierLink] = await Promise.all([
    prisma.xeroSyncOperation.findFirst({
      where: {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        localModel: "BookingModification",
        localId: { in: anchorIds },
      },
      select: { id: true },
    }),
    prisma.xeroObjectLink.findFirst({
      where: {
        localModel: "BookingModification",
        localId: { in: anchorIds },
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
      },
      select: { id: true },
    }),
  ]);
  if (earlierOperation || earlierLink) {
    logger.info(
      { ...context, gapCents, queueOperationId: earlierOperation?.id ?? null },
      "The booking's primary Xero invoice change-fee gap is already queued (#3955 X4)",
    );
    return { gapCents, queueOperationId: earlierOperation?.id ?? null, alreadyQueued: true };
  }

  // Raised UNPAID like any edit's supplementary invoice, unless a captured
  // Stripe payment already holds the money: what it nets beyond the primary
  // invoice's total is cash the primary's recorded payment could not take
  // (it is capped at the invoice's amount due).
  const netCapturedCents = Math.max(0, (payment?.amountCents ?? 0) - (payment?.refundedAmountCents ?? 0));
  const recordPayment =
    payment?.source === PaymentSource.STRIPE &&
    hasCapturedPayment(payment) &&
    netCapturedCents - billed.billedTotalCents >= gapCents;

  const queued = await enqueueXeroSupplementaryInvoiceOperation(
    {
      bookingId,
      priceDiffCents: 0,
      changeFeeCents: gapCents,
      bookingModificationId: anchorIds[0],
    },
    { createdByMemberId: input.createdByMemberId, recordPayment },
  );
  const outcome = {
    ...context,
    gapCents,
    bookingModificationId: anchorIds[0],
    recordPayment,
    queueOperationId: queued.queueOperationId,
    enqueueOutcome: queued.outcome,
  };
  // No earlier operation on any anchor, so "covers-total" is the fresh one
  // (or a concurrent run's of this same gap, which the enqueue's anchor lock
  // makes the one operation). Anything else bills nothing.
  if (queued.outcome !== "covers-total" || !queued.queueOperationId) {
    logger.error(
      outcome,
      "The booking's primary Xero invoice bills less change fee than its payment records, and the supplementary invoice for the remainder was not queued (#3955 X4)",
    );
    return { gapCents, queueOperationId: queued.queueOperationId, alreadyQueued: false };
  }
  logger.warn(
    outcome,
    "The booking's primary Xero invoice was built before a change fee was recorded; the remainder is billed on a supplementary invoice (#3955 X4)",
  );
  return { gapCents, queueOperationId: queued.queueOperationId, alreadyQueued: false };
}
