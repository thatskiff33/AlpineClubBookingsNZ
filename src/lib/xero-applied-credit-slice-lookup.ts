/**
 * Two lookups every applied-credit reader asks of one allocation slice or one
 * credit note, said once (`INV-SSOT`): whether Xero holds the slice, and which
 * positive funding lots a note has. The allocation engine, the legacy repair and
 * the credit-note convergence all use them.
 */
import type { Prisma } from "@prisma/client";
import { APPLIED_CREDIT_ALLOCATION_ROLE } from "./xero-applied-credit-link-roles";
import { NOT_A_CONVERGENCE_ROW } from "./xero-credit-note-write-down";

/** Whether an active completion link says Xero holds this slice. */
export async function sliceHeldInXero(
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
  sliceId: string,
): Promise<boolean> {
  const link = await db.xeroObjectLink.findFirst({
    where: {
      localModel: "MemberCreditNoteAllocation",
      localId: sliceId,
      xeroObjectType: "ALLOCATION",
      role: APPLIED_CREDIT_ALLOCATION_ROLE,
      active: true,
    },
    select: { id: true },
  });
  return link !== null;
}

/**
 * The member's positive funding lots for a credit note, at most two (the callers
 * only need to know whether there is exactly one). A row the credit-note
 * convergence wrote is never a funding lot.
 */
export async function findFundingLotsForNote(
  db: Pick<Prisma.TransactionClient, "memberCredit">,
  memberId: string,
  xeroCreditNoteId: string,
): Promise<Array<{ id: string; amountCents: number }>> {
  return db.memberCredit.findMany({
    where: { memberId, xeroCreditNoteId, amountCents: { gt: 0 }, ...NOT_A_CONVERGENCE_ROW },
    select: { id: true, amountCents: true },
    take: 2,
  });
}
