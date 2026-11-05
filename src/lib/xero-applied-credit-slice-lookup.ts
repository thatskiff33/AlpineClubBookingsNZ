/**
 * Two lookups every applied-credit reader asks of one allocation slice or one
 * credit note, said once (`INV-SSOT`): whether Xero holds the slice, and which
 * positive funding lots a note has. The allocation engine, the legacy repair, the
 * credit-note convergence and the early warning (#4220) all use them.
 */
import type { Prisma } from "@prisma/client";
import { APPLIED_CREDIT_ALLOCATION_ROLE } from "./xero-applied-credit-link-roles";
import { NOT_A_CONVERGENCE_ROW } from "./xero-credit-note-write-down";

/** The active completion link that says Xero holds a slice. */
const HELD_SLICE_LINK = {
  localModel: "MemberCreditNoteAllocation",
  xeroObjectType: "ALLOCATION",
  role: APPLIED_CREDIT_ALLOCATION_ROLE,
  active: true,
} as const;

/** Whether an active completion link says Xero holds this slice. */
export async function sliceHeldInXero(
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
  sliceId: string,
): Promise<boolean> {
  const link = await db.xeroObjectLink.findFirst({
    where: { ...HELD_SLICE_LINK, localId: sliceId },
    select: { id: true },
  });
  return link !== null;
}

/** The same question for many slices at once: the ids of those Xero holds. */
export async function slicesHeldInXero(
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
  sliceIds: readonly string[],
): Promise<Set<string>> {
  if (sliceIds.length === 0) return new Set();
  const links = await db.xeroObjectLink.findMany({
    where: { ...HELD_SLICE_LINK, localId: { in: [...sliceIds] } },
    select: { localId: true },
  });
  return new Set(links.map((link) => link.localId));
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
