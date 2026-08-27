/**
 * Bed inventory for bed allocation: create, edit, retire, delete (#2688).
 *
 * The bed half of the lodge's physical inventory. Every deactivate and delete
 * passes the two refusals below, which are what stop an admin retiring a bed
 * somebody is lying in (INV-DATE-002's night boundary) or one a custodian holds
 * (#2286).
 */
import { Prisma, type BedType, type LodgeBed } from "@prisma/client";
import { formatDateOnly } from "@/lib/date-only";
import { getEarliestCurrentBedNightDate } from "@/lib/booking-guest-stay-ranges";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import {
  findAnyCustodianHoldsForBeds,
  findFutureCustodianHoldsForBed,
} from "@/lib/custodian-occupancy";
import { prisma } from "@/lib/prisma";
import {
  BedAllocationAdminError,
  type BedAllocationDb,
} from "@/lib/bed-allocation-admin-contract";
import { guestName } from "@/lib/bed-allocation-display-names";
import {
  assertBunkGroupCanAdmit,
  assertBunkGroupTypeConsistency,
  lockRoomForBunkGroup,
  normalizeBunkGroup,
} from "@/lib/bed-allocation-bunk-pairing";

// The bed CREATE path never looks the room up (the route validates roomId only
// as a non-empty string), so any bogus or stale roomId — most commonly a room
// deleted in another tab — trips the
// LodgeBed.roomId -> LodgeRoom Restrict FK as P2003. That FK is the only one a
// bed insert can violate (roomId is LodgeBed's only outgoing relation; its
// BedAllocation children don't exist yet at create time, and the bunk lock +
// membership steps are read-only), so any P2003 raised inside
// createBedAllocationBed is unambiguously the missing room — no
// constraint-metadata classifier is needed here, unlike deleteBedAllocationRoom
// which must disambiguate two FKs. Steer the admin to refresh instead of the
// shared delete-history message, which is nonsense on the create path (#1700).
const ROOM_FOR_BED_MISSING_MESSAGE =
  "The room for this bed no longer exists. Refresh and try again.";

// 404 (not 409): the referenced room is genuinely gone, mirroring this file's
// other resource-not-found mappings ("Room not found" / "Bed not found") and the
// shared mapper's P2025 -> 404. This is distinct from the 409
// ROOM_CHANGED_WHILE_DELETING race, where the room still exists but a new child
// blocks the delete (a true conflict).
function mapMissingRoomOnBedCreate(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003"
  ) {
    return new BedAllocationAdminError(ROOM_FOR_BED_MISSING_MESSAGE, 404);
  }
  return error;
}

export async function createBedAllocationBed(input: {
  roomId: string;
  name: string;
  sortOrder?: number;
  active?: boolean;
  bedType?: BedType;
  bunkGroup?: string | null;
  db?: BedAllocationDb;
  // Explicit return type: the function references itself in the $transaction
  // branch, which TS cannot infer through (TS7023), matching the other
  // self-recursive transaction helpers here.
}): Promise<LodgeBed> {
  const bedType = input.bedType ?? "SINGLE";
  const bunkGroup = normalizeBunkGroup(input.bunkGroup);
  assertBunkGroupTypeConsistency(bedType, bunkGroup);

  try {
    // Only a grouped bed needs the serialised room lock + membership check; an
    // ungrouped bed skips the transaction entirely. `await` before returning so
    // a create-time P2003 is caught here (the recursive $transaction branch
    // rejects with the already-mapped error, which passes through unchanged).
    if (bunkGroup) {
      if (!input.db) {
        return await prisma.$transaction((tx) =>
          createBedAllocationBed({ ...input, db: tx }),
        );
      }
      const db = input.db;
      await lockRoomForBunkGroup(input.roomId, db);
      await assertBunkGroupCanAdmit({
        roomId: input.roomId,
        bunkGroup,
        bedType,
        db,
      });
      return await db.lodgeBed.create({
        data: {
          roomId: input.roomId,
          name: input.name.trim(),
          sortOrder: input.sortOrder ?? 0,
          active: input.active ?? true,
          bedType,
          bunkGroup,
        },
      });
    }

    return await (input.db ?? prisma).lodgeBed.create({
      data: {
        roomId: input.roomId,
        name: input.name.trim(),
        sortOrder: input.sortOrder ?? 0,
        active: input.active ?? true,
        bedType,
        bunkGroup: null,
      },
    });
  } catch (error) {
    throw mapMissingRoomOnBedCreate(error);
  }
}

