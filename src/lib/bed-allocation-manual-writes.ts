/**
 * The board's manual allocation writers (#2688).
 *
 * Place a guest on a bed for one night, for a set of nights, drag existing rows
 * to another bed on their own dates, and remove one row. Each public wrapper
 * takes global `lock(1)` and then the destination bed's immutable lodge
 * capacity key before delegating to a narrow lock-held implementation; the
 * placement itself is `bed-allocation-placement.ts`. Distinct from
 * `bed-allocation-move.ts` / `bed-allocation-removal.ts`, which are the
 * reviewed, digest-guarded bulk operations.
 */
import { Prisma, type BedAllocation } from "@prisma/client";
import {
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { promoteOrphanedSecondOccupants } from "@/lib/bed-allocation-lifecycle";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { CustodianHoldConflictError } from "@/lib/custodian-occupancy";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  BedAllocationAdminError,
  type BedAllocationDb,
} from "@/lib/bed-allocation-admin-contract";
import { MAX_BED_ALLOCATION_RANGE_NIGHTS } from "@/lib/bed-allocation-date-range";
import {
  allocateBedNightWithLocksHeld,
  assertGuestAndBedForAllocation,
  assertManualAllocationInput,
  guestIsStayingOn,
  resolveBedLodgeIdForLock,
} from "@/lib/bed-allocation-placement";

interface ManualAllocationInput {
  bookingGuestId: string;
  bedId: string;
  stayDate: string;
}

export async function manuallyAllocateBedWithLocksHeld(
  input: ManualAllocationInput & { db: BedAllocationDb },
): Promise<{ allocation: BedAllocation; promotedPartner: BedAllocation | null }> {
  if (!isDateOnlyString(input.stayDate)) {
    throw new BedAllocationAdminError("Invalid stay date", 400);
  }
  const db = input.db;

  const stayDate = parseDateOnly(input.stayDate);
  const { guest, bed } = await assertManualAllocationInput({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    stayDate,
    db,
  });

  try {
    return await allocateBedNightWithLocksHeld({ guest, bed, stayDate, db });
  } catch (error) {
    // #2286: the custodian guard's own error carries the held nights; the
    // single-night path answers it as a plain 409 like any other bed clash.
    if (error instanceof CustodianHoldConflictError) {
      throw new BedAllocationAdminError(error.message, 409);
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new BedAllocationAdminError(
        "That bed is already allocated for the selected date.",
        409,
      );
    }
    throw error;
  }
}

export async function manuallyAllocateBed(
  input: ManualAllocationInput,
): Promise<{ allocation: BedAllocation; promotedPartner: BedAllocation | null }> {
  if (!isDateOnlyString(input.stayDate)) {
    throw new BedAllocationAdminError("Invalid stay date", 400);
  }
  const lockLodgeId = await resolveBedLodgeIdForLock(input.bedId, prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    if (lockLodgeId) await acquireLodgeCapacityLock(tx, lockLodgeId);
    return manuallyAllocateBedWithLocksHeld({ ...input, db: tx });
  });
}

export interface SameDateAllocationMoveResult {
  allocations: BedAllocation[];
  promotedPartners: BedAllocation[];
  noop: boolean;
}

/**
 * Move existing allocation rows to one destination bed without changing any
 * lodge night (#2366).
 *
 * The browser supplies allocation ids, never dates. We resolve the destination
 * lodge only far enough to derive the lock key, take the global booking lock
 * before that lodge's capacity lock, and then re-read every source row under
 * both locks. Each write is keyed to that row's persisted `stayDate`.
 *
 * The global lock is required even though the move does not change booking
 * status: cancellation prunes the booking's allocation rows while holding that
 * lock. Without the shared lock, a move can re-upsert a row after cancellation
 * deleted it and resurrect an allocation on a cancelled booking.
 *
 * A multi-night proxy move is all-or-nothing: one conflict rolls the whole
 * transaction back, including partner promotions and audit rows. This differs
 * deliberately from bucket-to-board bulk allocation, whose existing
 * place-what-you-can semantics remain unchanged.
 */
interface SameDateAllocationMoveInput {
  allocationIds: string[];
  bedId: string;
  actorMemberId: string;
}

