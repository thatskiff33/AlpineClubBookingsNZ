/**
 * Room inventory for bed allocation: list, configure, seed, edit, delete
 * (#2688).
 *
 * The room half of the lodge's physical inventory, plus the club-config import
 * that seeds it and the refusals that protect allocation history. Beds are
 * `bed-allocation-beds.ts`; the bunk-pairing rule is
 * `bed-allocation-bunk-pairing.ts`.
 */
import { Prisma, type LodgeRoom } from "@prisma/client";
import { clubConfig } from "@/config/club";
import {
  getLodgePartnerSharedCapacityStatus,
  type LodgePartnerSharedCapacityStatus,
} from "@/lib/lodge-capacity";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
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
import type { DashboardRoom } from "@/lib/bed-allocation-board-payload";

export interface RoomsAndBedsConfigurationPayload {
  rooms: DashboardRoom[];
  // Includes the partner-shared headroom (#1745) so the admin Capacity card
  // can break the figure out ("10 beds + up to 1 partner spot").
  capacity: LodgePartnerSharedCapacityStatus;
  canImportFromConfig: boolean;
  configBeds: Array<{
    id: string;
    name: string;
    capacity: number;
    type: string;
  }>;
}

export interface ImportRoomsAndBedsResult {
  createdRoomCount: number;
  createdBedCount: number;
  rooms: DashboardRoom[];
}