export async function updateBedAllocationBed(input: {
  id: string;
  name?: string;
  sortOrder?: number;
  active?: boolean;
  bedType?: BedType;
  bunkGroup?: string | null;
}): Promise<LodgeBed> {
  // #3123 / INV-LOCK-004 — the club's day is resolved HERE, before the
  // transaction opens. Resolving it is a `clubTimeSettings.findUnique`, and
  // inside the transaction below that would take a second pooled connection
  // while the global cohort key and the per-lodge capacity key are held.
  const today = await clubTodayDateOnlyInstant();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const bedKey = await tx.lodgeBed.findUnique({
      where: { id: input.id },
      select: { room: { select: { lodgeId: true } } },
    });
    if (!bedKey) {
      throw new BedAllocationAdminError("Bed not found", 404);
    }
    if (bedKey.room.lodgeId) {
      await acquireLodgeCapacityLock(tx, bedKey.room.lodgeId);
    }
    return updateBedAllocationBedWithLocksHeld({ ...input, db: tx, today });
  });
}

/** Internal bed writer for callers that already hold global -> owning lodge. */
export async function updateBedAllocationBedWithLocksHeld(input: {
  id: string;
  name?: string;
  sortOrder?: number;
  active?: boolean;
  bedType?: BedType;
  bunkGroup?: string | null;
  db: BedAllocationDb;
  /**
   * The club's today, as the UTC-midnight `@db.Date` encoding
   * (`INV-DATE-026`), resolved by the caller BEFORE it opened the transaction
   * this runs inside (#3123, `INV-LOCK-004`). Required and never defaulted —
   * only the deactivate branch reads it, but making it required is what stops
   * the read drifting back inside the locks. The DELETE writer takes no such
   * parameter because its custodian refusal has no date predicate at all.
   */
  today: Date;
}): Promise<LodgeBed> {
  const touchesBunk =
    input.bedType !== undefined || input.bunkGroup !== undefined;

  const db = input.db;
  if (input.active === false) {
    await assertNoFutureBedAllocations({
      bedId: input.id,
      db,
      action: "deactivate",
      today: input.today,
    });
    // #2286: deactivating a bed removes it from the bookable pool, which would
    // silently strand a custodian who is meant to be sleeping in it.
    await assertNoCustodianHoldsForBed({
      bedId: input.id,
      db,
      action: "deactivate",
      today: input.today,
    });
  }

  const data: Prisma.LodgeBedUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.active !== undefined) data.active = input.active;

  if (touchesBunk) {
    const existing = await db.lodgeBed.findUnique({
      where: { id: input.id },
      select: { roomId: true, bedType: true, bunkGroup: true },
    });
    if (!existing) {
      throw new BedAllocationAdminError("Bed not found", 404);
    }

    // Re-validate against the bed's current room so a rename/regroup keeps the
    // pairing consistent, using the requested change layered over the stored
    // values.
    const nextBedType = input.bedType ?? existing.bedType;
    const nextBunkGroup =
      input.bunkGroup !== undefined
        ? normalizeBunkGroup(input.bunkGroup)
        : existing.bunkGroup;

    assertBunkGroupTypeConsistency(nextBedType, nextBunkGroup);

    if (nextBunkGroup) {
      await lockRoomForBunkGroup(existing.roomId, db);
      await assertBunkGroupCanAdmit({
        roomId: existing.roomId,
        bunkGroup: nextBunkGroup,
        bedType: nextBedType,
        excludeBedId: input.id,
        db,
      });
    }

    if (input.bedType !== undefined && input.bedType !== existing.bedType) {
      // #1701: a non-DOUBLE bed can never hold a second occupant (the partial
      // unique index forbids it). So a DOUBLE that currently has a shared
      // (two-occupant) allocation cannot be retyped until the second occupant is
      // removed — otherwise the denormalized-bedType rewrite below would drive
      // both occupant rows into the non-double partial index and collide.
      if (existing.bedType === "DOUBLE") {
        const sharedCount = await db.bedAllocation.count({
          where: { bedId: input.id, isSecondOccupant: true },
        });
        if (sharedCount > 0) {
          throw new BedAllocationAdminError(
            "This double bed has shared (two-occupant) allocations. Remove the second occupant before changing the bed type.",
            409,
          );
        }
      }
      // Keep the denormalized BedAllocation.bedType (used only by the non-double
      // partial index) in sync with the bed's new type. With no second-occupant
      // rows present, each bed-night has at most one row, so this rewrite can
      // never create a partial-index conflict.
      await db.bedAllocation.updateMany({
        where: { bedId: input.id },
        data: { bedType: input.bedType },
      });
    }

    if (input.bedType !== undefined) data.bedType = input.bedType;
    if (input.bunkGroup !== undefined) data.bunkGroup = nextBunkGroup;
  }

  return db.lodgeBed.update({
    where: { id: input.id },
    data,
  });
}

