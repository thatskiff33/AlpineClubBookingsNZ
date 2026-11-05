/**
 * THE ONE LOADER OF A MEMBER'S CREDIT LOTS AS THE ALLOCATION ENGINE USES THEM
 * (#1620, #4219, #4220; `INV-SSOT`, `INV-PAY-127`). The engine's
 * `gatherAppliedCreditLots` reads one member's lots here, and the early warning
 * (`xero-credit-note-spent-outside-flag.ts`) reads many members' at once to replay
 * the engine's draw. Both see the same rows, in the same order, with the same
 * slices and write-downs taken off (`freeCreditLots`).
 */
import type { Prisma } from "@prisma/client";
import { CREDIT_LOT_USE_ORDER, freeCreditLots, type AppliedCreditLot } from "./xero-applied-credit-plan";
import { creditLotWhere } from "./xero-applied-credit-slice-lookup";
import { writtenDownCentsByMemberAndNote } from "./xero-credit-note-write-down";

/** A member's lots, each with its free credit, and the member's net write-down per note. */
export interface MemberFreeCreditLots {
  lots: AppliedCreditLot[];
  writtenDownByNote: Map<string, number>;
}

/**
 * Per member: every positive lot that is not a convergence row, in
 * `CREDIT_LOT_USE_ORDER` (oldest first, ties by `id`), with its free credit - the
 * amount less the slices other bookings drew from it, less its note's net
 * write-down. `exceptBookingId` sets that booking's own slices aside: the engine's
 * retry re-plans the booking's whole applied amount, so counting its own committed
 * slices would read its lots as consumed (see `gatherAppliedCreditLots`). Three
 * reads, whatever the number of members. A member with no lot maps to empty lists.
 */
export async function loadFreeCreditLots(
  db: Prisma.TransactionClient,
  memberIds: readonly string[],
  options: { exceptBookingId?: string } = {},
): Promise<Map<string, MemberFreeCreditLots>> {
  const byMember = new Map<string, MemberFreeCreditLots>();
  if (memberIds.length === 0) return byMember;
  const positiveLots = await db.memberCredit.findMany({
    where: creditLotWhere({ in: [...memberIds] }),
    // `type` is read for the mint's account mapping (#2717) — see
    // `mintSliceMappingKey`. Blue/green runtime-prep: name only what is read.
    select: { id: true, memberId: true, amountCents: true, type: true, xeroCreditNoteId: true },
    orderBy: [...CREDIT_LOT_USE_ORDER],
  });

  const allocated = await db.memberCreditNoteAllocation.groupBy({
    by: ["memberCreditId"],
    where: {
      memberCreditId: { in: positiveLots.map((l) => l.id) },
      ...(options.exceptBookingId === undefined ? {} : { appliedToBookingId: { not: options.exceptBookingId } }),
    },
    _sum: { amountCents: true },
  });
  const allocatedById = new Map(allocated.map((a) => [a.memberCreditId, a._sum.amountCents ?? 0]));

  // #4219: credit written down because its note was used outside the app is gone.
  const writtenDown = await writtenDownCentsByMemberAndNote(
    db,
    [...memberIds],
    [...new Set(positiveLots.flatMap((l) => (l.xeroCreditNoteId ? [l.xeroCreditNoteId] : [])))],
  );
  for (const memberId of memberIds) {
    const writtenDownByNote = writtenDown.get(memberId) ?? new Map<string, number>();
    const own = positiveLots.filter((lot) => lot.memberId === memberId);
    byMember.set(memberId, { lots: freeCreditLots(own, allocatedById, writtenDownByNote), writtenDownByNote });
  }
  return byMember;
}
