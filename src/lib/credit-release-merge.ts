/**
 * #4491 (`INV-ADDPAY-052`): WHETHER A CREDIT RELEASE MERGES INTO THE UNPAID
 * REQUEST ALREADY OPEN ON ITS BOOKING.
 *
 * The owner's decision on #4253 (24 Oct 2026) is that a released-credit request
 * and an edit request open together are ONE request for the member, with the
 * card payment recorded in Xero against both invoices. An edit landing on an
 * unpaid release already merges: the edit's mint carries the release's balance
 * (`INV-PAY-098`). This is the other order. The release's mint carries the live
 * request's balance the same way (`sizeCreditReleaseAsk`) and supersedes it, and
 * nothing about the Xero split is new:
 *
 * - the release's own money is recorded on the booking's invoice by the sweep,
 *   which reads it off the ledger chain whichever row carried which
 *   (`planCreditReleasePayments`, `INV-ADDPAY-046`);
 * - each edit's own money stays on its supplementary invoice, which waits on
 *   the edit's card request and is moved onto the request carrying its balance
 *   by the supersede (`followSupersededAskInvoicesToCarrier`, `INV-PAY-140`),
 *   so the release request's capture releases it;
 * - the capture's receipt stands down for both (`readCaptureRecorder`).
 *
 * So the one question is whether that move WILL take every edit invoice of the
 * live request. Where it would not, superseding the edit would leave its
 * invoice behind and the capture's receipt would put the edit's money on the
 * booking's own invoice instead: the release waits behind the edit as before
 * (`INV-ADDPAY-051`) and is asked for once it is paid or withdrawn. Pure apart
 * from the loader at the bottom; the move re-decides everything under its keys.
 */
import { PaymentSource, PaymentTransactionKind, type PaymentStatus, type Prisma } from "@prisma/client";

import { isCreditReleaseAskReason } from "@/lib/additional-ask-cause";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { REISSUED_ASK_REASON } from "@/lib/payment-recovery-keys";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { findActiveSupplementaryInvoiceLink } from "@/lib/late-capture-xero-receipt";
import { readAskInvoicesForCarry, type AskInvoiceForCarry } from "@/lib/superseded-ask-invoice-carry";
import { findPrimaryInvoiceGapInvoice, readPrimaryInvoiceFeeAtLink, type GapAnchorStore } from "@/lib/xero-primary-invoice-gap-anchors";
import { SUPPLEMENTARY_INVOICE_CREATE_WHERE } from "@/lib/xero-supplementary-invoice-statuses";

export type CreditReleaseMergeRow = {
  id: string;
  source: PaymentSource;
  status: PaymentStatus;
  reason: string | null;
  amountCents: number;
  carriedAskCents: number;
  stripePaymentIntentId: string | null;
  withdrawnAt: Date | null;
  hadIssuedXeroInvoice: boolean | null;
  bookingModificationId: string | null;
};

/** Why the release waits instead of merging; recorded on the officers' note. */
export type CreditReleaseMergeWait =
  /** The live request is not the payment's newest card row, or the rows do not carry one another in full. */
  | "ledger-unreadable"
  /** A re-issued ask: what its carried money was billed on is recorded elsewhere, not followed here. */
  | "not-an-edit-request"
  /** An edit row that never recorded which invoice bills its money. */
  | "edit-billing-unknown"
  /** An edit billed on a supplementary invoice that is not waiting on its request (not queued yet, or retired). */
  | "edit-invoice-not-waiting"
  /** A supplementary invoice naming the request that the move would refuse (sent, failed, resolved, linked). */
  | "invoice-cannot-follow"
  /** Edit money on the booking's own invoice beside a supplementary invoice: the receipt would stand down for both. */
  | "mixed-billing"
  /**
   * An edit that came before the booking's invoice was raised, yet is billed on an invoice of its
   * own: a #3980 gap invoice anchored on it (an edit that raced the invoice's create) or any other
   * supplementary invoice. The merged capture's receipt would put its money on the booking's invoice.
   */
  | "edit-billed-on-its-own-invoice";