/**
 * Refuse to deactivate or delete a bed that guests are allocated to.
 *
 * The two actions take DIFFERENT windows, exactly like their custodian-hold
 * sibling below, and for the same two reasons (#2628):
 *
 * - DEACTIVATE only cares about occupancy that has not finished. That window
 *   starts at LAST NIGHT, not today: night N runs to midday NZ on date N+1
 *   (INV-DATE-002), so at any moment on day D the person who slept on night D-1
 *   is still in the lodge or has only just left it. `stayDate >= today` forgot
 *   them, which let an admin retire a bed somebody was lying in.
 *   `getEarliestCurrentBedNightDate` is the shared name for that boundary.
 * - DELETE refuses on ANY allocation, past included. `BedAllocation.bed` is
 *   `onDelete: Restrict`, so a bed with historic rows used to pass this guard
 *   and then fail deep in the driver with a raw P2003 the admin cannot act on.
 *
 * Either way the message names the guest, because "clear those dates" is not
 * actionable until you know whose booking to open.
 *
 * THE MESSAGE IS CAPPED AND THE QUERY IS BOUNDED. The delete branch has no date
 * predicate at all, so it can match every night a bed has ever held — several
 * seasons of them on a bed in long service. Enumerating all of those would put a
 * page of dates and a page of past guests' names into one 409 body and into the
 * audit trail, for what is a yes/no answer. Only the first few are loaded and
 * named; the rest become "and more". The room-level sibling
 * (`assertNoRoomAllocationHistory`) does not even name a date for this reason —
 * it is the same refusal, one level up.
 */
const BED_ALLOCATION_GUARD_MESSAGE_ROWS = 5;

async function assertNoFutureBedAllocations(
  input: {
    bedId: string;
    db: BedAllocationDb;
  } & (
    | { action: "delete" }
    /**
     * #3123 — DEACTIVATE is the only arm with a date predicate, so it is the
     * only arm that carries the club's day, and the union means the compiler
     * both DEMANDS it there and REFUSES it on delete. The value is the
     * UTC-midnight `@db.Date` encoding (`INV-DATE-026`), resolved by the caller
     * outside its transaction (`INV-LOCK-004`).
     */
    | { action: "deactivate"; today: Date }
  ),
) {
  const blockingAllocations = await input.db.bedAllocation.findMany({
    where: {
      bedId: input.bedId,
      ...(input.action === "delete"
        ? {}
        : {
            stayDate: {
              gte: getEarliestCurrentBedNightDate(input.today),
            },
          }),
    },
    select: {
      stayDate: true,
      bookingGuest: { select: { firstName: true, lastName: true } },
    },
    orderBy: { stayDate: "asc" },
    // One more than we will name, which is all it takes to know there are more.
    take: BED_ALLOCATION_GUARD_MESSAGE_ROWS + 1,
  });

  if (blockingAllocations.length === 0) {
    return;
  }

  const truncated =
    blockingAllocations.length > BED_ALLOCATION_GUARD_MESSAGE_ROWS;
  const named = blockingAllocations.slice(0, BED_ALLOCATION_GUARD_MESSAGE_ROWS);

  const blockingDates = [
    ...new Set(named.map((allocation) => formatDateOnly(allocation.stayDate))),
  ];
  const occupants = [
    ...new Set(
      named.map((allocation) => guestName(allocation.bookingGuest)).filter(Boolean),
    ),
  ];
  const dateList = `${blockingDates.join(", ")}${truncated ? " and more" : ""}`;
  const occupied =
    occupants.length > 0
      ? ` (${occupants.join(", ")}${truncated ? " and others" : ""})`
      : "";
  const window = input.action === "delete" ? "allocations" : "current or future allocations";

  throw new BedAllocationAdminError(
    `Cannot ${input.action} this bed while ${window} exist on ${dateList}${occupied}. Clear those dates on the bed allocation page first.`,
    409,
  );
}

