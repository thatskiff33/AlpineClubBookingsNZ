import { assertGlobalLockHeld } from "@/lib/global-lock-held";
import { assertLodgeCapacityLockHeld } from "@/lib/lodge-capacity-lock";
/**
 * Approving bed allocations, and the booking lock that follows from it
 * (#2688).
 *
 * Approval stamps `approvedAt`/`approvedByMemberId` on the selected draft rows
 * under global -> sorted immutable lodge -> sorted allocation-row locks, and
 * the presence of one approved row is what locks a member out of editing their
 * requested room (#776).
 */
import { Prisma } from "@prisma/client";
import { formatDateOnly } from "@/lib/date-only";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  BedAllocationAdminError,
  type BedAllocationDb,
} from "@/lib/bed-allocation-admin-contract";
import type { BedAllocationDateRange } from "@/lib/bed-allocation-date-range";

/**
 * Whether an admin has confirmed (locked) the bed allocation for a booking.
 *
 * Issue #776: members may set/clear their requested room until the lodge
 * confirms beds. The lock signal is the presence of at least one approved
 * BedAllocation row for the booking — `approveBedAllocations` stamps
 * `approvedAt`/`approvedByMemberId` when an admin explicitly confirms beds.
 * Unapproved (auto-suggested or pending manual) allocations do not lock it.
 *
 * The lock is NOT one-way (#2252). Two existing paths can take the booking's
 * last approved row away again and re-open the member's editor:
 *   - a board move re-drafts the row it updates (the upsert update branch
 *     clears `approvedAt`/`approvedByMemberId`);
 *   - `deleteBedAllocation` removes it outright.
 * Neither is a dedicated "un-approve" action — they are documented side
 * effects — but the in-booking panel warns before removing the last approved
 * row, because the member silently regaining the editor is a real consequence.
 */
export async function isBookingBedAllocationLocked(input: {
  bookingId: string;
  db?: BedAllocationDb;
}): Promise<boolean> {
  const db = input.db ?? prisma;
  const approved = await db.bedAllocation.findFirst({
    where: {
      bookingId: input.bookingId,
      approvedAt: { not: null },
    },
    select: { id: true },
  });
  return approved !== null;
}

interface ApproveBedAllocationsInput {
  approvedByMemberId: string;
  allocationIds?: string[];
  range?: BedAllocationDateRange;
  /*
   * One booking's draft rows (#2252) — a FIRST-CLASS third selector, sufficient
   * on its own. The in-booking panel's Confirm has neither of the other two
   * available to it safely: `allocationIds` caps at 250 and a long stay can
   * exceed that, and the `from`/`to` form approves EVERY pending allocation of
   * EVERY booking in the window, so confirming one booking from its own page
   * would silently confirm other people's drafts. When combined with either of
   * the others it only ever NARROWS the set.
   */
  bookingId?: string;
  // Range approval follows the board's lodge scope so approving one lodge's
  // board never approves another lodge's pending allocations.
  lodgeId?: string;
}

function buildApproveBedAllocationsWhere(
  input: ApproveBedAllocationsInput,
): Prisma.BedAllocationWhereInput {
  const where: Prisma.BedAllocationWhereInput = { approvedAt: null };
  if (input.bookingId) {
    where.bookingId = input.bookingId;
    if (input.lodgeId) where.room = lodgeNullTolerantScope(input.lodgeId);
  }
  if (input.allocationIds?.length) {
    where.id = { in: input.allocationIds };
  } else if (input.range) {
    where.stayDate = { gte: input.range.from, lt: input.range.to };
    if (input.lodgeId) where.room = lodgeNullTolerantScope(input.lodgeId);
  } else if (!input.bookingId) {
    throw new BedAllocationAdminError(
      "Select allocations, a booking, or a date range to approve.",
      400,
    );
  }
  // A supplied lodge scope narrows EVERY selector form, including explicit ids.
  // Otherwise `allocationIds + lodgeId` could lock only the supplied lodge while
  // row-locking and approving ids from another lodge.
  if (input.lodgeId) where.room = lodgeNullTolerantScope(input.lodgeId);
  return where;
}

export async function approveBedAllocationsWithLocksHeld(
  input: ApproveBedAllocationsInput & { db: BedAllocationDb },
) {
  await assertGlobalLockHeld(input.db, "approveBedAllocationsWithLocksHeld");
  const lockLodgeIds = input.lodgeId ? [input.lodgeId] : (await input.db.bedAllocation.findMany({
    where: buildApproveBedAllocationsWhere(input),
    select: { room: { select: { lodgeId: true } } },
  })).map((allocation) => allocation.room.lodgeId);
  for (const lodgeId of lockLodgeIds) {
    await assertLodgeCapacityLockHeld(input.db, lodgeId, "approveBedAllocationsWithLocksHeld");
  }

  const where = buildApproveBedAllocationsWhere(input);

  return input.db.bedAllocation.updateMany({
    where,
    data: {
      approvedAt: new Date(),
      approvedByMemberId: input.approvedByMemberId,
    },
  });
}

export async function approveBedAllocations(input: ApproveBedAllocationsInput) {
  const lockWhere = buildApproveBedAllocationsWhere(input);
  // Resolve only immutable lodge keys before opening the transaction. A
  // mutable allocation pre-read is not sufficient here: a writer already
  // holding global lock(1) could commit a newly matching row after that read,
  // and approval would then include its lodge without having taken that lodge's
  // capacity lock. Lodge-scoped callers stay narrow; the supported legacy
  // club-wide selector conservatively locks the immutable lodge-id superset.
  const lodgeIds = input.lodgeId
    ? [input.lodgeId]
    : (
        await prisma.lodge.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((lodge) => lodge.id);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    for (const lodgeId of lodgeIds) {
      await acquireLodgeCapacityLock(tx, lodgeId);
    }

    // Canonical row locks make approval serialize with reset/move on the exact
    // allocation identities. The update still re-applies its full selector and
    // `approvedAt: null` fence after these locks.
    const rowsToLock = await tx.bedAllocation.findMany({
      where: lockWhere,
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const rowIds = rowsToLock.map((row) => row.id);
    if (rowIds.length > 0) {
      await tx.$executeRaw`
        SELECT 1
        FROM "BedAllocation"
        WHERE "id" IN (${Prisma.join(rowIds)})
        ORDER BY "id"
        FOR UPDATE
      `;
    }

    const result = await approveBedAllocationsWithLocksHeld({ ...input, db: tx });
    await createAuditLog(
      {
        action: "BED_ALLOCATION_APPROVED",
        memberId: input.approvedByMemberId,
        entityType: "BedAllocation",
        category: "lodge",
        outcome: "success",
        summary: "Bed allocations approved",
        targetId: input.bookingId,
        metadata: {
          approvedCount: result.count,
          allocationIds: input.allocationIds?.slice(0, 250),
          bookingId: input.bookingId,
          range: input.range
            ? {
                from: formatDateOnly(input.range.from),
                to: formatDateOnly(input.range.to),
              }
            : undefined,
          lodgeId: input.lodgeId,
        },
      },
      tx,
    );
    return result;
  });
}