/** The officers' words for each reason (the audit note's summary, `INV-ADDPAY-051`). */
export const CREDIT_RELEASE_MERGE_WAIT_WORDS: Record<CreditReleaseMergeWait, string> = {
  "ledger-unreadable": "the booking's payment requests do not add up to the request that is open, so they were not combined",
  "not-an-edit-request": "the open request is a re-issued one, whose invoices are not followed automatically",
  "edit-billing-unknown": "the open request for a booking change does not record which Xero invoice bills it",
  "edit-invoice-not-waiting": "the booking change's Xero invoice is not waiting on its payment request (not queued yet, or retired), so it could not follow a combined request",
  "invoice-cannot-follow": "a Xero invoice for the open request has already been sent, failed, been resolved by hand or is linked, so it could not follow a combined request",
  "mixed-billing": "part of the open request is billed on the booking's own invoice and part on a change's invoice, which one combined payment cannot record correctly",
  "edit-billed-on-its-own-invoice": "the booking change is billed on an invoice of its own that the combined payment would not reach",
};

export type CreditReleaseMergeVerdict = { merge: true } | { merge: false; reason: CreditReleaseMergeWait };

const MERGE: CreditReleaseMergeVerdict = { merge: true };
const wait = (reason: CreditReleaseMergeWait): CreditReleaseMergeVerdict => ({ merge: false, reason });

/** The unpaid request the payment holds now: the rows after its last capture, officer-withdrawn rows aside, oldest first. */
export function unpaidRequestRows<T extends Pick<CreditReleaseMergeRow, "status" | "withdrawnAt">>(rowsOldestFirst: readonly T[]): T[] {
  const rows = rowsOldestFirst.filter((row) => !row.withdrawnAt);
  let lastCaptured = -1;
  rows.forEach((row, index) => {
    if (isCapturedTransactionStatus(row.status)) lastCaptured = index;
  });
  return rows.slice(lastCaptured + 1);
}

/**
 * The decision, given the payment's ADDITIONAL rows oldest first, the live request
 * its mirror names, and the supplementary invoices naming the request's intents.
 */
export function decideCreditReleaseMerge({
  rowsOldestFirst,
  live,
  invoices,
  editsWithOwnInvoice = new Set<string>(),
}: {
  rowsOldestFirst: readonly CreditReleaseMergeRow[];
  live: { paymentIntentId: string; amountCents: number };
  invoices: readonly AskInvoiceForCarry[];
  /** Edits with any live supplementary invoice of their own, the gap invoice's anchors included. */
  editsWithOwnInvoice?: ReadonlySet<string>;
}): CreditReleaseMergeVerdict {
  const chain = unpaidRequestRows(rowsOldestFirst);
  // A request made only of released credit is superseded as it always was (#4253): all of it stands
  // on the booking's invoice, and there is no edit invoice to follow. Its first row may have carried
  // a superseded release captured late, which the trace below would not read.
  if (chain.length > 0 && chain.every((row) => isCreditReleaseAskReason(row.reason))) return MERGE;
  const newest = chain.at(-1);
  if (!newest || newest.stripePaymentIntentId !== live.paymentIntentId || newest.amountCents !== live.amountCents) {
    return wait("ledger-unreadable");
  }
  // Each row absorbed all of the one before it and nothing from outside the request,
  // so every row's own money is inside the live amount exactly once.
  const traced = chain.every(
    (row, index) => row.source === PaymentSource.STRIPE && row.carriedAskCents === (index === 0 ? 0 : chain[index - 1]!.amountCents),
  );
  if (!traced) return wait("ledger-unreadable");

  let primaryBilled = false;
  for (const row of chain) {
    if (isCreditReleaseAskReason(row.reason)) continue;
    if (row.reason === REISSUED_ASK_REASON) return wait("not-an-edit-request");
    if (row.amountCents - row.carriedAskCents <= 0) continue;
    if (row.hadIssuedXeroInvoice === null) return wait("edit-billing-unknown");
    if (!row.hadIssuedXeroInvoice) {
      // The edit came before the booking's invoice, which billed it: the receipt records it there -
      // unless an invoice of its own bills it (a #3980 gap invoice, when it raced the create), which
      // a merged capture would never reach. An edit with no stamp cannot be checked.
      if (row.bookingModificationId === null) return wait("edit-billing-unknown");
      if (editsWithOwnInvoice.has(row.bookingModificationId)) return wait("edit-billed-on-its-own-invoice");
      primaryBilled = true;
      continue;
    }
    const waiting = invoices.some(
      (invoice) =>
        invoice.carriable &&
        ((row.bookingModificationId !== null && invoice.anchorId === row.bookingModificationId) ||
          invoice.firstWaitedOn === row.stripePaymentIntentId),
    );
    if (!waiting) return wait("edit-invoice-not-waiting");
  }
  if (invoices.some((invoice) => !invoice.carriable)) return wait("invoice-cannot-follow");
  if (primaryBilled && invoices.length > 0) return wait("mixed-billing");
  return MERGE;
}

