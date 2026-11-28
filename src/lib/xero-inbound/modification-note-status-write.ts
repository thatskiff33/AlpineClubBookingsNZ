/**
 * #5251 (owner decision 28 Nov 2026, `INV-PAY-126`): A MODIFICATION NOTE'S OWN
 * STATUS IS WRITTEN UNDER THE PAYMENT ROWS IT IS COUNTED ON.
 *
 * A bank-transfer payment's refunded total counts a modification note only
 * while the note's `MODIFICATION_CREDIT_NOTE` link says it is live
 * (`decideLinkedRefundedTotalCents`). The inbound sync used to write that link
 * through the funnel with its link row only, so a kept settle holding the
 * Payment row could count a note voided while it ran, and the cancel queued
 * behind it read a net too low by that note.
 *
 * Now the sync takes, before the status write, the Payment row of every
 * bank-transfer payment the note's active allocations name
 * (`bankTransferPaymentsOfNoteAllocations`, the removal's own read), ids
 * sorted (`INV-LOCK-002`: Payment rows, then link rows), writes the links, and
 * decides each of those totals again under the rows
 * (`decideBankTransferRefundedTotal`, as an allocation write does). A settle
 * holding a row has either committed before the status changes, and its total
 * is decided again here, or waits and reads the status this write left.
 *
 * The payments are read before the lock and again under it, after the write:
 * an allocation committed in between that names a payment not held rolls the
 * write back and it runs again with that row too. An allocation whose own
 * write is still open then is decided by this sync's removal pass (#5289 A),
 * under its Payment row, once it commits.
 *
 * Only a write that changes whether the note counts takes the rows: a
 * cancelled reading, or a live one over a link that is missing, off or
 * cancelled (`changesWhetherNoteCounts`). A live reading over a live link
 * changes nothing the total reads, and keeps the funnel's own write: the
 * sync's first wait on the Payment row is then its allocation write or
 * removal, so a newer reading that removes an allocation still decides
 * straight after the settle it queued behind, before a cancel queued on
 * `lock(1)` reads the row.
 *
 * Every other link of the note keeps the funnel's own transaction: a refund
 * note's void takes its Payment row there (#4200). No new advisory key and no
 * new row-lock statement: `lockPaymentForRefundedTotal` is the one site.
 */
import { prisma } from "@/lib/prisma";
import { lockPaymentForRefundedTotal, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } from "@/lib/payment-transactions";
import { MODIFICATION_CREDIT_NOTE_ROLE } from "@/lib/xero-booking-credit-note-link-roles";
import { asRecord } from "@/lib/xero-json";
import { isIncludedRefundCreditNoteStatus } from "@/lib/xero-refund-note-status";
import { type XeroObjectLinkInput, upsertXeroObjectLink } from "@/lib/xero-sync";
import { bankTransferPaymentsOfNoteAllocations } from "./bank-transfer-payment-of-invoice";
import type { BankTransferFloorAlert } from "./credit-note-bank-transfer-floor";
import { type DecidedPayment, decideBankTransferRefundedTotal } from "./retire-unlisted-credit-note-allocations";

/** How often the write runs again when a newly committed allocation names a payment it did not hold. */
const STATUS_WRITE_ATTEMPTS = 3;

/** Thrown inside the transaction so the status write rolls back; never leaves this module. */
class PaymentNotHeldError extends Error {}

/** The bank-transfer payments a note's active allocations name, each with the invoice that names it. */
async function paymentsCountingNote(creditNoteId: string, db?: Parameters<typeof bankTransferPaymentsOfNoteAllocations>[1]): Promise<DecidedPayment[]> {
  const allocations = await bankTransferPaymentsOfNoteAllocations(creditNoteId, db);
  const seen = new Set<string>();
  return allocations.flatMap(({ invoiceId, paymentId }) => {
    const key = `${paymentId}|${invoiceId}`;
    if (!paymentId || seen.has(key)) return [];
    seen.add(key);
    return [{ id: paymentId, invoiceId, creditNoteId }];
  });
}