export async function listBedAllocationRooms(
  db: BedAllocationDb = prisma,
  lodgeId?: string,
) {
  return db.lodgeRoom.findMany({
    // Null-tolerant filter: rooms without a lodgeId (pre-backfill or written
    // by a draining old colour during the expand deploy) show under every
    // lodge.
    where: lodgeId ? lodgeNullTolerantScope(lodgeId) : undefined,
    include: {
      beds: {
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
  });
}

export async function getRoomsAndBedsConfiguration(
  db: BedAllocationDb = prisma,
  requestedLodgeId?: string,
): Promise<RoomsAndBedsConfigurationPayload> {
  const lodgeId = requestedLodgeId ?? (await getDefaultLodgeId(db));
  const rooms = await listBedAllocationRooms(db, lodgeId);
  const capacity = await getLodgePartnerSharedCapacityStatus(lodgeId, db);
  // Import seeds the club's first lodge only, so the offer keys off the
  // whole tables being empty, not just the selected lodge's slice.
  const [totalRoomCount, totalBedCount] = await Promise.all([
    db.lodgeRoom.count(),
    db.lodgeBed.count(),
  ]);

  return {
    rooms: serializeRooms(rooms),
    // `capacity` is resolved from the DB (getLodgePartnerSharedCapacityStatus).
    // `configBeds` below is the club.json bed list used ONLY as a SEED TEMPLATE
    // for the "import from config" affordance (#1982) — club.json is never a
    // runtime capacity source; the resolved `capacity` above does not read it.
    capacity,
    canImportFromConfig: totalRoomCount === 0 && totalBedCount === 0,
    configBeds: clubConfig.beds.map((bed) => ({
      id: bed.id,
      name: bed.name,
      capacity: bed.capacity,
      type: bed.type,
    })),
  };
}

function uniqueConfigRoomName(
  bed: (typeof clubConfig.beds)[number],
  seenNames: Set<string>,
) {
  const baseName = bed.name.trim() || bed.id.trim() || "Imported Room";
  if (!seenNames.has(baseName)) {
    seenNames.add(baseName);
    return baseName;
  }

  const fallbackName = `${baseName} (${bed.id})`;
  seenNames.add(fallbackName);
  return fallbackName;
}

async function assertRoomBedTablesEmpty(db: BedAllocationDb) {
  const [roomCount, bedCount] = await Promise.all([
    db.lodgeRoom.count(),
    db.lodgeBed.count(),
  ]);

  if (roomCount > 0 || bedCount > 0) {
    throw new BedAllocationAdminError(
      "Rooms and beds have already been configured.",
      409,
    );
  }
}

export async function importRoomsAndBedsFromClubConfig(input: {
  db?: BedAllocationDb;
} = {}): Promise<ImportRoomsAndBedsResult> {
  if (!input.db) {
    return prisma.$transaction((tx) =>
      importRoomsAndBedsFromClubConfig({ db: tx }),
    );
  }

  const db = input.db ?? prisma;
  await assertRoomBedTablesEmpty(db);

  const lodgeId = await getDefaultLodgeId(db);
  const seenNames = new Set<string>();
  let createdRoomCount = 0;
  let createdBedCount = 0;

  for (const [roomIndex, configBed] of clubConfig.beds.entries()) {
    const room = await db.lodgeRoom.create({
      data: {
        name: uniqueConfigRoomName(configBed, seenNames),
        sortOrder: roomIndex + 1,
        active: true,
        notes: `${configBed.type} room imported from club config.`,
        lodgeId,
      },
    });
    createdRoomCount += 1;

    await db.lodgeBed.createMany({
      data: Array.from({ length: configBed.capacity }, (_, bedIndex) => ({
        roomId: room.id,
        name:
          configBed.capacity === 1
            ? configBed.name
            : `Bed ${bedIndex + 1}`,
        sortOrder: bedIndex + 1,
        active: true,
      })),
    });
    createdBedCount += configBed.capacity;
  }

  const rooms = await listBedAllocationRooms(db);
  return {
    createdRoomCount,
    createdBedCount,
    rooms: serializeRooms(rooms),
  };
}

export async function createBedAllocationRoom(input: {
  name: string;
  sortOrder?: number;
  active?: boolean;
  notes?: string | null;
  lodgeId?: string;
}) {
  const db = prisma;
  const lodgeId = input.lodgeId ?? (await getDefaultLodgeId(db));
  const name = input.name.trim();
  // Per-lodge uniqueness with null tolerance: a null-lodge row (pre-backfill
  // or draining old colour) is visible at every lodge, so it clashes here.
  const clash = await db.lodgeRoom.findFirst({
    where: { name, ...lodgeNullTolerantScope(lodgeId) },
    select: { id: true },
  });
  if (clash) {
    throw new BedAllocationAdminError(
      `A room named "${name}" already exists at this lodge.`,
      409,
    );
  }
  return db.lodgeRoom.create({
    data: {
      name,
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
      notes: input.notes?.trim() || null,
      lodgeId,
    },
  });
}

export const MAX_BULK_ROOMS = 50;
export const MAX_BULK_BEDS_PER_ROOM = 20;

/**
 * Seed a lodge with `roomCount` rooms of `bedsPerRoom` beds each
 * ("<prefix> 1..N" / "Bed 1..M"), transactionally (ADR-003 bulk seeding).
 * Room names are unique per lodge (null-lodge rows clash at every lodge
 * until the contract release), so a clashing prefix rejects the whole
 * batch rather than half-applying.
 */
export async function createBedAllocationRoomsBulk(input: {
  roomCount: number;
  bedsPerRoom: number;
  namePrefix?: string;
  lodgeId?: string;
  db?: BedAllocationDb;
}): Promise<{ createdRoomCount: number; createdBedCount: number }> {
  if (!input.db) {
    return prisma.$transaction((tx) =>
      createBedAllocationRoomsBulk({ ...input, db: tx }),
    );
  }
  const db = input.db;

  if (input.roomCount < 1 || input.roomCount > MAX_BULK_ROOMS) {
    throw new BedAllocationAdminError(
      `Room count must be between 1 and ${MAX_BULK_ROOMS}.`,
      400,
    );
  }
  if (input.bedsPerRoom < 0 || input.bedsPerRoom > MAX_BULK_BEDS_PER_ROOM) {
    throw new BedAllocationAdminError(
      `Beds per room must be between 0 and ${MAX_BULK_BEDS_PER_ROOM}.`,
      400,
    );
  }

  const namePrefix = input.namePrefix?.trim() || "Room";
  const lodgeId = input.lodgeId ?? (await getDefaultLodgeId(db));
  const names = Array.from(
    { length: input.roomCount },
    (_, index) => `${namePrefix} ${index + 1}`,
  );

  const clash = await db.lodgeRoom.findFirst({
    where: { name: { in: names }, ...lodgeNullTolerantScope(lodgeId) },
    select: { name: true },
  });
  if (clash) {
    throw new BedAllocationAdminError(
      `A room named "${clash.name}" already exists at this lodge. Choose a different name prefix.`,
      409,
    );
  }

  const existingCount = await db.lodgeRoom.count({
    where: lodgeNullTolerantScope(lodgeId),
  });

  let createdBedCount = 0;
  for (const [index, name] of names.entries()) {
    const room = await db.lodgeRoom.create({
      data: {
        name,
        sortOrder: existingCount + index + 1,
        active: true,
        lodgeId,
      },
    });
    if (input.bedsPerRoom > 0) {
      await db.lodgeBed.createMany({
        data: Array.from({ length: input.bedsPerRoom }, (_, bedIndex) => ({
          roomId: room.id,
          name: `Bed ${bedIndex + 1}`,
          sortOrder: bedIndex + 1,
          active: true,
        })),
      });
      createdBedCount += input.bedsPerRoom;
    }
  }

  return {
    createdRoomCount: names.length,
    createdBedCount,
  };
}

export async function updateBedAllocationRoom(input: {
  id: string;
  name?: string;
  sortOrder?: number;
  active?: boolean;
  notes?: string | null;
}) {
  // #3123 / INV-LOCK-004 — the club's day is resolved HERE, before the
  // transaction opens. Resolving it is a `clubTimeSettings.findUnique`, and
  // inside the transaction below that would take a second pooled connection
  // while the global cohort key and the per-lodge capacity key are held.
  const today = await clubTodayDateOnlyInstant();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const roomKey = await tx.lodgeRoom.findUnique({
      where: { id: input.id },
      select: { lodgeId: true },
    });
    if (!roomKey) {
      throw new BedAllocationAdminError("Room not found", 404);
    }
    if (roomKey.lodgeId) {
      await acquireLodgeCapacityLock(tx, roomKey.lodgeId);
    }
    return updateBedAllocationRoomWithLocksHeld({ ...input, db: tx, today });
  });
}

