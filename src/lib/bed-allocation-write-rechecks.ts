/**
 * Write-time re-checks for the bed-allocation lifecycle planner (#3128 split).
 *
 * Three filters, one job: take the payload a planner has already decided on and
 * drop the rows the database says must not be written, reading through the SAME
 * client that is about to perform the write. They exist because a bed-allocation
 * plan is read, computed and written in three separate steps, and the custodian
 * and whole-lodge exclusions have no database constraint behind them (owner
 * decision, #2286 option (a)) — so anything that commits between the plan and
 * the write would otherwise be silently written over.
 *
 * They take the caller's client and acquire nothing: every advisory lock, every
 * transaction boundary and every status-guarded claim stays in
 * `bed-allocation-lifecycle.ts`, which calls all three from inside the locked
 * apply (`INV-LOCK-004` — a read taken while a lock is held goes through the
 * caller's transaction client). Each returns a filtered copy and writes nothing
 * itself, so a dropped row simply stays in the awaiting-allocation queue for the
 * next reconcile.
 *
 * `custodian-write-path-contract.test.ts` reads the CALL SITES in the lifecycle
 * module as its evidence that these re-filters are still wired in, so moving a
 * definition here does not weaken that contract; moving a call would.
 */
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
} from "@/lib/date-only";
import type { BedAllocationDb } from "@/lib/bed-allocation-admin-contract";
import {
  custodianHeldBedNightKeys,
  findCustodianBedHolds,
} from "@/lib/custodian-occupancy";
import {
  buildWholeLodgeHeldNightPredicate,
  findBlockingWholeLodgeHolds,
} from "@/lib/exclusive-hold-occupancy";
import logger from "@/lib/logger";

/**
 * Drop any payload row that would land on a custodian-held bed-night (#2286
 * review M1).
 *
 * Called immediately before a `createMany`, on the SAME client that performs
 * it. The planner is already fed the holds as never-evictable unknown
 * occupants, but that read is not the write: no unique index and no database
 * constraint stands behind the custodian exclusion, so a hold that commits
 * between the plan and the write would otherwise be silently written over. This
 * is the write-time half, and it is what makes the DOMAIN_INVARIANTS claim
 * ("every placing write re-checks the live holds immediately before writing")
 * true for the lifecycle planner rather than only for `runAutoBedAllocation`.
 */
/**
 * Drop any payload row that would land on a bed-night the database still shows
 * as occupied (#2656).
 *
 * `createMany({ skipDuplicates: true })` is NOT a safety mechanism here. On a
 * shared DOUBLE (#1701) it silently swallows a row that collides with a
 * surviving PRIMARY — the guest-night is then neither placed nor reported — and
 * it does not collide at all when the survivor is the SECOND occupant, so the
 * row is created and an unrelated person is written into a double beside
 * someone else's partner, with no `MemberPartnerLink`. The corrected planner
 * never drafts either row; this is the write-layer proof of that rather than a
 * reliance on the unique index to notice.
 *
 * Runs BEFORE the displacements are applied (#2669 review F1). It can, because
 * the caller's exclusion set names the SOURCE bed of every planned
 * displacement, so a bed the plan is about to free already reads as free here
 * without depending on the write having happened. Anything still occupied,
 * after that exclusion, is a genuine disagreement
 * between the plan and the database (a concurrent writer, or a planner
 * regression), and refusing the row leaves the guest-night in the
 * awaiting-allocation queue for the next reconcile — the same posture as the
 * custodian and whole-lodge re-filters.
 */
export async function dropRowsOnOccupiedBedNights<
  TRow extends { bedId: string; stayDate: Date },
>(
  db: BedAllocationDb,
  rows: TRow[],
  context: {
    bookingId: string;
    /**
     * The occupant slots this apply has already vacated, keyed
     * `sourceBedId:bookingGuestId:stayDate` — the bed each displaced row was on
     * BEFORE the displacement ran.
     *
     * The source bed has to be part of the key (#2669 review). This read runs
     * after the displacements on the same client, so a DELETEd row is already
     * gone and this exclusion is only belt-and-braces for it; but a MOVEd row
     * still exists, at its NEW bed. Keyed by guest-night alone the exclusion
     * would strike that row out too, and the MOVE's DESTINATION bed-night would
     * read as free — admitting a payload row onto an occupied bed, which is the
     * one outcome this whole function exists to prevent. Keyed by source bed the
     * exclusion only ever forgives an occupant found where it used to be.
     */
    vacatedOccupantSlots?: Set<string>;
  },
): Promise<TRow[]> {
  if (rows.length === 0) return rows;

  const occupants = await db.bedAllocation.findMany({
    where: {
      OR: rows.map((row) => ({ bedId: row.bedId, stayDate: row.stayDate })),
    },
    select: { bedId: true, stayDate: true, bookingGuestId: true },
  });
  if (occupants.length === 0) return rows;

  const vacated = context.vacatedOccupantSlots;
  const takenKeys = new Set(
    occupants
      .filter(
        (occupant) =>
          !vacated?.has(
            `${occupant.bedId}:${occupant.bookingGuestId}:${formatDateOnly(occupant.stayDate)}`,
          ),
      )
      .map(
        (occupant) => `${occupant.bedId}:${formatDateOnly(occupant.stayDate)}`,
      ),
  );
  const writable = rows.filter(
    (row) => !takenKeys.has(`${row.bedId}:${formatDateOnly(row.stayDate)}`),
  );
  if (writable.length < rows.length) {
    logger.error(
      {
        bookingId: context.bookingId,
        droppedCount: rows.length - writable.length,
        issue: 2656,
      },
      "Bed allocation write-time re-check dropped rows targeting bed-nights that are still occupied — the plan and the database disagree",
    );
  }
  return writable;
}