const MERGE_ROW_SELECT = {
  id: true,
  source: true,
  status: true,
  reason: true,
  amountCents: true,
  carriedAskCents: true,
  stripePaymentIntentId: true,
  withdrawnAt: true,
  hadIssuedXeroInvoice: true,
  bookingModificationId: true,
} as const;

/**
 * The edits, of these, that a supplementary invoice of their own bills or will bill: one not
 * CANCELLED anchored on the edit, an active `SUPPLEMENTARY_INVOICE` link on it, or the booking
 * primary invoice's #3980 gap invoice, whose anchors are the edits that raced its create.
 */
async function editsWithOwnInvoice(
  store: GapAnchorStore,
  booking: { bookingId: string; xeroInvoiceId: string | null },
  modificationIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (modificationIds.length === 0) return found;
  const anchored = await store.xeroSyncOperation.findMany({
    where: { ...SUPPLEMENTARY_INVOICE_CREATE_WHERE, localModel: "BookingModification", localId: { in: [...modificationIds] }, status: { not: "CANCELLED" } },
    select: { localId: true },
  });
  for (const row of anchored) if (row.localId) found.add(row.localId);
  for (const id of modificationIds) {
    if (await findActiveSupplementaryInvoiceLink([{ localModel: "BookingModification", localId: id }], store)) found.add(id);
  }
  const figures = booking.xeroInvoiceId ? await readPrimaryInvoiceFeeAtLink(booking.bookingId, booking.xeroInvoiceId, store) : null;
  const gap = figures ? await findPrimaryInvoiceGapInvoice(booking.bookingId, figures, store) : null;
  if (gap && ((gap.operation && gap.operation.status !== "CANCELLED") || gap.link?.active)) {
    for (const id of gap.anchorIds) if (modificationIds.includes(id)) found.add(id);
  }
  return found;
}

/**
 * Read the facts and decide. Called before the release's Stripe mint (outside any
 * lock) and again on the claim's store under the Payment row lock, so a change in
 * between retries the row rather than superseding a request it would not merge.
 */
export async function readCreditReleaseMergeVerdict(
  store: GapAnchorStore & Pick<Prisma.TransactionClient, "paymentTransaction">,
  payment: { id: string; bookingId: string; xeroInvoiceId: string | null; additionalAmountCents: number; additionalPaymentIntentId: string },
): Promise<CreditReleaseMergeVerdict> {
  const rowsOldestFirst = await store.paymentTransaction.findMany({
    where: { paymentId: payment.id, kind: PaymentTransactionKind.ADDITIONAL },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: MERGE_ROW_SELECT,
  });
  const chain = unpaidRequestRows(rowsOldestFirst);
  const intentIds = chain.flatMap((row) => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
  const primaryBilledEdits = chain.flatMap((row) =>
    !isCreditReleaseAskReason(row.reason) && row.hadIssuedXeroInvoice === false && row.bookingModificationId ? [row.bookingModificationId] : [],
  );
  return decideCreditReleaseMerge({
    rowsOldestFirst,
    live: { paymentIntentId: payment.additionalPaymentIntentId, amountCents: payment.additionalAmountCents },
    invoices: await readAskInvoicesForCarry(store, intentIds),
    editsWithOwnInvoice: await editsWithOwnInvoice(store, payment, primaryBilledEdits),
  });
}