/** Internal room writer for callers that already hold global -> owning lodge. */
export async function updateBedAllocationRoomWithLocksHeld(input: {
  id: string;
  name?: string;
  sortOrder?: number;
  active?: boolean;
  notes?: string | null;
  db: BedAllocationDb;
  /**
   * The club's today, as the UTC-midnight `@db.Date` encoding
   * (`INV-DATE-026`), resolved by the caller BEFORE it opened the transaction
   * this runs inside (#3123, `INV-LOCK-004`). Required and never defaulted: a
   * default is what let this read the container's timezone instead of the
   * club's persisted one (`INV-CONFIG-002`), and a required parameter puts the
   * resolution where the locks are not.
   */
  today: Date;
}) {
  const db = input.db;

  // #2286: deactivating a room takes every bed in it out of the pool, so it
  // gets the same future-custodian-hold refusal a bed deactivate does. (Room
  // deactivate has never had an allocation guard of its own; this deliberately
  // adds only the custodian check, leaving the existing behaviour for ordinary
  // allocations untouched — widening that is a separate decision.)
  if (input.active === false) {
    const beds = await db.lodgeBed.findMany({
      where: { roomId: input.id },
      select: { id: true },
    });
    const today = input.today;
    for (const bed of beds) {
      const holds = await findFutureCustodianHoldsForBed({
        bedId: bed.id,
        today,
        db,
      });
      if (holds.length > 0) {
        const ranges = holds.map(
          (hold) => `${hold.startDate} to ${hold.endDate}`,
        );
        throw new BedAllocationAdminError(
          `Cannot deactivate this room while one of its beds is held by a hut-leader assignment (${ranges.join("; ")}). Clear the bed on the Hut Leaders page first.`,
          409,
        );
      }
    }
  }

  const data: Prisma.LodgeRoomUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.active !== undefined) data.active = input.active;
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;

  return db.lodgeRoom.update({
    where: { id: input.id },
    data,
  });
}