export async function moveBedAllocationsSameDateWithLocksHeld(
  input: SameDateAllocationMoveInput & { db: BedAllocationDb },
): Promise<SameDateAllocationMoveResult> {
  const allocationIds = [...new Set(input.allocationIds)];
  if (allocationIds.length === 0) {
    throw new BedAllocationAdminError(
      "At least one allocation is required",
      400,
    );
  }
  if (allocationIds.length > MAX_BED_ALLOCATION_RANGE_NIGHTS) {
    throw new BedAllocationAdminError(
      `Cannot move more than ${MAX_BED_ALLOCATION_RANGE_NIGHTS} allocations at once`,
      400,
    );
  }

  const moveUnderLock = async (
    db: BedAllocationDb,
  ): Promise<SameDateAllocationMoveResult> => {
    const sourceRows = await db.bedAllocation.findMany({
      where: { id: { in: allocationIds } },
      select: {
        id: true,
        bookingId: true,
        bookingGuestId: true,
        bedId: true,
        stayDate: true,
      },
    });
    if (sourceRows.length !== allocationIds.length) {
      throw new BedAllocationAdminError("Allocation not found", 404);
    }

    const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
    const orderedRows = allocationIds.map((id) => sourceById.get(id)!);
    const bookingGuestIds = new Set(
      orderedRows.map((row) => row.bookingGuestId),
    );
    if (bookingGuestIds.size !== 1) {
      throw new BedAllocationAdminError(
        "Allocations must belong to one guest",
        400,
      );
    }

    // A horizontally different cell on the same bed still normalises to the
    // row's original date. Treat that as a no-op at the service boundary too:
    // a stale or hand-written client must not create a no-change audit entry.
    const rowsToMove = orderedRows.filter((row) => row.bedId !== input.bedId);
    if (rowsToMove.length === 0) {
      return { allocations: [], promotedPartners: [], noop: true };
    }

    const allocations: BedAllocation[] = [];
    const promotedPartners: BedAllocation[] = [];
    const promotionCauses: Array<{
      promotedPartner: BedAllocation;
      movedAllocationId: string;
      movedBookingId: string;
      movedBookingGuestId: string;
    }> = [];
    for (const source of rowsToMove) {
      const result = await manuallyAllocateBedWithLocksHeld({
        bookingGuestId: source.bookingGuestId,
        bedId: input.bedId,
        stayDate: formatDateOnly(source.stayDate),
        db,
      });
      allocations.push(result.allocation);
      if (result.promotedPartner) {
        promotedPartners.push(result.promotedPartner);
        promotionCauses.push({
          promotedPartner: result.promotedPartner,
          movedAllocationId: source.id,
          movedBookingId: source.bookingId,
          movedBookingGuestId: source.bookingGuestId,
        });
      }
    }

    const isBulk = rowsToMove.length > 1;
    // One allocation is written per row to move, and the no-op return above
    // means there is at least one. An audit entry naming no allocation would be
    // a record of a write that did not happen, which is the opposite of what
    // INV-CAP-029 asks of this path (#2800).
    const firstAllocation = allocations[0];
    if (firstAllocation === undefined) {
      throw new Error(
        `Bed allocation moved ${rowsToMove.length} row(s) but recorded none to audit.`,
      );
    }
    await createAuditLog(
      {
        action: isBulk
          ? "BED_ALLOCATION_BULK_SET"
          : "BED_ALLOCATION_MANUAL_SET",
        memberId: input.actorMemberId,
        targetId: firstAllocation.bookingId,
        entityType: "BedAllocation",
        entityId: isBulk ? undefined : firstAllocation.id,
        category: "lodge",
        outcome: "success",
        summary: isBulk
          ? "Bed allocation set across multiple nights"
          : "Manual bed allocation set",
        metadata: isBulk
          ? {
              bookingGuestId: firstAllocation.bookingGuestId,
              bedId: input.bedId,
              allocationIds: allocations.map((allocation) => allocation.id),
              allocatedStayDates: allocations.map((allocation) =>
                formatDateOnly(allocation.stayDate),
              ),
            }
          : {
              allocationId: firstAllocation.id,
              bookingGuestId: firstAllocation.bookingGuestId,
              bedId: firstAllocation.bedId,
              stayDate: formatDateOnly(firstAllocation.stayDate),
            },
      },
      db,
    );

    for (const {
      promotedPartner,
      movedAllocationId,
      movedBookingId,
      movedBookingGuestId,
    } of promotionCauses) {
      await createAuditLog(
        {
          action: "BED_ALLOCATION_PARTNER_PROMOTED",
          memberId: input.actorMemberId,
          targetId: promotedPartner.bookingId,
          entityType: "BedAllocation",
          entityId: promotedPartner.id,
          category: "lodge",
          outcome: "success",
          summary:
            "Second occupant auto-promoted to primary after the shared double's primary was moved to another bed",
          metadata: {
            allocationId: promotedPartner.id,
            bedId: promotedPartner.bedId,
            bookingGuestId: promotedPartner.bookingGuestId,
            stayDate: formatDateOnly(promotedPartner.stayDate),
            movedAllocationId,
            movedBookingId,
            movedBookingGuestId,
          },
        },
        db,
      );
    }

    return { allocations, promotedPartners, noop: false };
  };

  return moveUnderLock(input.db);
}

