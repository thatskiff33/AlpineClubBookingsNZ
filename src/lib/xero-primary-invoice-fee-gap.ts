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
 * THE FIGURE IS TAKEN AT THE LINK (#3955 round 4, finding 1). The gap is the
 * fee the payment recorded AT THE MOMENT its invoice link was saved, less what
 * the invoice billed — never the fee it records later. A fee recorded after
 * the link (an ordinary edit's increment, with its own credit note or
 * supplementary invoice) is billed by that edit's own document, so counting it
 * here would bill it twice. {@link persistPrimaryInvoiceLink} saves the link,
 * reads the fee back from that same row update, and records both figures on
 * the create operation in ONE transaction: the update's row lock orders it
 * against a correction's claimed fee write (`recordFinishedStayFeeOwed`), so
 * the figure read back holds every fee routed to this invoice and none after.
 *
 * RETRY-SAFE (#3955 round 3, finding 2). A run that dies after the link is
 * saved is re-driven through the create's "invoice already exists" exit, which
 * re-runs the check from the stored figures alone
 * ({@link recheckPrimaryInvoiceChangeFeeGap}). A gap already queued on one of
 * its anchors is not queued again.
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

/** What the invoice billed, and the fee its payment recorded when the link was saved. */
export interface PrimaryInvoiceFeeAtLink extends PrimaryInvoiceBilledFee {
  readonly recordedChangeFeeCentsAtLink: number;
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

/**
 * #1641 / #3955 round 4 (finding 3): the applied account credit a CARD
 * invoice's settle allocates against the primary invoice — the payment's
 * credit-reduced mirror, for a card capture with net cash left. Zero for
 * internet banking (its own outbox op allocates), an uncaptured or refunded-out
 * payment, and a full-price capture (`creditAppliedCents = 0`), which must not
 * allocate. The settle's gate and the primary payment's cap both read it.
 */
export function cardAppliedCreditCents(payment: {
  source: PaymentSource | null;
  status: string;
  amountCents: number;
  refundedAmountCents: number | null;
  creditAppliedCents: number;
}): number {
  const netCapturedCents = payment.amountCents - (payment.refundedAmountCents ?? 0);
  if (
    payment.source === PaymentSource.INTERNET_BANKING ||
    !hasCapturedPayment(payment) ||
    netCapturedCents <= 0 ||
    !(payment.creditAppliedCents > 0)
  ) {
    return 0;
  }
  return payment.creditAppliedCents;
}

/**
 * The Stripe cash recorded against the primary invoice: the net capture,
 * capped at what is due once the applied credit the settle allocates there is
 * allowed for — so that allocation always fits (Xero rejects one beyond the
 * amount due). An invoice built before a fee was recorded bills less than cash
 * plus credit; the cash this leaves over is the gap invoice's (finding 3).
 * `amountDueCents` null (Xero sent none) caps at the net capture alone.
 */
export function primaryInvoiceStripeCashCents(input: {
  netCapturedCents: number;
  amountDueCents: number | null;
  appliedCreditCents: number;
}): number {
  if (input.amountDueCents === null) return input.netCapturedCents;
  return Math.max(0, Math.min(input.netCapturedCents, input.amountDueCents - input.appliedCreditCents));
}

/** The create operation's payload key the figures are kept under. */
const FEE_AT_LINK_KEY = "primaryInvoiceBilledFee";

/**
 * Saves the payment's invoice link and, in the SAME transaction, records on
 * the create operation what the invoice billed and the fee the payment held
 * at that instant — read back from the link's own row update. Either both
 * commit or neither does, so every saved link has its figures, and no later
 * fee can be mistaken for one the invoice should have billed.
 */
export async function persistPrimaryInvoiceLink(input: {
  operationId: string;
  paymentId: string;
  xeroInvoiceNumber: string | null;
  billed: PrimaryInvoiceBilledFee;
}): Promise<PrimaryInvoiceFeeAtLink> {
  return prisma.$transaction(async (tx) => {
    const linked = await tx.payment.update({
      where: { id: input.paymentId },
      data: { xeroInvoiceId: input.billed.xeroInvoiceId, xeroInvoiceNumber: input.xeroInvoiceNumber },
      select: { changeFeeCents: true },
    });
    const atLink: PrimaryInvoiceFeeAtLink = {
      ...input.billed,
      recordedChangeFeeCentsAtLink: recordedChangeFeeCents(linked),
    };
    const operation = await tx.xeroSyncOperation.findUnique({
      where: { id: input.operationId },
      select: { requestPayload: true },
    });
    await tx.xeroSyncOperation.update({
      where: { id: input.operationId },
      data: {
        requestPayload: sanitizeForJson({
          ...(asRecord(operation?.requestPayload) ?? {}),
          [FEE_AT_LINK_KEY]: atLink,
        }),
      },
    });
    return atLink;
  });
}

async function readPrimaryInvoiceFeeAtLink(
  bookingId: string,
  xeroInvoiceId: string,
): Promise<PrimaryInvoiceFeeAtLink | null> {
  const operation = await prisma.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
      requestPayload: { path: [FEE_AT_LINK_KEY, "xeroInvoiceId"], equals: xeroInvoiceId },
    },
    orderBy: { createdAt: "desc" },
    select: { requestPayload: true },
  });
  const record = asRecord(asRecord(operation?.requestPayload)?.[FEE_AT_LINK_KEY]);
  if (
    !record ||
    typeof record.billedChangeFeeCents !== "number" ||
    typeof record.billedTotalCents !== "number" ||
    typeof record.recordedChangeFeeCentsAtLink !== "number"
  ) {
    return null;
  }
  return {
    xeroInvoiceId,
    billedChangeFeeCents: record.billedChangeFeeCents,
    billedTotalCents: record.billedTotalCents,
    recordedChangeFeeCentsAtLink: record.recordedChangeFeeCentsAtLink,
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
 * The create's "invoice already exists" exit re-runs the check from the
 * figures stored with the link — never the fee the payment records now, which
 * may include a later edit's fee billed on that edit's own document.
 *
 * An invoice with no stored figures was linked before this check existed, or
 * outside the create; there is nothing to compare, so nothing is billed. That
 * is loud when the payment records a fee, because such a fee may be unbilled
 * (`INV-PAY-119`'s limit; #3955 round 4, finding 2).
 */
export async function recheckPrimaryInvoiceChangeFeeGap(input: {
  bookingId: string;
  xeroInvoiceId: string;
  createdByMemberId?: string;
}): Promise<PrimaryInvoiceChangeFeeGapResult> {
  const atLink = await readPrimaryInvoiceFeeAtLink(input.bookingId, input.xeroInvoiceId);
  if (!atLink) {
    const payment = await prisma.payment.findUnique({
      where: { bookingId: input.bookingId },
      select: { changeFeeCents: true },
    });
    const recordedCents = recordedChangeFeeCents(payment);
    if (recordedCents > 0) {
      logger.warn(
        { bookingId: input.bookingId, xeroInvoiceId: input.xeroInvoiceId, recordedChangeFeeCents: recordedCents },
        "The booking's primary Xero invoice has no change-fee figures from its link, so whether it billed the fee its payment records is not checked (#3955 X4)",
      );
    }
    return NO_GAP;
  }
  return queuePrimaryInvoiceChangeFeeGap({
    bookingId: input.bookingId,
    atLink,
    createdByMemberId: input.createdByMemberId,
  });
}

/**
 * Bills the gap between the fee the payment recorded when the invoice link was
 * saved and the fee the primary invoice billed — both from `atLink`, never a
 * fresh read of the fee.
 *
 * THE ANCHOR is a finished-stay correction that routed its fee to the primary
 * invoice (`feeOnPrimaryInvoice`): one made while no invoice was linked, whose
 * claimed fee write (`recordFinishedStayFeeOwed`) therefore committed before
 * the link was saved. None of those raised a document of its own, so a
 * supplementary invoice on one of them is this gap's and nothing else's —
 * which is also how a re-run knows the gap is already queued, and why it never
 * raises another edit's queued figure. The ordinary settled edit's fee write is
 * not claimed against the link (`INV-PAY-119`, #3980), so a gap no correction
 * explains has no anchor and is reported, not billed.
 */
export async function queuePrimaryInvoiceChangeFeeGap(input: {
  bookingId: string;
  atLink: PrimaryInvoiceFeeAtLink;
  createdByMemberId?: string;
}): Promise<PrimaryInvoiceChangeFeeGapResult> {
  const { bookingId, atLink } = input;
  const gapCents = atLink.recordedChangeFeeCentsAtLink - atLink.billedChangeFeeCents;
  const context = {
    bookingId,
    xeroInvoiceId: atLink.xeroInvoiceId,
    billedCents: atLink.billedChangeFeeCents,
    recordedChangeFeeCentsAtLink: atLink.recordedChangeFeeCentsAtLink,
  };
  if (gapCents <= 0) {
    if (gapCents < 0) {
      // No writer lowers a recorded fee, so an invoice billing MORE than the
      // payment recorded was built from figures that no longer stand. Loud,
      // not corrected: a credit note is a treasurer's decision.
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
  // Stripe payment already holds the money: the cash the primary invoice's
  // payment could not take (`primaryInvoiceStripeCashCents`, capped so the
  // applied credit the settle allocates there fits) is the gap's (finding 3).
  const payment = await prisma.payment.findUnique({
    where: { bookingId },
    select: {
      source: true,
      status: true,
      amountCents: true,
      refundedAmountCents: true,
      creditAppliedCents: true,
    },
  });
  const netCapturedCents = Math.max(0, (payment?.amountCents ?? 0) - (payment?.refundedAmountCents ?? 0));
  const leftOverCashCents = payment
    ? netCapturedCents -
      primaryInvoiceStripeCashCents({
        netCapturedCents,
        amountDueCents: atLink.billedTotalCents,
        appliedCreditCents: cardAppliedCreditCents(payment),
      })
    : 0;
  const recordPayment =
    payment?.source === PaymentSource.STRIPE && hasCapturedPayment(payment) && leftOverCashCents >= gapCents;

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