// Shared by the pre-check guard and the FK backstop so the concurrent-write
// race resolves to the exact same steering message an up-front check would give.
const ROOM_HAS_ALLOCATION_HISTORY_MESSAGE =
  "This room has allocation history and cannot be deleted. Deactivate it instead.";

// A bed added by another admin between the guard and the room delete trips the
// LodgeBed -> room Restrict FK, which is not allocation history — steer to a
// retry rather than to Deactivate.
const ROOM_CHANGED_WHILE_DELETING_MESSAGE =
  "Room changed while deleting (a bed was just added). Refresh and try again.";

// #2286: a custodian hold on one of the room's beds. Its own message, because
// the fix is on a different page from either of the two above.
const ROOM_HAS_CUSTODIAN_HOLD_MESSAGE =
  "A bed in this room is held by a hut-leader assignment, so the room cannot be deleted. Clear the bed on the Hut Leaders page first.";

// Classify a P2003 caught during the bed+room deletes. The pg driver adapter
// can drop the structured constraint field (see booking-envelope-invariants),
// so scan the message and any surviving meta. A BedAllocation FK means real
// allocation history (the raw pg message names LodgeBed as the table being
// modified in that case too, so BedAllocation must win when both appear); a
// LodgeBed -> room FK means a bed was added mid-delete; anything else falls
// back to the allocation-history steer.
function classifyRoomDeleteP2003(
  error: Prisma.PrismaClientKnownRequestError,
): string {
  const meta = error.meta as
    | { field_name?: unknown; constraint?: unknown }
    | undefined;
  const text = [
    error.message,
    typeof meta?.field_name === "string" ? meta.field_name : "",
    typeof meta?.constraint === "string" ? meta.constraint : "",
  ]
    .join(" ")
    .toLowerCase();
  // #2286: HutLeaderAssignment_bedId_fkey MUST be tested first. The raw pg
  // message for that violation names BOTH "hutleaderassignment" (the
  // referencing table) and "lodgebed" (the table being modified), so the old
  // lodgebed test would have matched it and steered the admin to "Refresh and
  // try again" — a retry that can never succeed, forever.
  if (text.includes("hutleaderassignment")) {
    return ROOM_HAS_CUSTODIAN_HOLD_MESSAGE;
  }
  // A BedAllocation FK means real allocation history (the raw pg message names
  // LodgeBed as the table being modified in that case too, so BedAllocation
  // must win over the LodgeBed test below).
  if (text.includes("bedallocation")) {
    return ROOM_HAS_ALLOCATION_HISTORY_MESSAGE;
  }
  // A LodgeBed -> room FK means a bed was added mid-delete; steer to a retry.
  if (text.includes("lodgebed")) {
    return ROOM_CHANGED_WHILE_DELETING_MESSAGE;
  }
  return ROOM_HAS_ALLOCATION_HISTORY_MESSAGE;
}