/**
 * Refuse to deactivate or delete a bed a custodian holds (#2286).
 *
 * DEACTIVATE only cares about coverage from today onwards — a past season is
 * history and deactivating the bed changes nothing about it. DELETE refuses on
 * ANY hold, past included: the FK is `onDelete: Restrict`, so a delete would
 * otherwise fail deep in the driver with a raw P2003 the admin cannot act on.
 * The message names the Hut Leaders page because that, not the board, is where
 * the fix lives.
 */
async function assertNoCustodianHoldsForBed(
  input: {
    bedId: string;
    db: BedAllocationDb;
  } & (
    | { action: "delete" }
    /**
     * #3123 — DEACTIVATE is the only arm with a date predicate, so it is the
     * only arm that carries the club's day, and the union means the compiler
     * both DEMANDS it there and REFUSES it on delete. The value is the
     * UTC-midnight `@db.Date` encoding (`INV-DATE-026`), resolved by the
     * caller outside its transaction (`INV-LOCK-004`); this function reads no
     * clock and resolves no timezone.
     */
    | { action: "deactivate"; today: Date }
  ),
) {
  const holds =
    input.action === "delete"
      ? await findAnyCustodianHoldsForBeds({
          bedIds: [input.bedId],
          db: input.db,
        })
      : await findFutureCustodianHoldsForBed({
          bedId: input.bedId,
          today: input.today,
          db: input.db,
        });
  if (holds.length === 0) return;

  const ranges = holds.map((hold) => `${hold.startDate} to ${hold.endDate}`);
  throw new BedAllocationAdminError(
    `Cannot ${input.action} this bed while it is held by a hut-leader assignment (${ranges.join("; ")}). Clear the bed on the Hut Leaders page first.`,
    409,
  );
}

export async function deleteBedAllocationBed(input: {
  id: string;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const bedKey = await tx.lodgeBed.findUnique({
      where: { id: input.id },
      select: { room: { select: { lodgeId: true } } },
    });
    if (!bedKey) {
      throw new BedAllocationAdminError("Bed not found", 404);
    }
    if (bedKey.room.lodgeId) {
      await acquireLodgeCapacityLock(tx, bedKey.room.lodgeId);
    }
    return deleteBedAllocationBedWithLocksHeld({ ...input, db: tx });
  });
}

/** Internal bed delete for callers that already hold global -> owning lodge. */
export async function deleteBedAllocationBedWithLocksHeld(input: {
  id: string;
  db: BedAllocationDb;
}) {
  const db = input.db;
  await assertNoFutureBedAllocations({
    bedId: input.id,
    db,
    action: "delete",
  });
  // #2286: the bed FK on HutLeaderAssignment is Restrict, so a held bed would
  // otherwise fail with a raw P2003. Refuse up front with a message that names
  // the page the admin has to visit.
  await assertNoCustodianHoldsForBed({ bedId: input.id, db, action: "delete" });

  return db.lodgeBed.delete({
    where: { id: input.id },
  });
}