export async function moveBedAllocationsSameDate(
  input: SameDateAllocationMoveInput,
): Promise<SameDateAllocationMoveResult> {
  const allocationIds = [...new Set(input.allocationIds)];
  // Only the destination bed is read before the transaction, and only for its
  // immutable lodge key. Source rows, dates, guest state and bed state are all
  // re-read after BOTH locks are held. Global must precede lodge everywhere:
  // cancellation owns the global key and prunes allocations, while custodian
  // holds and other capacity writers own the lodge key.
  const lockLodgeId = await resolveBedLodgeIdForLock(input.bedId, prisma);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      if (lockLodgeId) await acquireLodgeCapacityLock(tx, lockLodgeId);
      return moveBedAllocationsSameDateWithLocksHeld({ ...input, db: tx });
    });
  } catch (error) {
    if (
      error instanceof BedAllocationAdminError &&
      error.status === 409 &&
      allocationIds.length > 1
    ) {
      throw new BedAllocationAdminError(
        `No allocations were moved. ${error.message}`,
        409,
      );
    }
    throw error;
  }
}

interface BulkAllocationConflict {
  stayDate: string;
  // CUSTODIAN_HOLD (#2286): the bed is held for a season by a custodian on that
  // night. Reported per night in the same shape as BED_TAKEN — a bulk drop
  // across a custodian's range must place the nights it can and name the ones
  // it cannot, not fail wholesale.
  reason: "BED_TAKEN" | "CUSTODIAN_HOLD";
}

export interface BulkAllocationResult {
  allocations: BedAllocation[];
  conflicts: BulkAllocationConflict[];
  skipped: string[];
  // Partners promoted to primary because a moved night vacated a shared double's
  // primary on its old bed (#1750); the route audits each one.
  promotedPartners: BedAllocation[];
}

/**
 * Allocates a guest to the same bed across several nights in one pass, used
 * for "drop a guest's full stay onto a bed" board interactions. Each night is
 * upserted independently so a bed already taken by another guest on one
 * night (a 409 in the single-night endpoint) is reported as a conflict
 * instead of aborting the nights that succeeded.
 */
interface BulkAllocationInput {
  bookingGuestId: string;
  bedId: string;
  stayDates: string[];
}

export async function manuallyAllocateBedForNightsWithLocksHeld(
  input: BulkAllocationInput & { db: BedAllocationDb },
): Promise<BulkAllocationResult> {
  if (input.stayDates.length === 0) {
    throw new BedAllocationAdminError(
      "At least one stay date is required",
      400,
    );
  }
  if (input.stayDates.length > MAX_BED_ALLOCATION_RANGE_NIGHTS) {
    throw new BedAllocationAdminError(
      `Cannot allocate more than ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights at once`,
      400,
    );
  }
  for (const stayDate of input.stayDates) {
    if (!isDateOnlyString(stayDate)) {
      throw new BedAllocationAdminError("Invalid stay date", 400);
    }
  }

  const db = input.db;
  const { guest, bed } = await assertGuestAndBedForAllocation({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    db,
  });

  const allocations: BedAllocation[] = [];
  const conflicts: BulkAllocationConflict[] = [];
  const skipped: string[] = [];
  const promotedPartners: BedAllocation[] = [];

  // #2286: each night's self-wrapped transaction takes the per-lodge advisory
  // lock first, exactly as the single-night path does. Resolved once outside
  // the loop — the bed does not change between nights.
  for (const stayDateStr of [...new Set(input.stayDates)].sort()) {
    const stayDate = parseDateOnly(stayDateStr);
    if (!guestIsStayingOn(guest, stayDate)) {
      skipped.push(stayDateStr);
      continue;
    }

    try {
      // Each night's read + upsert + orphan promotion is atomic and independent:
      // wrap it in its own transaction when no client is injected (so one night's
      // rollback never undoes an already-committed night), or run inline on an
      // injected transactional client. Mirrors the single-night self-wrap (#1750).
      const { allocation, promotedPartner } = await allocateBedNightWithLocksHeld({
        guest,
        bed,
        stayDate,
        db,
      });
      allocations.push(allocation);
      if (promotedPartner) {
        promotedPartners.push(promotedPartner);
      }
    } catch (error) {
      // #2286: a custodian-held night is its OWN per-night conflict category —
      // never folded into BED_TAKEN, because the fix is different (edit the
      // custodian's assignment, not another booking's allocation).
      if (error instanceof CustodianHoldConflictError) {
        conflicts.push({ stayDate: stayDateStr, reason: "CUSTODIAN_HOLD" });
        continue;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        conflicts.push({ stayDate: stayDateStr, reason: "BED_TAKEN" });
        continue;
      }
      // A bed-night the guest cannot take as a second occupant (bed full, not a
      // double, not an eligible partner) is a per-night conflict in a bulk drop,
      // not a hard failure — mirrors the P2002 bed-taken path above.
      if (
        error instanceof BedAllocationAdminError &&
        error.status === 409
      ) {
        conflicts.push({ stayDate: stayDateStr, reason: "BED_TAKEN" });
        continue;
      }
      throw error;
    }
  }

  return { allocations, conflicts, skipped, promotedPartners };
}

