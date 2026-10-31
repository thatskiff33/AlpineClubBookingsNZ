/**
 * #3953 (`INV-PAY-139`): where a booking change's card capture was recorded in
 * Xero by its own receipt (`additional-capture-xero-receipt.ts`) - the link
 * its Xero payment writes on the capture's `PaymentTransaction`, naming the
 * invoice it paid. A leaf, so the refund paths read it without the worker's
 * import graph (`INV-SSOT`: the one spelling of the role and the read).
 */
import type { Prisma } from "@prisma/client";
import { LIVE_KEPT_LATE_CAPTURE_INVOICE_WHERE } from "@/lib/late-capture-kept-xero-rules";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";
import { exactPrefix } from "@/lib/prisma-exact-prefix";
import { SUPPLEMENTARY_INVOICE_PAYMENT_ROLE } from "@/lib/xero-inbound/object-links";

/** A receipt that will still run: live, or failed/partial and not resolved by hand. */
import { XERO_RERUNNABLE_OPERATION_STATUSES as XERO_RERUNNABLE_RECEIPT_STATUSES } from "@/lib/xero-active-operation-statuses";

/** The link the capture's Xero payment writes, on its `PaymentTransaction`. */
export const ADDITIONAL_CAPTURE_PAYMENT_ROLE = "ADDITIONAL_CAPTURE_PAYMENT";

type ReceiptLinkStore = Pick<Prisma.TransactionClient, "paymentTransaction" | "xeroObjectLink" | "xeroSyncOperation">;

/**
 * #3953: the Xero invoice a capture's receipt's payment link names, on the
 * capture's `PaymentTransaction` (null while none is linked). The one read of
 * that link: the refund paths and (#4324) the late-capture receipt verdict
 * build on it.
 */
export async function readAdditionalCaptureReceiptLinkedInvoiceId(
  paymentTransactionId: string,
  store: Pick<Prisma.TransactionClient, "xeroObjectLink"> = prisma,
): Promise<string | null> {
  const link = await store.xeroObjectLink.findFirst({
    where: {
      localModel: "PaymentTransaction",
      localId: paymentTransactionId,
      xeroObjectType: "PAYMENT",
      role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
      active: true,
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const linked = asRecord(link?.metadata)?.invoiceId;
  return typeof linked === "string" && linked.length > 0 ? linked : null;
}

/**
 * #3953: the Xero invoice a capture's receipt was recorded against, from its
 * payment link, or - review round 1 (L) - the invoice its receipt row has
 * already decided on and is sending to (the plan stored before the Xero call).
 * Null otherwise. The refund paths read it, so a refund of that capture names
 * the invoice the capture paid.
 */
export async function findAdditionalCaptureReceiptInvoiceId(
  paymentIntentId: string,
  store: ReceiptLinkStore = prisma,
): Promise<string | null> {
  const transaction = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true },
  });
  if (!transaction) return null;
  const linked = await readAdditionalCaptureReceiptLinkedInvoiceId(transaction.id, store);
  if (linked) return linked;
  const pending = await store.xeroSyncOperation.findFirst({
    where: {
      localModel: "PaymentTransaction",
      localId: transaction.id,
      queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
      status: { notIn: ["CANCELLED", "SUCCEEDED"] },
    },
    orderBy: { createdAt: "desc" },
    select: { requestPayload: true },
  });
  const planned = asRecord(asRecord(pending?.requestPayload)?.plan)?.invoiceId;
  return typeof planned === "string" && planned.length > 0 ? planned : null;
}

/** The reason an officer's review charge carries, less its change: `buildEditFinancialReviewChargeReason`'s one spelling. */
const REVIEW_CHARGE_REASON_PREFIX = buildEditFinancialReviewChargeReason("");

/**
 * #3953 round 7: THE CHANGE A CAPTURE PAYS FOR - its ledger row's stamp
 * (`bookingModificationId`, every member price ask since #3954), else the
 * change an officer's review charge names in its deterministic reason. Null
 * for a capture neither attributes: an older member ask from before the stamp.
 */
export function captureChangeId(row: { bookingModificationId: string | null; reason: string | null }): string | null {
  if (row.bookingModificationId) return row.bookingModificationId;
  if (row.reason?.startsWith(REVIEW_CHARGE_REASON_PREFIX)) return row.reason.slice(REVIEW_CHARGE_REASON_PREFIX.length) || null;
  return null;
}

/**
 * The booking's change captures no change can be read from (`captureChangeId`
 * null): older member asks from before the stamp. A fixed set - every mint
 * since stamps its row - so it is read before any lock is taken.
 */
