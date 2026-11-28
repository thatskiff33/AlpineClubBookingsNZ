/**
 * THE PAYMENT-FIRST COMPLETION (`INV-LOCK-002`, `INV-INT-029`): the transaction
 * a Xero operation's completion runs in when it writes something a `Payment`
 * row guards, in the create's record order. Every Payment row it names first
 * (ids sorted, `lockPaymentForRefundedTotal`, the Payment-row wait budget),
 * then `complete`: the guarded claim on the operation row, then the links.
 * Nothing waits on a Payment row while holding the operation row.
 *
 * Two intents name Payment rows, and one completion may carry both:
 *
 * - #4279: a refund note adopted as the payment's one refund note
 *   (`canonicalRefundNote`), only in a retry claim's own completion;
 * - #5289 B: an edit's or clearing note's own allocation to an invoice, by
 *   the readers' rule (`isClearingAllocationLinkRoleAndAnchor`: the note's own
 *   role, or the role-less one a generic allocation retry writes on the note's
 *   anchor): the invoice's one bank-transfer payment, by the
 *   settle's rule (`bankTransferPaymentIdsOfInvoices`), whose whole refunded
 *   total is decided after the links under that row
 *   (`decideBankTransferRefundedTotal`), moving its `updatedAt`, exactly as the
 *   inbound sync's allocation write decides it (`INV-PAY-126`). So a kept
 *   settle holding the row either already counted the allocation or is waited
 *   for, and a cancel queued behind it reads a net that counts it. The floor's
 *   alert goes out after the commit.
 *
 * An injected store is refused for either: this transaction must take the
 * Payment rows before its claim, and a caller's transaction may already hold
 * other rows. A refused claim that writes no link decides nothing.
 */
import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { asRecord, readString } from "@/lib/xero-json";
import type { CanonicalRefundNoteAdoption } from "@/lib/xero-refund-note-adoption";
import { isClearingAllocationLinkRoleAndAnchor } from "@/lib/xero-note-allocation-link-roles";

/** #5289 B: the invoices a completion's own note allocations name, and the note. */
export type NoteAllocationIntent = { creditNoteId: string | null; invoiceIds: string[] };

/** A completion's extra link, in the fields this reads. */
type CompletionLink = { localModel: string; xeroObjectType: string; role: string; active?: boolean; metadata?: unknown };

/**
 * #5289 B: the note allocations a completion writes on (its active
 * `extraLinks` the refunded-total readers would count as a note's allocation),
 * or null when it writes none.
 */
export function noteAllocationIntentOf(extraLinks: readonly CompletionLink[] | undefined): NoteAllocationIntent | null {
  const allocations = (extraLinks ?? []).filter(
    (link) => link.xeroObjectType === "ALLOCATION" && isClearingAllocationLinkRoleAndAnchor(link) && link.active !== false,
  );
  const invoiceIds = [...new Set(allocations.map((link) => readString(asRecord(link.metadata)?.invoiceId)).filter((id): id is string => id !== null))];
  if (invoiceIds.length === 0) return null;
  return { creditNoteId: allocations.map((link) => readString(asRecord(link.metadata)?.creditNoteId)).find((id) => id !== null) ?? null, invoiceIds };
}

type InteractiveTransactionRunner = {
  $transaction<R>(run: (tx: Prisma.TransactionClient) => Promise<R>, options?: { maxWait?: number; timeout?: number }): Promise<R>;
};

/**
 * Run `complete` in the Payment-first transaction for the intents given. Only
 * a retry's own claim may carry an adoption (a refused retry claim writes
 * nothing at all, so a lost claim publishes no pointer and no link); no
 * caller's store may carry either. `linksRecorded` answers, after `complete`,
 * whether it wrote the completion's links (a won claim, or a success refused
 * on a later claim that still records them); only then are totals decided.
 */
export async function completeUnderPaymentRows<T>(
  db: InteractiveTransactionRunner,
  intents: { adoption?: CanonicalRefundNoteAdoption; allocation?: NoteAllocationIntent | null },
  options: { store?: Prisma.TransactionClient; retryClaim?: true } | undefined,
  complete: (tx: Prisma.TransactionClient) => Promise<T>,
  linksRecorded: () => boolean,
): Promise<T> {
  const { adoption, allocation } = intents;
  if (adoption && (options?.store || !options?.retryClaim)) {
    throw new Error(
      `Refund credit note ${adoption.creditNoteId} may become payment ${adoption.paymentId}'s refund note only in a retry claim's own completion transaction (#4279).`,
    );
  }
  if (allocation && options?.store) {
    throw new Error(
      `Credit note ${allocation.creditNoteId ?? "(unknown)"}'s allocation must complete in its own transaction, which takes the payment's Payment row before the operation row (#5289).`,
    );
  }
  // Loaded when needed, as the link funnel loads them, so coverage readers cannot initialise through a cycle.
  const [{ lockPaymentForRefundedTotal, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS }, { bankTransferPaymentIdsOfInvoices }, { decideBankTransferRefundedTotal, sendFloorAlerts }] =
    await Promise.all([
      import("@/lib/payment-transactions"),
      import("@/lib/xero-inbound/bank-transfer-payment-of-invoice"),
      import("@/lib/xero-inbound/retire-unlisted-credit-note-allocations"),
    ]);
  // Read before the lock; the decision re-checks each under it.
  const decided = allocation ? [...(await bankTransferPaymentIdsOfInvoices(allocation.invoiceIds))] : [];
  const paymentIds = [...new Set([...(adoption ? [adoption.paymentId] : []), ...decided.map(([, paymentId]) => paymentId)])].sort();
  const floorAlerts: Awaited<ReturnType<typeof decideBankTransferRefundedTotal>>[] = [];
  const result = await db.$transaction(async (tx) => {
    floorAlerts.length = 0;
    for (const paymentId of paymentIds) await lockPaymentForRefundedTotal(tx, paymentId);
    const completed = await complete(tx);
    if (linksRecorded()) {
      for (const [invoiceId, paymentId] of decided) {
        floorAlerts.push(await decideBankTransferRefundedTotal(tx, { id: paymentId, invoiceId, creditNoteId: allocation?.creditNoteId ?? null }, true));
      }
    }
    return completed;
  }, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS);
  // After the commit, outside any transaction; a failed send never fails the completion that committed.
  await sendFloorAlerts(floorAlerts.filter((alert) => alert !== null)).catch((err: unknown) => {
    logger.error({ err, paymentIds }, "Failed to send the bank-transfer floor alert after a credit note allocation completed (#5289)");
  });
  return result;
}