/**
 * Whether writing these links changes what the refunded total reads of the
 * note (`decideLinkedRefundedTotalCents`: an active link with a status that is
 * not cancelled): any link stored as counting and written as not, or the
 * other way, a missing row included. A write that names no status keeps the
 * stored one (the funnel merges metadata).
 */
async function changesWhetherNoteCounts(creditNoteId: string, noteLinks: readonly XeroObjectLinkInput[]): Promise<boolean> {
  const stored = await prisma.xeroObjectLink.findMany({
    where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: creditNoteId, role: MODIFICATION_CREDIT_NOTE_ROLE },
    select: { localModel: true, localId: true, active: true, metadata: true },
  });
  return noteLinks.some((link) => {
    const row = stored.find((candidate) => candidate.localModel === link.localModel && candidate.localId === link.localId);
    if (!row) return true;
    const storedStatus = asRecord(row.metadata)?.status;
    const writtenStatus = asRecord(link.metadata)?.status;
    const counted = row.active && isIncludedRefundCreditNoteStatus(storedStatus);
    const willCount = (link.active ?? true) && isIncludedRefundCreditNoteStatus(typeof writtenStatus === "string" ? writtenStatus : storedStatus);
    return counted !== willCount;
  });
}

const linkOrder = (a: XeroObjectLinkInput, b: XeroObjectLinkInput) =>
  a.localModel.localeCompare(b.localModel) || a.localId.localeCompare(b.localId);

/**
 * Write a credit note's links as the inbound sync read them. A modification
 * note's own links go in one transaction under the Payment rows above, in one
 * fixed order; the floor alerts its decisions return are pushed into
 * `heldFloorAlerts` after the commit, for the sync to send
 * (`withHeldFloorAlerts`). A sync that fails before then decides, and is
 * alerted, again on its retry.
 */
export async function writeCreditNoteLinks(
  creditNoteId: string,
  links: readonly XeroObjectLinkInput[],
  heldFloorAlerts: BankTransferFloorAlert[],
): Promise<void> {
  const noteLinks = links.filter((link) => link.role === MODIFICATION_CREDIT_NOTE_ROLE).sort(linkOrder);
  for (const link of links) {
    if (link.role !== MODIFICATION_CREDIT_NOTE_ROLE) await upsertXeroObjectLink(link);
  }
  if (noteLinks.length === 0) return;
  if (!(await changesWhetherNoteCounts(creditNoteId, noteLinks))) {
    for (const link of noteLinks) await upsertXeroObjectLink(link);
    return;
  }

  for (let attempt = 1; ; attempt += 1) {
    // Read before the lock; checked again under it, and each decision re-checks its own payment.
    const payments = await paymentsCountingNote(creditNoteId);
    const paymentIds = [...new Set(payments.map((payment) => payment.id))].sort();
    try {
      const floorAlerts = await prisma.$transaction(async (tx) => {
        for (const paymentId of paymentIds) await lockPaymentForRefundedTotal(tx, paymentId);
        for (const link of noteLinks) await upsertXeroObjectLink(link, { store: tx });
        const namedNow = await paymentsCountingNote(creditNoteId, tx);
        if (namedNow.some((payment) => !paymentIds.includes(payment.id))) throw new PaymentNotHeldError();
        const alerts: BankTransferFloorAlert[] = [];
        for (const payment of payments) {
          const alert = await decideBankTransferRefundedTotal(tx, payment, true);
          if (alert) alerts.push(alert);
        }
        return alerts;
      }, paymentIds.length > 0 ? PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS : undefined);
      heldFloorAlerts.push(...floorAlerts);
      return;
    } catch (err) {
      if (!(err instanceof PaymentNotHeldError)) throw err;
      if (attempt >= STATUS_WRITE_ATTEMPTS) {
        throw new Error(`Credit note ${creditNoteId}'s allocations kept changing while its status was written (#5251); the event is retried.`, { cause: err });
      }
    }
  }
}