function unattributedCapturesWhere(bookingId: string): Prisma.PaymentTransactionWhereInput {
  return {
    payment: { bookingId },
    kind: "ADDITIONAL",
    bookingModificationId: null,
    // Literally - the prefix holds `_`, a LIKE wildcard (`exactPrefix`, #4146).
    OR: [{ reason: null }, { NOT: { reason: exactPrefix(REVIEW_CHARGE_REASON_PREFIX) } }],
  };
}

/** Whether the booking has such a capture (`unattributedCapturesWhere`). */
export async function bookingHasUnattributedCaptures(
  store: Pick<Prisma.TransactionClient, "paymentTransaction">,
  bookingId: string,
): Promise<boolean> {
  return (await store.paymentTransaction.count({ where: unattributedCapturesWhere(bookingId) })) > 0;
}

/**
 * #3953 round 7: whether a supplementary invoice on the booking records a
 * Stripe payment without naming the capture it records - the one kind of
 * document an unattributed capture's receipt cannot tell apart from its own
 * recorder. The receipt refuses, under the booking's lock, where one exists.
 * Round 9: also a change of the booking whose invoice's Stripe payment is
 * linked in Xero (`SUPPLEMENTARY_INVOICE_PAYMENT`) - an invoice raised before
 * #3641 may carry no outbox row this can read, and its link names no capture.
 * Round 11: only such a change - one with a live queued row naming its
 * capture, or marking a #3980 gap invoice, is explained by that row (it
 * records its named capture, or cash no receipt claims), so its link never
 * blocks.
 */
export async function bookingHasPaidUnnamedSupplementary(
  store: Pick<Prisma.TransactionClient, "xeroSyncOperation" | "bookingModification" | "xeroObjectLink">,
  bookingId: string,
): Promise<boolean> {
  const rows = await store.xeroSyncOperation.findMany({
    where: {
      queueType: "SUPPLEMENTARY_INVOICE",
      status: { not: "CANCELLED" },
      requestPayload: { path: ["bookingId"], equals: bookingId },
    },
    select: { requestPayload: true },
  });
  const unnamed = rows.some((row) => {
    const payload = asRecord(row.requestPayload);
    return payload?.recordPayment !== false && payload?.primaryInvoiceGap !== true && typeof payload?.paymentIntentId !== "string";
  });
  if (unnamed) return true;
  const changes = await store.bookingModification.findMany({ where: { bookingId }, select: { id: true } });
  if (changes.length === 0) return false;
  const paid = await store.xeroObjectLink.findMany({
    where: {
      localModel: "BookingModification",
      localId: { in: changes.map((change) => change.id) },
      role: SUPPLEMENTARY_INVOICE_PAYMENT_ROLE,
      active: true,
    },
    select: { localId: true },
  });
  if (paid.length === 0) return false;
  const queued = await store.xeroSyncOperation.findMany({
    where: {
      queueType: "SUPPLEMENTARY_INVOICE",
      localModel: "BookingModification",
      localId: { in: paid.map((link) => link.localId) },
      status: { not: "CANCELLED" },
    },
    select: { localId: true, requestPayload: true },
  });
  const explained = new Set(
    queued
      .filter((row) => {
        const payload = asRecord(row.requestPayload);
        return typeof payload?.paymentIntentId === "string" || payload?.primaryInvoiceGap === true;
      })
      .map((row) => row.localId),
  );
  return paid.some((link) => !explained.has(link.localId));
}

/**
 * #3953 review round 6 (item 1a): WHETHER A CAPTURE THIS SUPPLEMENTARY INVOICE
 * WOULD RECORD ALREADY HAS A RECEIPT RECORDING IT - its payment linked, its row
 * RUNNING, or a decision stored on it. The supplementary enqueue asks this
 * under the anchor's lock, and raises the invoice unpaid where it is so, so
 * one capture never has two recorders whatever a repair sweep's snapshot said.
 * The captures are those of the change (`bookingModificationId`) and the one
 * the invoice names (`paymentIntentId`).
 *
 * Round 12: `decidedOnly` counts only a payment linked or a decision stored,
 * never a bare RUNNING row - for the officer's Retry, which turns an EXISTING
 * invoice unpaid: a receipt never sends without first storing its decision
 * under this same anchor lock, after reading the invoice again, so a bare
 * running one stands down on that read and the invoice must stay paying. The
 * enqueue keeps counting it: there a NEW invoice is raised unpaid and the
 * running receipt, on that read, records against it - one recorder either
 * way, and the window between its claim and its store is covered.
 *
 * #4324 (`INV-PAY-144`): a kept late capture's own invoice
 * (`KEPT_LATE_CAPTURE_INVOICE`, any status but CANCELLED, its payload naming
 * the capture) counts in both modes: the keep queued it as the capture's
 * recorder, under this same anchor lock.
 */
