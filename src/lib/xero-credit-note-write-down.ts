/**
 * #4219 — the ledger record that a credit note was spent in Xero outside the app.
 *
 * A written-down lot must not look free again. A lot's remaining balance is its
 * amount less the slices drawn from it (`MemberCreditNoteAllocation`); an outside
 * spend draws no slice for any booking, so it is recorded as a negative
 * `ADMIN_ADJUSTMENT` row for the member, stamped with the note's id. When Xero
 * later shows the spend undone (#4270), a positive row of the same kind, with the
 * same marker and stamp, gives back the lot and never more than was written down.
 * The note's write-down is the SIGNED NET of those rows. This module is the one
 * definition of them: the converge routine and the inbound mirror write them and
 * `gatherAppliedCreditLots` and the repair subtract the net (`INV-SSOT`).
 */
import { CreditType, Prisma } from "@prisma/client";

export const CREDIT_NOTE_WRITE_DOWN_TYPE = CreditType.ADMIN_ADJUSTMENT;

/**
 * `XeroObjectLink.localModel` values of the invoices the app raises for bookings
 * (a booking's own, a modification's supplementary invoice, a group settlement's).
 * Credit allocated to one of them is the app's own, mirrored by the inbound sync. An
 * invoice linked to anything else (a subscription, an entrance fee, a member) is
 * not a booking's: credit offset against it is gone and nothing else records it.
 */
export const BOOKING_INVOICE_LINK_MODELS = ["Payment", "Booking", "BookingModification", "GroupBookingSettlement"] as const;

/**
 * Rows the convergence writes carry `outsideSpendConvergedAt`: the booking's
 * release (a positive `BOOKING_APPLIED` row) and the lot's write-down. The marker
 * says "this row is not a spendable lot", because a positive row is otherwise the
 * member's own money and the planner would mint a Xero note for it. Every reader
 * that finds lots excludes marked rows through this one predicate.
 */
export const NOT_A_CONVERGENCE_ROW = { outsideSpendConvergedAt: null } satisfies Prisma.MemberCreditWhereInput;

/**
 * The member's write-down and restore rows for these notes: marked, stamped with a
 * note id, either sign. A restore (#4270) is a positive row, so a reader that took
 * only the negative rows would keep a restored lot written down.
 */
export function creditNoteWriteDownWhere(
  memberId: string | { in: string[] },
  creditNoteIds: string[],
): Prisma.MemberCreditWhereInput {
  return {
    memberId,
    type: CREDIT_NOTE_WRITE_DOWN_TYPE,
    outsideSpendConvergedAt: { not: null },
    xeroCreditNoteId: { in: creditNoteIds },
  };
}

/**
 * Net written down per credit note, in positive cents: the write-downs less the
 * restores. Never below zero: a net that went negative would read as more free
 * than the lot holds, and a reader must fail toward less credit, not more.
 */
export async function writtenDownCentsByCreditNote(
  db: Pick<Prisma.TransactionClient, "memberCredit">,
  memberId: string,
  creditNoteIds: string[],
): Promise<Map<string, number>> {
  if (creditNoteIds.length === 0) return new Map();
  const rows = await db.memberCredit.groupBy({
    by: ["xeroCreditNoteId"],
    where: creditNoteWriteDownWhere(memberId, creditNoteIds),
    _sum: { amountCents: true },
  });
  return new Map(
    rows.flatMap((row) =>
      row.xeroCreditNoteId ? [[row.xeroCreditNoteId, netWrittenDownCents(row._sum.amountCents)] as const] : [],
    ),
  );
}

/** The net written down from the signed sum of a note's rows: positive cents, never below zero. */
function netWrittenDownCents(signedSumCents: number | null): number {
  return Math.max(0, -(signedSumCents ?? 0));
}

/**
 * {@link writtenDownCentsByCreditNote} for many members in one read (the same rows
 * and the same net): per member, per note. `creditNoteIds` may name notes of any of
 * the members; a member's map holds only its own notes' rows.
 */
export async function writtenDownCentsByMemberAndNote(
  db: Pick<Prisma.TransactionClient, "memberCredit">,
  memberIds: string[],
  creditNoteIds: string[],
): Promise<Map<string, Map<string, number>>> {
  const byMember = new Map<string, Map<string, number>>();
  if (memberIds.length === 0 || creditNoteIds.length === 0) return byMember;
  const rows = await db.memberCredit.groupBy({
    by: ["memberId", "xeroCreditNoteId"],
    where: creditNoteWriteDownWhere({ in: memberIds }, creditNoteIds),
    _sum: { amountCents: true },
  });
  for (const row of rows) {
    if (!row.xeroCreditNoteId) continue;
    const notes = byMember.get(row.memberId) ?? new Map<string, number>();
    byMember.set(row.memberId, notes.set(row.xeroCreditNoteId, netWrittenDownCents(row._sum.amountCents)));
  }
  return byMember;
}

export function creditNoteWriteDownDescription(bookingId: string): string {
  return `Automatic adjustment: credit used in Xero outside the app, removed (booking ${bookingId.slice(0, 8)})`;
}

export function creditNoteReleaseDescription(bookingId: string): string {
  return `Automatic adjustment: credit no longer applied to booking ${bookingId.slice(0, 8)} because it was used in Xero outside the app`;
}

/** The write-down the inbound mirror makes when it finds the note spent in Xero (#4270); no booking is involved. */
export const CREDIT_NOTE_MIRROR_WRITE_DOWN_DESCRIPTION =
  "Automatic adjustment: credit used in Xero outside the app, removed";

/** The restore the inbound mirror makes when Xero shows that spend undone (#4270). */
export const CREDIT_NOTE_MIRROR_RESTORE_DESCRIPTION =
  "Automatic adjustment: credit restored because it is no longer used in Xero outside the app";
