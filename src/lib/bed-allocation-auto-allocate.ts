/**
 * The board's explicit "Run auto allocation" writer (#2688).
 *
 * The board GET is only a preview, so this rebuilds the authoritative plan
 * under global -> selected-lodge locks and writes only that. The plan itself is
 * the pure first-fit planner in `bed-allocation.ts`.
 */
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { dropAllocationRowsForUnallocatableBookings } from "@/lib/bed-allocation-lifecycle";
import logger from "@/lib/logger";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import {
  custodianHeldBedNightKeys,
  findCustodianBedHolds,
} from "@/lib/custodian-occupancy";
import {
  buildWholeLodgeHeldNightPredicate,
  findBlockingWholeLodgeHolds,
} from "@/lib/exclusive-hold-occupancy";
import { prisma } from "@/lib/prisma";
import {
  BedAllocationAdminError,
  type BedAllocationDb,
} from "@/lib/bed-allocation-admin-contract";
import type { BedAllocationDateRange } from "@/lib/bed-allocation-date-range";
import { getBedAllocationDashboard } from "@/lib/bed-allocation-board";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";

export async function runAutoBedAllocation(input: {
  range: BedAllocationDateRange;
  // Auto-allocation follows the board's lodge scope, so a suggestion can
  // never place a guest into another lodge's bed.
  lodgeId: string;
}) {
  /**
   * Build and write one authoritative plan under the mutation topology.
   *
   * The board GET is only a preview. Inventory, booking state, allocations,
   * custodian/whole-lodge holds and every hard planner predicate are mutable,
   * so a plan built from that response cannot be committed later. The action
   * acquires global -> selected lodge first, then rebuilds the complete scoped
   * dashboard through the transaction client and writes only that locked plan.
   * Inventory writers and allocation counterparts share these keys, preventing
   * a bed/room deactivate, retype, move, prune or approval from landing between
   * this authoritative read and `createMany`.
   */
  const writeUnderLocks = async (
    tx: BedAllocationDb,
  ): Promise<{ count: number }> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const lodgeId = input.lodgeId;
    await acquireLodgeCapacityLock(tx, lodgeId);
    if (!(await resolveOptionalActiveLodgeId(tx, lodgeId))) {
      throw new BedAllocationAdminError(
        "Lodge not found or not active",
        400,
      );
    }

    const dashboard = await getBedAllocationDashboard({
      range: input.range,
      lodgeId,
      db: tx,
    });
    if (!dashboard.settings.autoAllocationEnabled) {
      throw new BedAllocationAdminError(
        "Auto allocation is disabled; use manual allocation.",
        409,
      );
    }
    if (dashboard.suggestedAllocations.length === 0) return { count: 0 };

    const candidateRows = dashboard.suggestedAllocations.map((allocation) => ({
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      roomId: allocation.roomId,
      bedId: allocation.bedId,
      stayDate: parseDateOnly(allocation.stayDate),
      source: "AUTO" as const,
    }));

    // Immediate write-time defence in depth, shared with the lifecycle planner.
    // The authoritative plan above is already under global -> lodge, but keep
    // the narrow booking/hold checks adjacent to the write so an uncoordinated
    // legacy/direct-SQL mutation remains conservative rather than restorative.
    const { rows, droppedBookingIds } =
      await dropAllocationRowsForUnallocatableBookings(tx, candidateRows);

    if (droppedBookingIds.length > 0) {
      logger.info(
        { droppedBookingIds, lodgeId },
        "Run Auto Allocation write-time re-check dropped suggestions for bookings that became unallocatable (held/cancelled/deleted) after planning",
      );
    }
    if (rows.length === 0) {
      return { count: 0 };
    }

    // Custodian re-filter (#2286), defence in depth. Re-read the holds HERE,
    // under the same locked transaction, and drop any suggestion targeting one.
    const stayDates = rows.map((row) => row.stayDate);
    const from = stayDates.reduce((a, b) => (a < b ? a : b));
    const latest = stayDates.reduce((a, b) => (a > b ? a : b));
    const toExclusive = addDaysDateOnly(latest, 1);
    const heldKeys = custodianHeldBedNightKeys(
      await findCustodianBedHolds({
        lodgeId,
        from,
        toExclusive,
        db: tx,
      }),
      eachDateOnlyInRange(from, toExclusive),
    );
    const writableRows = rows.filter(
      (row) => !heldKeys.has(`${row.bedId}:${formatDateOnly(row.stayDate)}`),
    );
    if (writableRows.length < rows.length) {
      logger.info(
        {
          droppedCount: rows.length - writableRows.length,
          lodgeId,
        },
        "Run Auto Allocation dropped suggestions targeting custodian-held bed-nights",
      );
    }
    if (writableRows.length === 0) {
      return { count: 0 };
    }

    // Whole-lodge-hold re-filter (#2317), the exact mirror of the custodian one
    // above. The booking re-check cannot cover a hold set on somebody ELSE's
    // booking, so retain this final narrow guard even though the locked planner
    // has already consumed the same authoritative hold set.
    const isWholeLodgeHeld = buildWholeLodgeHeldNightPredicate(
      await findBlockingWholeLodgeHolds({
        lodgeId,
        from,
        toExclusive,
        db: tx,
      }),
    );
    const unheldRows = writableRows.filter(
      (row) => !isWholeLodgeHeld(lodgeId, formatDateOnly(row.stayDate)),
    );
    if (unheldRows.length < writableRows.length) {
      logger.info(
        {
          droppedCount: writableRows.length - unheldRows.length,
          lodgeId,
        },
        "Run Auto Allocation dropped suggestions targeting whole-lodge-held nights",
      );
    }
    if (unheldRows.length === 0) {
      return { count: 0 };
    }

    return tx.bedAllocation.createMany({
      data: unheldRows,
      skipDuplicates: true,
    });
  };

  return prisma.$transaction(writeUnderLocks, LOCK1_HOLDER_TRANSACTION_BUDGET);
}
