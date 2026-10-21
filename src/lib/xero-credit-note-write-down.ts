/**
 * #4219 — the ledger record that a credit note was spent in Xero outside the app.
 *
 * A written-down lot must not look free again, and the row that releases a
 * booking's applied credit must not look like a lot. A lot's remaining balance is
 * its amount less the slices drawn from it (`MemberCreditNoteAllocation`); an
 * outside spend draws no slice for any booking, so it is recorded as a negative
 * `ADMIN_ADJUSTMENT` row for the member, stamped with the note's id. Both rows the
 * convergence writes carry `MemberCredit.outsideSpendConvergedAt`. This module is
 * the one definition of such a row for the readers: `gatherAppliedCreditLots`, the
 * funding-lot finder and the slice-fit check read through it (`INV-SSOT`). The
 * writer that creates the rows ships in a later release than these readers, so a
 * previous app version never meets a marked row it cannot read.
 */
import { CreditType, Prisma } from "@prisma/client";

/**
 * Rows the convergence writes carry `outsideSpendConvergedAt`: the booking's
 * release (a positive `BOOKING_APPLIED` row) and the lot's write-down. The marker
 * says "this row is not a spendable lot", because a positive row is otherwise the
 * member's own money and the planner would mint a Xero note for it. Every reader
 * that finds lots excludes marked rows through this one predicate.
 */
export const NOT_A_CONVERGENCE_ROW = { outsideSpendConvergedAt: null } satisfies Prisma.MemberCreditWhereInput;

/** The member's write-down rows for these notes: marked, negative, stamped with a note id. */
function creditNoteWriteDownWhere(memberId: string, creditNoteIds: string[]): Prisma.MemberCreditWhereInput {
  return {
    memberId,
    type: CreditType.ADMIN_ADJUSTMENT,
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
