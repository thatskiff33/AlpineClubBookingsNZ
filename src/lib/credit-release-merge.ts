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
import { readAskInvoicesForCarry, type AskInvoiceForCarry } from "@/lib/superseded-ask-invoice-carry";

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
  | "mixed-billing";

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
}: {
  rowsOldestFirst: readonly CreditReleaseMergeRow[];
  live: { paymentIntentId: string; amountCents: number };
  invoices: readonly AskInvoiceForCarry[];
}): CreditReleaseMergeVerdict {
  const chain = unpaidRequestRows(rowsOldestFirst);
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
      // The edit came before the booking's invoice, which billed it: the receipt records it there.
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
 * Read the facts and decide. Called before the release's Stripe mint (outside any
 * lock) and again on the claim's store under the Payment row lock, so a change in
 * between retries the row rather than superseding a request it would not merge.
 */
export async function readCreditReleaseMergeVerdict(
  store: Pick<Prisma.TransactionClient, "paymentTransaction" | "xeroSyncOperation" | "xeroObjectLink">,
  payment: { id: string; additionalAmountCents: number; additionalPaymentIntentId: string },
): Promise<CreditReleaseMergeVerdict> {
  const rowsOldestFirst = await store.paymentTransaction.findMany({
    where: { paymentId: payment.id, kind: PaymentTransactionKind.ADDITIONAL },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: MERGE_ROW_SELECT,
  });
  const intentIds = unpaidRequestRows(rowsOldestFirst).flatMap((row) => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
  return decideCreditReleaseMerge({
    rowsOldestFirst,
    live: { paymentIntentId: payment.additionalPaymentIntentId, amountCents: payment.additionalAmountCents },
    invoices: await readAskInvoicesForCarry(store, intentIds),
  });
}
