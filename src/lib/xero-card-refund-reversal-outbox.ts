/**
 * The queued invoice that puts a failed card refund's money back in the
 * Stripe account (#4369, `INV-PAY-151`). The worker lives in
 * `xero-card-refund-reversal-invoice.ts`. This module only names the queue
 * type and reads the payload, so the shared outbox payload module stays
 * inside its line budget.
 */
import type { Prisma } from "@prisma/client";
import { asRecord, readNumber, readString } from "@/lib/xero-json";

// Anchored on the Payment; the close record is in the payload and the
// idempotency key.
export const XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE = "CARD_REFUND_REVERSAL_INVOICE";
export const CARD_REFUND_REVERSAL_INVOICE_ROLE = "CARD_REFUND_REVERSAL_INVOICE";
export const CARD_REFUND_REVERSAL_PAYMENT_ROLE = "CARD_REFUND_REVERSAL_PAYMENT";

/**
 * An invoice create on a Payment that bills the member. A reversal invoice is
 * not one of those (`INV-PAY-151`): readers that treat any invoice create on
 * the Payment as the booking's bill exclude it with this.
 *
 * #5017 review: null-safe. `queueType` is nullable and a plain
 * `NOT: { queueType: X }` is SQL `NOT (queueType = X)`, which also drops every
 * row with no queue type - an older booking-invoice create among them. The
 * `not: null` keeps those rows: `NOT (queueType = X AND queueType IS NOT NULL)`.
 */
export const NOT_CARD_REFUND_REVERSAL_INVOICE = {
  NOT: { queueType: { equals: XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE, not: null } },
} as const;

/** The same exclusion on an invoice link, which is named by role rather than queue type. */
export const NOT_CARD_REFUND_REVERSAL_INVOICE_LINK = {
  NOT: { role: CARD_REFUND_REVERSAL_INVOICE_ROLE },
} as const;

const CANCELLED_CARD_REFUND_REVERSAL_STATUSES = new Set(["VOIDED", "DELETED"]);

/**
 * Cents a live reversal invoice still takes off refund-note coverage. A voided
 * or deleted one, or one with no recorded amount, takes off nothing
 * (`INV-PAY-151`). A reversal that has not reached Xero has no link, so it is
 * not passed here.
 */
export function liveCardRefundReversalCents(metadata: unknown): number {
  const record = asRecord(metadata);
  const status = typeof record?.status === "string" ? record.status : "";
  return CANCELLED_CARD_REFUND_REVERSAL_STATUSES.has(status) ? 0 : raisedCardRefundReversalCents(metadata);
}

/**
 * #4370: cents a reversal invoice was raised for, live, voided or deleted. A
 * voided link keeps its stored cents (`retiredCardRefundReversalLink`), so the
 * inbound recount can tell a failed refund a reversal answered - even one
 * voided since, which then subtracts nothing - from one never reversed.
 */
export function raisedCardRefundReversalCents(metadata: unknown): number {
  const cents = asRecord(metadata)?.amountCents;
  return typeof cents === "number" && Number.isInteger(cents) && cents > 0 ? cents : 0;
}

/**
 * #5017 review (money M1, `INV-PAY-151`): THE REVERSALS A CLOSE HAS QUEUED
 * THAT HAVE NOT REACHED XERO YET. Coverage subtracts only a linked reversal
 * (`liveCardRefundReversalCents`), so a later close sizing its cover would
 * count a queued, sending or FAILED one's card note as still standing and
 * reverse it again. This is the payload amount of each of the payment's
 * reversal rows that is not CANCELLED and whose close has no reversal link
 * yet, active or retired. A linked one is coverage's to count; a voided one
 * reverses nothing. A row whose payload cannot be read counts nothing, as the
 * worker would raise nothing from it.
 */
export async function readPendingCardRefundReversalCents(
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation" | "xeroObjectLink">,
  paymentId: string,
): Promise<number> {
  const rows = await db.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      queueType: XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE,
      status: { not: "CANCELLED" },
    },
    select: { requestPayload: true },
  });
  if (rows.length === 0) return 0;
  const links = await db.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId: paymentId, xeroObjectType: "INVOICE", role: CARD_REFUND_REVERSAL_INVOICE_ROLE },
    select: { metadata: true },
  });
  const linkedCloses = new Set(links.map((link) => readString(asRecord(link.metadata)?.closeTaskId)).filter(Boolean));
  return rows.reduce((sum, row) => {
    const payload = readCardRefundReversalInvoicePayload(row.requestPayload);
    return payload && !linkedCloses.has(payload.closeTaskId) ? sum + payload.amountCents : sum;
  }, 0);
}

/**
 * What an inbound read of this invoice does to its reversal link (`INV-PAY-151`).
 * A voided or deleted invoice retires the link, keeping the cents already
 * stored. Any other status, and any other role, changes nothing.
 */
export function retiredCardRefundReversalLink(
  role: string,
  invoiceStatus: unknown,
): { active: false; metadata: { status: string }; mergeMetadata: true } | null {
  if (role !== CARD_REFUND_REVERSAL_INVOICE_ROLE) return null;
  const status = typeof invoiceStatus === "string" ? invoiceStatus.toUpperCase() : "";
  if (!CANCELLED_CARD_REFUND_REVERSAL_STATUSES.has(status)) return null;
  return { active: false, metadata: { status }, mergeMetadata: true };
}

/**
 * The covered cents of one Paid another way close, and the club day of that
 * close. The worker dates the invoice that day, or the first open day after a
 * Xero lock, and keeps this day in the reference.
 */
export interface QueuedCardRefundReversalInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE;
  bookingId: string;
  paymentId: string;
  closeTaskId: string;
  amountCents: number;
  /** `YYYY-MM-DD`, the club's calendar day of the close. */
  closedOn: string;
}

export function readCardRefundReversalInvoicePayload(
  value: unknown,
): QueuedCardRefundReversalInvoiceOutboxPayload | null {
  const payload = asRecord(value);
  if (!payload) return null;
  const bookingId = readString(payload.bookingId);
  const paymentId = readString(payload.paymentId);
  const closeTaskId = readString(payload.closeTaskId);
  const amountCents = readNumber(payload.amountCents);
  const closedOn = readString(payload.closedOn);
  if (
    !bookingId ||
    !paymentId ||
    !closeTaskId ||
    amountCents === null ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    !closedOn ||
    !/^\d{4}-\d{2}-\d{2}$/.test(closedOn)
  ) {
    return null;
  }
  return {
    queueType: XERO_OUTBOX_CARD_REFUND_REVERSAL_INVOICE_TYPE,
    bookingId,
    paymentId,
    closeTaskId,
    amountCents,
    closedOn,
  };
}