export async function anchorCaptureHasReceipt(
  store: Pick<Prisma.TransactionClient, "paymentTransaction" | "xeroObjectLink" | "xeroSyncOperation">,
  input: { bookingId: string; bookingModificationId: string | null; paymentIntentId: string | null },
  options?: { decidedOnly?: boolean; queuedCounts?: boolean },
): Promise<boolean> {
  // Round 7: the change's captures by its stamp or its review charge's
  // reason, and the one the invoice names. Round 9: an invoice naming its
  // capture records that capture only, so the booking's captures no change
  // can be read from are asked about only for one naming none - the one kind
  // that might be recording them (`bookingHasPaidUnnamedSupplementary`).
  const arms: Prisma.PaymentTransactionWhereInput[] = [
    ...(input.bookingModificationId
      ? [
          { bookingModificationId: input.bookingModificationId },
          { reason: buildEditFinancialReviewChargeReason(input.bookingModificationId) },
        ]
      : []),
    ...(input.paymentIntentId ? [{ stripePaymentIntentId: input.paymentIntentId }] : []),
    ...(input.paymentIntentId ? [] : [unattributedCapturesWhere(input.bookingId)]),
  ];
  if (arms.length === 0) return false;
  const captures = await store.paymentTransaction.findMany({
    where: { kind: "ADDITIONAL", OR: arms },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: { id: true, stripePaymentIntentId: true },
  });
  const ids = captures.map((capture) => capture.id);
  if (ids.length === 0) return false;
  const intents = captures.flatMap((capture) => (capture.stripePaymentIntentId ? [capture.stripePaymentIntentId] : []));
  const [linked, receipts, kept] = await Promise.all([
    store.xeroObjectLink.findFirst({
      where: { localModel: "PaymentTransaction", localId: { in: ids }, role: ADDITIONAL_CAPTURE_PAYMENT_ROLE, active: true },
      select: { id: true },
    }),
    store.xeroSyncOperation.findMany({
      where: {
        localModel: "PaymentTransaction",
        localId: { in: ids },
        queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
        status: { not: "CANCELLED" },
      },
      select: { status: true, requestPayload: true, manuallyResolvedAt: true },
    }),
    keptInvoiceNamesCapture(store, intents),
  ]);
  return (
    linked !== null ||
    kept ||
    receipts.some(
      (receipt) =>
        (!options?.decidedOnly && receipt.status === "RUNNING") ||
        asRecord(receipt.requestPayload)?.plan != null ||
        // #3403 review 2 (F6): a receipt that has not decided yet - queued, or
        // failed before deciding and still re-runnable - will record the whole
        // capture when it runs, so a paying invoice must not be put in front of it.
        (options?.queuedCounts === true &&
          receipt.manuallyResolvedAt === null &&
          (XERO_RERUNNABLE_RECEIPT_STATUSES as readonly string[]).includes(receipt.status)),
    )
  );
}

/** #4324: whether a live kept-capture invoice (`KEPT_LATE_CAPTURE_INVOICE`, any status but CANCELLED) names one of these captures. */
async function keptInvoiceNamesCapture(
  store: Pick<Prisma.TransactionClient, "xeroSyncOperation">,
  intents: readonly string[],
): Promise<boolean> {
  if (intents.length === 0) return false;
  const kept = await store.xeroSyncOperation.findMany({
    where: {
      ...LIVE_KEPT_LATE_CAPTURE_INVOICE_WHERE,
      OR: intents.map((intent) => ({ requestPayload: { path: ["paymentIntentId"], equals: intent } })),
    },
    select: { queueType: true },
  });
  return kept.some((row) => row.queueType === LIVE_KEPT_LATE_CAPTURE_INVOICE_WHERE.queueType);
}

/**
 * #4324 (`INV-PAY-144`): WHETHER A KEPT-CAPTURE INVOICE BILLS THIS CHANGE - a
 * live one naming a capture of the change, which a treasurer's keep queued
 * under the change's anchor lock where nothing else billed it. It records the
 * change's money as income and its receipt both, so the supplementary enqueue
 * raises no new invoice for the change, paid or unpaid: either would count
 * that money twice (income on both, or a receivable left open for ever).
 */
export async function keptInvoiceBillsChangeCapture(
  store: Pick<Prisma.TransactionClient, "paymentTransaction" | "xeroSyncOperation">,
  bookingModificationId: string,
): Promise<boolean> {
  const captures = await store.paymentTransaction.findMany({
    where: {
      kind: "ADDITIONAL",
      stripePaymentIntentId: { not: null },
      OR: [{ bookingModificationId }, { reason: buildEditFinancialReviewChargeReason(bookingModificationId) }],
    },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: { stripePaymentIntentId: true },
  });
  return keptInvoiceNamesCapture(
    store,
    captures.flatMap((capture) => (capture.stripePaymentIntentId ? [capture.stripePaymentIntentId] : [])),
  );
}