async function assertNoRoomAllocationHistory(
  roomId: string,
  db: BedAllocationDb,
) {
  // Any allocation row for the room (past or future) blocks a hard delete —
  // unlike the bed deactivate guard, which only cares about future dates. Rooms
  // with history keep their audit trail and are deactivated instead.
  const existing = await db.bedAllocation.findFirst({
    where: { roomId },
    select: { id: true },
  });
  if (existing) {
    throw new BedAllocationAdminError(ROOM_HAS_ALLOCATION_HISTORY_MESSAGE, 409);
  }

  // #2286, guard-gap fix: the room delete bulk-deletes the room's beds, which
  // BYPASSES the per-bed custodian guard entirely — before this check, a room
  // whose bed a custodian held could only fail at the FK, with a P2003 the
  // classifier used to mis-steer. Refuse here, with the right message.
  const beds = await db.lodgeBed.findMany({
    where: { roomId },
    select: { id: true },
  });
  const holds = await findAnyCustodianHoldsForBeds({
    bedIds: beds.map((bed) => bed.id),
    db,
  });
  if (holds.length > 0) {
    throw new BedAllocationAdminError(ROOM_HAS_CUSTODIAN_HOLD_MESSAGE, 409);
  }
}

export async function deleteBedAllocationRoom(input: {
  id: string;
  // Optional lodge scope, consistent with the other room functions: when
  // supplied the room must belong to this lodge (else 404). The route mirrors
  // the bed DELETE and does not pass it; callers that carry lodge context can
  // scope the delete defensively.
  lodgeId?: string;
}): Promise<LodgeRoom> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const roomKey = await tx.lodgeRoom.findFirst({
      where: {
        id: input.id,
        ...(input.lodgeId ? lodgeNullTolerantScope(input.lodgeId) : {}),
      },
      select: { lodgeId: true },
    });
    if (!roomKey) {
      throw new BedAllocationAdminError("Room not found", 404);
    }
    if (roomKey.lodgeId) {
      await acquireLodgeCapacityLock(tx, roomKey.lodgeId);
    }
    return deleteBedAllocationRoomWithLocksHeld({ ...input, db: tx });
  });
}

/** Internal room delete for callers that already hold global -> owning lodge. */
export async function deleteBedAllocationRoomWithLocksHeld(input: {
  id: string;
  lodgeId?: string;
  db: BedAllocationDb;
}): Promise<LodgeRoom> {
  // The history guard and bed+room deletes share the caller's transaction so a
  // concurrent allocation cannot slip between them.
  const db = input.db;

  const room = await db.lodgeRoom.findFirst({
    where: {
      id: input.id,
      ...(input.lodgeId ? lodgeNullTolerantScope(input.lodgeId) : {}),
    },
    select: { id: true },
  });
  if (!room) {
    throw new BedAllocationAdminError("Room not found", 404);
  }

  await assertNoRoomAllocationHistory(room.id, db);

  try {
    // The room's beds go with it under the same guard. Deleting the beds first
    // also trips the BedAllocation composite (bedId, roomId) FK if an
    // allocation was created after the guard ran.
    await db.lodgeBed.deleteMany({ where: { roomId: room.id } });
    return await db.lodgeRoom.delete({ where: { id: room.id } });
  } catch (error) {
    // FK Restrict backstop closing the guard->delete race. A concurrently
    // created BedAllocation (BedAllocation.room / .bed are onDelete: Restrict)
    // surfaces as P2003 and rolls the transaction back — map it to the same
    // steering message as the up-front guard. A bed added mid-delete trips the
    // LodgeBed -> room FK instead, which is not history, so steer to a retry.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      throw new BedAllocationAdminError(classifyRoomDeleteP2003(error), 409);
    }
    throw error;
  }
}

export function serializeRooms(rooms: Awaited<ReturnType<typeof listBedAllocationRooms>>) {
  return rooms.map((room) => ({
    id: room.id,
    name: room.name,
    sortOrder: room.sortOrder,
    active: room.active,
    notes: room.notes,
    beds: room.beds.map((bed) => ({
      id: bed.id,
      roomId: bed.roomId,
      name: bed.name,
      sortOrder: bed.sortOrder,
      active: bed.active,
      bedType: bed.bedType,
      bunkGroup: bed.bunkGroup,
    })),
  }));
}