export async function dropRowsOnCustodianHeldBedNights<
  TRow extends { bedId: string; stayDate: Date },
>(
  db: BedAllocationDb,
  rows: TRow[],
  context: { lodgeId?: string; bookingId: string },
): Promise<TRow[]> {
  if (rows.length === 0) return rows;

  const stayDates = rows.map((row) => row.stayDate);
  const from = stayDates.reduce((a, b) => (a < b ? a : b));
  const latest = stayDates.reduce((a, b) => (a > b ? a : b));
  const toExclusive = addDaysDateOnly(latest, 1);

  const heldKeys = custodianHeldBedNightKeys(
    await findCustodianBedHolds({
      lodgeId: context.lodgeId,
      from,
      toExclusive,
      db,
    }),
    eachDateOnlyInRange(from, toExclusive),
  );
  if (heldKeys.size === 0) return rows;

  const writable = rows.filter(
    (row) => !heldKeys.has(`${row.bedId}:${formatDateOnly(row.stayDate)}`),
  );
  if (writable.length < rows.length) {
    logger.info(
      {
        bookingId: context.bookingId,
        lodgeId: context.lodgeId ?? null,
        droppedCount: rows.length - writable.length,
      },
      "Bed allocation write-time re-check dropped rows targeting custodian-held bed-nights",
    );
  }
  return writable;
}

/**
 * Drop any payload row that would land on a whole-lodge-held night (#2317).
 *
 * The exact mirror of the custodian re-filter above, and it exists for the same
 * reason: the planner IS fed the hold as blocking unattributed occupancy, but
 * that read happened several queries earlier and this reconcile is routinely
 * called post-commit and unlocked. Nothing in the database stops a row landing
 * on a held bed-night, so a hold that commits between the plan and the write
 * would otherwise be written straight over.
 *
 * `dropAllocationRowsForUnallocatableBookings` does NOT cover this: it asks
 * whether the booking we are placing became unallocatable, and a hold set on a
 * DIFFERENT booking leaves ours perfectly allocatable while taking every bed it
 * was about to occupy.
 *
 * A row whose room has no resolved lodge is treated as held by ANY hold
 * (null-tolerant matching), which is the conservative direction.
 */
export async function dropRowsOnWholeLodgeHeldNights<
  TRow extends { roomId: string; stayDate: Date },
>(
  db: BedAllocationDb,
  rows: TRow[],
  context: {
    lodgeId?: string;
    bookingId: string;
    roomLodgeIdById: ReadonlyMap<string, string>;
  },
): Promise<TRow[]> {
  if (rows.length === 0) return rows;

  const stayDates = rows.map((row) => row.stayDate);
  const from = stayDates.reduce((a, b) => (a < b ? a : b));
  const latest = stayDates.reduce((a, b) => (a > b ? a : b));
  const toExclusive = addDaysDateOnly(latest, 1);

  const isWholeLodgeHeld = buildWholeLodgeHeldNightPredicate(
    await findBlockingWholeLodgeHolds({
      lodgeId: context.lodgeId,
      from,
      toExclusive,
      db,
    }),
  );

  const writable = rows.filter(
    (row) =>
      !isWholeLodgeHeld(
        context.lodgeId ?? context.roomLodgeIdById.get(row.roomId) ?? null,
        formatDateOnly(row.stayDate),
      ),
  );
  if (writable.length < rows.length) {
    logger.info(
      {
        bookingId: context.bookingId,
        lodgeId: context.lodgeId ?? null,
        droppedCount: rows.length - writable.length,
      },
      "Bed allocation write-time re-check dropped rows targeting whole-lodge-held nights",
    );
  }
  return writable;
}
