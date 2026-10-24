/**
 * #4219 — the ledger record that a credit note was spent in Xero outside the app.
 *
 * A written-down lot must not look free again. A lot's remaining balance is its
 * amount less the slices drawn from it (`MemberCreditNoteAllocation`); an outside
 * spend draws no slice for any booking, so it is recorded as a negative
 * `ADMIN_ADJUSTMENT` row for the member, stamped with the note's id. This module
 * is the one definition of such a row: the converge routine writes it and
 * `gatherAppliedCreditLots` subtracts it (`INV-SSOT`).
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

/** The member's write-down rows for these notes: marked, negative, stamped with a note id. */
export function creditNoteWriteDownWhere(
  memberId: string,
  creditNoteIds: string[],
): Prisma.MemberCreditWhereInput {
  return {
    memberId,
    type: CREDIT_NOTE_WRITE_DOWN_TYPE,
    amountCents: { lt: 0 },
    outsideSpendConvergedAt: { not: null },
    xeroCreditNoteId: { in: creditNoteIds },
  };
}

/** Total written down per credit note, in positive cents. */
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
      row.xeroCreditNoteId ? [[row.xeroCreditNoteId, -(row._sum.amountCents ?? 0)] as const] : [],
    ),
  );
}

export function creditNoteWriteDownDescription(bookingId: string): string {
  return `Automatic adjustment: credit used in Xero outside the app, removed (booking ${bookingId.slice(0, 8)})`;
}

export function creditNoteReleaseDescription(bookingId: string): string {
  return `Automatic adjustment: credit no longer applied to booking ${bookingId.slice(0, 8)} because it was used in Xero outside the app`;
}
