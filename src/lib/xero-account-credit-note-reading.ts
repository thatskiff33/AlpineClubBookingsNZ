// #4347 (`INV-ADDPAY-041`): what acts on a Xero reading of a payment's
// account-credit note decides from the note's rows as stored NOW, never from the
// reading. A pure read helper beside `xero-refund-note-status.ts`, whose
// `judgeRefundNoteWrite` stays the one order of two readings.
import type { Prisma } from "@prisma/client";
import { ACCOUNT_CREDIT_NOTE_ROLE } from "@/lib/xero-booking-credit-note-link-roles";
import { isIncludedRefundCreditNoteStatus, judgeRefundNoteWrite, readRefundNoteRowsByPayment, REFUND_CREDIT_NOTE_LINK_WHERE } from "@/lib/xero-refund-note-status";
import { asRecord } from "@/lib/xero-json";

type LinkReader = Pick<Prisma.TransactionClient, "xeroObjectLink">;

/**
 * #4447, #4347: true when no stored snapshot refuses this reading -
 * `judgeRefundNoteWrite` answers "apply" against every one. A reading a newer
 * stored snapshot or a stored void beat is not current, and nothing that acts
 * on its figures (allocations, the member's credit) may act on it.
 */
export function readingIsCurrent(readingMetadata: unknown, storedSnapshots: readonly unknown[]): boolean {
  return storedSnapshots.every((metadata) => judgeRefundNoteWrite(readingMetadata, metadata) === "apply");
}

/**
 * `readingIsCurrent` against the note's account-credit rows as stored now, on
 * the caller's client. True for a note with no such row, so every other note
 * keeps its behaviour from before #4347.
 */
export async function accountCreditNoteReadingIsCurrent(creditNoteId: string, readingMetadata: unknown, db: LinkReader): Promise<boolean> {
  const rows = (await db.xeroObjectLink.findMany({
    where: { ...REFUND_CREDIT_NOTE_LINK_WHERE, role: ACCOUNT_CREDIT_NOTE_ROLE, xeroObjectId: creditNoteId },
    select: { metadata: true },
  })) ?? [];
  return readingIsCurrent(readingMetadata, rows.map((row) => row.metadata));
}

export type CountedNoteRow = { active: boolean; metadata: unknown };

/**
 * #4288, #4347: whether a payment's rows for the note still count it, or null
 * when it has none (the caller falls back to the reading). The first row - the
 * refund-note row when there is one - must be active, and no row may record
 * VOIDED/DELETED: an account-credit row beside a refund-note row vetoes only by
 * its status, since its `active` is kept as stored (#4347), not a void.
 */
export function countedNoteRowsCount(rows: readonly CountedNoteRow[] | undefined): boolean | null {
  const [first] = rows ?? [];
  if (!first) return null;
  return first.active && (rows ?? []).every((row) => isIncludedRefundCreditNoteStatus(asRecord(row.metadata)?.status));
}

/**
 * #4288, #4347: the rows through which each payment counts the note being
 * synced - its refund-note row, then its account-credit row - read now on the
 * caller's client, one statement at a time. A payment with neither has no
 * entry. Each read goes through `readRefundNoteRowsByPayment`'s export.
 */
export async function readCountedNoteRows(creditNoteId: string, paymentIds: readonly string[], db: LinkReader) {
  const byPayment = new Map<string, CountedNoteRow[]>();
  for (const role of [REFUND_CREDIT_NOTE_LINK_WHERE.role, ACCOUNT_CREDIT_NOTE_ROLE] as const) {
    for (const [paymentId, row] of await readRefundNoteRowsByPayment(creditNoteId, paymentIds, db, role)) byPayment.set(paymentId, [...(byPayment.get(paymentId) ?? []), row]);
  }
  return byPayment;
}