export async function manuallyAllocateBedForNights(
  input: BulkAllocationInput,
): Promise<BulkAllocationResult> {
  if (input.stayDates.length === 0) {
    throw new BedAllocationAdminError("At least one stay date is required", 400);
  }
  if (input.stayDates.length > MAX_BED_ALLOCATION_RANGE_NIGHTS) {
    throw new BedAllocationAdminError(
      `Cannot allocate more than ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights at once`,
      400,
    );
  }
  for (const stayDate of input.stayDates) {
    if (!isDateOnlyString(stayDate)) {
      throw new BedAllocationAdminError("Invalid stay date", 400);
    }
  }
  const lockLodgeId = await resolveBedLodgeIdForLock(input.bedId, prisma);
  const combined: BulkAllocationResult = {
    allocations: [],
    conflicts: [],
    skipped: [],
    promotedPartners: [],
  };
  for (const stayDate of [...new Set(input.stayDates)].sort()) {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      if (lockLodgeId) await acquireLodgeCapacityLock(tx, lockLodgeId);
      return manuallyAllocateBedForNightsWithLocksHeld({
        ...input,
        stayDates: [stayDate],
        db: tx,
      });
    });
    combined.allocations.push(...result.allocations);
    combined.conflicts.push(...result.conflicts);
    combined.skipped.push(...result.skipped);
    combined.promotedPartners.push(...result.promotedPartners);
  }
  return combined;
}

interface DeleteBedAllocationInput {
  id: string;
}

export async function deleteBedAllocationWithLocksHeld(
  input: DeleteBedAllocationInput & { db: BedAllocationDb },
): Promise<{ deleted: BedAllocation; promotedPartner: BedAllocation | null }> {
  const deleted = await input.db.bedAllocation.delete({
    where: { id: input.id },
  });

  // Orphan auto-promote (#1743, owner-locked): removing the PRIMARY of a shared
  // DOUBLE flips the surviving partner row to primary on that bed-night, so the
  // bed-night is not left blocked behind the orphaned-second-occupant guard in
  // resolveSecondOccupant. The delete removed the bed-night's only
  // isSecondOccupant=false row, so the flip cannot collide with
  // @@unique([bedId, stayDate, isSecondOccupant]). Gated on isSecondOccupant
  // only (never the deleted row's stale bedType — see the helper), and the
  // promoted row is returned so the DELETE route can audit the (possibly
  // cross-booking) state change. The shared helper is the same promotion applied
  // to the board-move and lifecycle-prune paths (#1750).
  let promotedPartner: BedAllocation | null = null;
  if (!deleted.isSecondOccupant) {
    const [promoted] = await promoteOrphanedSecondOccupants(input.db, [
      { bedId: deleted.bedId, stayDate: deleted.stayDate },
    ]);
    promotedPartner = promoted ?? null;
  }

  return { deleted, promotedPartner };
}

export async function deleteBedAllocation(
  input: DeleteBedAllocationInput,
): Promise<{ deleted: BedAllocation; promotedPartner: BedAllocation | null }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const allocationKey = await tx.bedAllocation.findUnique({
      where: { id: input.id },
      select: { room: { select: { lodgeId: true } } },
    });
    if (allocationKey?.room.lodgeId) {
      await acquireLodgeCapacityLock(tx, allocationKey.room.lodgeId);
    }
    return deleteBedAllocationWithLocksHeld({ ...input, db: tx });
  });
}
