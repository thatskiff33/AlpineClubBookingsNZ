import {
  Prisma,
  type BedAllocation,
  type BedType,
  type LodgeBed,
  type LodgeRoom,
} from "@prisma/client";
import { clubConfig } from "@/config/club";
import {
  addDaysDateOnly,
  countNightsDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import {
  getLodgePartnerSharedCapacityStatus,
  type LodgePartnerSharedCapacityStatus,
} from "@/lib/lodge-capacity";
import {
  buildFirstFitBedAllocationPlan,
  type BedAllocationAgeTier,
  type BedAllocationBooking,
  type BedAllocationCandidate,
  type BedAllocationRoom,
  type UnallocatedGuestNight,
} from "@/lib/bed-allocation";
import {
  BED_ALLOCATABLE_BOOKING_STATUSES,
  dropAllocationRowsForUnallocatableBookings,
  promoteOrphanedSecondOccupants,
  promoteOrphanedSecondOccupantsBatch,
} from "@/lib/bed-allocation-lifecycle";
import logger from "@/lib/logger";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  bookingHoldsCapacity,
  isCapacityHoldingBookingStatus,
} from "@/lib/booking-status";
import {
  mayShareDoubleBed,
  mayShareDoubleBedWith,
} from "@/lib/double-bed-sharing";
import { createAuditLog } from "@/lib/audit";
import {
  acquireLodgeCapacityLock,
  bookingsOverlap,
  sameLodgeNullTolerant,
} from "@/lib/capacity";
import {
  assertBedNightsFreeOfCustodianHold,
  custodianHeldBedNightKeys,
  custodianHeldNightsForBed,
  custodianOccupiedBedNightsForPlanner,
  CustodianHoldConflictError,
  findAnyCustodianHoldsForBeds,
  findCustodianBedHolds,
  findFutureCustodianHoldsForBed,
} from "@/lib/custodian-occupancy";
import {
  buildWholeLodgeHeldNightPredicate,
  findBlockingWholeLodgeHolds,
  wholeLodgeHoldOccupiedBedNightsForPlanner,
} from "@/lib/exclusive-hold-occupancy";
import {
  OPERATIONALLY_PRESENT_GUEST_WHERE,
  isOperationallyPresentConsent,
} from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";
import {
  parseBedAllocationPriorityOrder,
  resolveEffectiveBedAllocationSettings,
  type BedAllocationPriority,
  type EffectiveBedAllocationSettings,
} from "@/lib/bed-allocation-settings";

const BED_ALLOCATION_SETTINGS_ID = "default";
export const MAX_BED_ALLOCATION_RANGE_NIGHTS = 31;

export class BedAllocationAdminError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "BedAllocationAdminError";
  }
}

export interface BedAllocationDateRange {
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
}

export type BedAllocationSettingsPayload = EffectiveBedAllocationSettings;

export interface AdminBedAllocationWarning {
  id: string;
  // BOOKING_SPLIT is same-night (party split across rooms on one night);
  // ROOM_SWITCH is stay-level (issue #1677) — the booking's room set changes
  // between nights, so someone must move rooms mid-stay. MINOR_ADULT_MIX
  // (#1768) flags a room-night where one booking's minors share the room with
  // another booking's adults — the planner never creates this, so it marks a
  // pre-existing or manual placement for the admin to resolve.
  // CUSTODIAN_BED_CONFLICT (#2286) is the NET behind the app-code exclusion
  // (owner decision, option (a)): an allocation row sitting on a bed-night a
  // custodian holds. The guards make it unreachable through the app, so a row
  // here means direct SQL, a pre-#2286 row, or the one accepted deploy-drain
  // exposure (an old-colour admin allocation path has no custodian check for
  // the seconds-to-minutes of a drain). Surfacing it is what makes that
  // exposure acceptable — see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.
  type:
    | "BOOKING_SPLIT"
    | "MINOR_WITHOUT_BOOKING_ADULT"
    | "ROOM_SWITCH"
    | "MINOR_ADULT_MIX"
    | "CUSTODIAN_BED_CONFLICT";
  severity: "warning";
  bookingId: string;
  bookingGuestId?: string;
  stayDate: string;
  roomId?: string;
  message: string;
}

interface DashboardRoom {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  notes: string | null;
  beds: DashboardBed[];
}

interface DashboardBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  active: boolean;
  // Descriptive bed type (#1675); does not change capacity (1/bed/night).
  bedType: BedType;
  // Pairing label; two beds max per (room, bunkGroup), one top + one bottom.
  bunkGroup: string | null;
}

interface DashboardBooking {
  id: string;
  status: string;
  // Server-computed capacity-holding flag (#1254): status-holding OR a
  // request-converted PENDING booking (accepted-but-unpaid quote / approval).
  holdsCapacity: boolean;
  createdAt: string;
  checkIn: string;
  checkOut: string;
  memberName: string;
  guests: DashboardGuest[];
  requestedRoom: DashboardRequestedRoom | null;
  // Split-booking group link (#738): set on the provisional non-member child.
  parentBookingId: string | null;
  // Exclusive whole-lodge hold on THIS booking (ADR-001, #120): its guests are
  // short-circuited out of per-bed allocation and shown as an exclusive-hold
  // banner instead. Admin-only signal.
  wholeLodgeHold: boolean;
  // This (non-held) booking overlaps another booking's exclusive whole-lodge
  // hold (ADR-001 decision 1, #119): flagged so staff see the clash from the
  // ordinary booking's side. Always false for a held booking itself.
  overlapsExclusiveHold: boolean;
}

interface DashboardGuest {
  id: string;
  bookingId: string;
  name: string;
  ageTier: BedAllocationAgeTier;
  stayStart: string;
  stayEnd: string;
}

interface DashboardAllocation {
  id: string;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: BedAllocationAgeTier;
  roomId: string;
  roomName: string;
  bedId: string;
  bedName: string;
  stayDate: string;
  source: "AUTO" | "MANUAL";
  approvedAt: string | null;
  approvedByName: string | null;
  isSecondOccupant?: boolean;
  familyGroupIds?: string[];
  // Raw booking status (issue #1251), kept for display/debugging.
  bookingStatus: string;
  // Server-computed "Held" vs "Provisional" signal (#1254). Holding is no longer
  // a pure function of status (an accepted-but-unpaid quote is PENDING but holds),
  // so the board reads this precomputed flag from bookingHoldsCapacity().
  holdsCapacity: boolean;
}

interface DashboardGuestNight {
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: BedAllocationAgeTier;
  memberName: string;
  stayDate: string;
  familyGroupIds: string[];
}

interface DashboardRequestedRoom {
  id: string;
  name: string;
  active: boolean;
}

// A booking with an exclusive whole-lodge hold (ADR-001, issue #120). It needs
// NO per-bed allocation — it implicitly occupies every bed — so it is shown as
// a distinct board banner rather than in the awaiting-allocation bucket.
export interface DashboardExclusiveHold {
  bookingId: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  // The held nights that fall within the board's current date range.
  nights: string[];
}

// A custodian bed hold overlapping the board's range (#2286): a bed held for a
// season by a hut-leader assignment, with NO booking and NO BedAllocation row
// anywhere. The board renders it as a non-allocatable band across that bed's
// cells and refuses any drop onto it.
export interface DashboardCustodianHold {
  assignmentId: string;
  memberName: string;
  bedId: string;
  bedName: string;
  roomId: string;
  roomName: string;
  /** The hold's own inclusive range, so the tooltip can state the whole season. */
  startDate: string;
  endDate: string;
  /** The held nights that fall within the board's current date range. */
  nights: string[];
}

export interface BedAllocationDashboardPayload {
  settings: BedAllocationSettingsPayload;
  range: {
    fromDate: string;
    toDate: string;
  };
  rooms: DashboardRoom[];
  bookings: DashboardBooking[];
  allocations: DashboardAllocation[];
  unallocatedGuestNights: DashboardGuestNight[];
  // Exclusive whole-lodge holds overlapping the range (ADR-001, #120). Their
  // guests are deliberately ABSENT from unallocatedGuestNights / the planner —
  // a held lodge needs no per-bed placement — and are represented here instead.
  exclusiveHolds: DashboardExclusiveHold[];
  // Custodian bed holds overlapping the range (#2286). Additive, following the
  // exclusiveHolds precedent: the board draws a hatched non-allocatable band on
  // those bed-nights and the server 409s any drop regardless.
  custodianHolds: DashboardCustodianHold[];
  suggestedAllocations: BedAllocationCandidate[];
  suggestedUnallocatedGuestNights: UnallocatedGuestNight[];
  warnings: AdminBedAllocationWarning[];
  // Stay window of a deep-linked focused booking (?bookingId=…) when it falls
  // outside the current date range and is therefore absent from `bookings`
  // (#1302). Lets the board snap Date In / Date Out onto the booking so its chip
  // becomes visible. Null when no booking is focused, when it is already in
  // range, or when it is not an allocatable booking.
  focusedBooking: { id: string; checkIn: string; checkOut: string } | null;
}

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

type BedAllocationDb = typeof prisma | Prisma.TransactionClient;

type DashboardBookingRecord = Awaited<
  ReturnType<typeof loadBookingRecords>
>[number];

type DashboardAllocationRecord = Awaited<
  ReturnType<typeof loadAllocationRecords>
>[number];

export function parseBedAllocationDateRange(input: {
  from?: string | null;
  to?: string | null;
}): BedAllocationDateRange {
  const fromDate = input.from || formatDateOnly(getTodayDateOnly());
  if (!isDateOnlyString(fromDate)) {
    throw new BedAllocationAdminError("Invalid from date", 400);
  }

  const from = parseDateOnly(fromDate);
  const toDate = input.to || formatDateOnly(addDaysDateOnly(from, 7));
  if (!isDateOnlyString(toDate)) {
    throw new BedAllocationAdminError("Invalid to date", 400);
  }

  const to = parseDateOnly(toDate);
  if (to <= from) {
    throw new BedAllocationAdminError("Date out must be after date in", 400);
  }

  const nights = eachDateOnlyInRange(from, to).length;
  if (nights > MAX_BED_ALLOCATION_RANGE_NIGHTS) {
    throw new BedAllocationAdminError(
      `Date range cannot exceed ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights`,
      400,
    );
  }

  return { from, to, fromDate, toDate };
}

export async function getEffectiveBedAllocationSettings(
  db: BedAllocationDb = prisma,
  // Lodge scope (lodge-scoping contract): the lodge's own row (id =
  // lodgeId) wins; else the legacy "default" row applies when unlinked or
  // soft-linked to this lodge; else code defaults.
  lodgeId?: string | null,
): Promise<BedAllocationSettingsPayload> {
  return resolveEffectiveBedAllocationSettings(db, lodgeId);
}

export async function updateBedAllocationSettings(input: {
  autoAllocationEnabled: boolean;
  allocationPriorityOrder: BedAllocationPriority[];
  updatedByMemberId: string;
  db?: BedAllocationDb;
  // Scoped admin writes require a lodge. A legacy default row is updated only
  // when it is already linked to that same lodge; otherwise the lodge-id row is
  // authoritative and the legacy row remains fallback-only.
  lodgeId: string;
}): Promise<BedAllocationSettingsPayload> {
  const db = input.db ?? prisma;
  const allocationPriorityOrder = parseBedAllocationPriorityOrder(
    input.allocationPriorityOrder,
    "allocationPriorityOrder",
    400,
  );
  const legacy = await db.bedAllocationSettings.findUnique({
    where: { id: BED_ALLOCATION_SETTINGS_ID },
  });
  const targetsLegacyRow = legacy?.lodgeId === input.lodgeId;
  const targetId = targetsLegacyRow
    ? BED_ALLOCATION_SETTINGS_ID
    : input.lodgeId;

  await db.bedAllocationSettings.upsert({
    where: { id: targetId },
    create: {
      id: targetId,
      autoAllocationEnabled: input.autoAllocationEnabled,
      allocationPriorityOrder,
      updatedByMemberId: input.updatedByMemberId,
      lodgeId: input.lodgeId,
    },
    update: {
      autoAllocationEnabled: input.autoAllocationEnabled,
      allocationPriorityOrder,
      updatedByMemberId: input.updatedByMemberId,
    },
  });

  return resolveEffectiveBedAllocationSettings(db, input.lodgeId);
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
    return updateBedAllocationRoomWithLocksHeld({ ...input, db: tx });
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
    const today = getTodayDateOnly();
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

// ---------------------------------------------------------------------------
// Bunk-pairing validation (#1675)
//
// A bunkGroup labels two physical beds stacked as a bunk: at most two beds may
// share one (roomId, bunkGroup), and they must be one BUNK_TOP + one
// BUNK_BOTTOM. A bunk type without a group is allowed (an unpaired bunk — the
// UI surfaces it as a soft warning); a group without a bunk type is rejected.
// These rules are enforced here rather than in the schema because a
// "<=2 per group, one of each type" invariant cannot be a plain unique index,
// and raw-SQL partial indexes are out of scope for this change.
// ---------------------------------------------------------------------------

function isBunkBedType(bedType: BedType): boolean {
  return bedType === "BUNK_TOP" || bedType === "BUNK_BOTTOM";
}

function bedTypeLabel(bedType: BedType): string {
  switch (bedType) {
    case "BUNK_TOP":
      return "bunk-top";
    case "BUNK_BOTTOM":
      return "bunk-bottom";
    case "DOUBLE":
      return "double";
    default:
      return "single";
  }
}

function normalizeBunkGroup(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Human list of quoted bed names, e.g. `"Old Top"` or `"Old Top" and "Old
// Bottom"`, used when naming the deactivated bed(s) that hold a bunk slot.
function quotedBedNames(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

function assertBunkGroupTypeConsistency(
  bedType: BedType,
  bunkGroup: string | null,
) {
  if (bunkGroup && !isBunkBedType(bedType)) {
    throw new BedAllocationAdminError(
      "A bunk group needs a bunk-top or bunk-bottom bed type.",
      400,
    );
  }
}

// Serialise concurrent bunk-group writes for one room so two "add a bed to
// Bunk A" requests can't both pass the membership check and create an invalid
// three-bed (or two-top) group. The rule can't be a unique index and partial
// indexes are out of scope (#1675), so a row lock on the owning room is the
// serialisation point. Callers run this inside a transaction (self-wrapped when
// no client is supplied).
async function lockRoomForBunkGroup(roomId: string, db: BedAllocationDb) {
  // `$executeRaw`, and the identifier quoted, both for the same reason (#2289):
  // the statement exists ONLY for its lock, so saying so in the call makes it
  // impossible to mistake for a read whose shape somebody might later trust.
  // `id` worked unquoted only because the column happens to be lowercase; every
  // other raw statement in this repository quotes, and an unquoted identifier
  // silently folds case the day a column is not.
  await db.$executeRaw`SELECT 1 FROM "LodgeRoom" WHERE "id" = ${roomId} FOR UPDATE`;
}

async function assertBunkGroupCanAdmit(input: {
  roomId: string;
  bunkGroup: string;
  bedType: BedType;
  // The bed being updated is excluded so re-saving it never conflicts with
  // itself.
  excludeBedId?: string;
  db: BedAllocationDb;
}) {
  const others = await input.db.lodgeBed.findMany({
    where: {
      roomId: input.roomId,
      bunkGroup: input.bunkGroup,
      ...(input.excludeBedId ? { id: { not: input.excludeBedId } } : {}),
    },
    // name/active drive the deactivated-blocker steer: an inactive bed still
    // counts toward the group (membership semantics unchanged), so when it is
    // the reason a save is rejected the message names it and tells the admin to
    // reactivate or delete it — otherwise the slot looks mysteriously taken.
    select: { id: true, bedType: true, name: true, active: true },
  });

  if (others.length >= 2) {
    const deactivated = others.filter((bed) => bed.active === false);
    if (deactivated.length > 0) {
      // Reactivating or deleting a deactivated member only makes room for the
      // incoming bed when that member shares its type — it holds the very slot
      // the new bed wants. A deactivated opposite-type member can't be acted on
      // to admit a same-type bed, so name it but steer only to another group.
      const sameType = deactivated.filter(
        (bed) => bed.bedType === input.bedType,
      );
      if (sameType.length > 0) {
        const plural = sameType.length > 1;
        throw new BedAllocationAdminError(
          `Bunk group "${input.bunkGroup}" already has two beds, including the deactivated bed${
            plural ? "s" : ""
          } ${quotedBedNames(sameType.map((bed) => bed.name))}. Reactivate or delete ${
            plural ? "them" : "it"
          }, or use another group.`,
          409,
        );
      }
      const plural = deactivated.length > 1;
      throw new BedAllocationAdminError(
        `Bunk group "${input.bunkGroup}" already has two beds, including the deactivated bed${
          plural ? "s" : ""
        } ${quotedBedNames(deactivated.map((bed) => bed.name))}. Use another group.`,
        409,
      );
    }
    throw new BedAllocationAdminError(
      `Bunk group "${input.bunkGroup}" already has two beds. A bunk pairs one top and one bottom.`,
      409,
    );
  }

  const partner = others[0];
  if (partner && partner.bedType === input.bedType) {
    if (partner.active === false) {
      throw new BedAllocationAdminError(
        `Bunk group "${input.bunkGroup}" already has a ${bedTypeLabel(
          input.bedType,
        )} bed — the deactivated bed "${partner.name}". Reactivate or delete it, or use another group.`,
        409,
      );
    }
    throw new BedAllocationAdminError(
      `Bunk group "${input.bunkGroup}" already has a ${bedTypeLabel(
        input.bedType,
      )} bed. Pair a top with a bottom.`,
      409,
    );
  }
}

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
    return updateBedAllocationBedWithLocksHeld({ ...input, db: tx });
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
}): Promise<LodgeBed> {
  const touchesBunk =
    input.bedType !== undefined || input.bunkGroup !== undefined;

  const db = input.db;
  if (input.active === false) {
    await assertNoFutureBedAllocations({
      bedId: input.id,
      db,
      action: "deactivate",
    });
    // #2286: deactivating a bed removes it from the bookable pool, which would
    // silently strand a custodian who is meant to be sleeping in it.
    await assertNoCustodianHoldsForBed({
      bedId: input.id,
      db,
      action: "deactivate",
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

async function assertNoFutureBedAllocations(input: {
  bedId: string;
  db: BedAllocationDb;
  action: "deactivate" | "delete";
}) {
  const blockingAllocations = await input.db.bedAllocation.findMany({
    where: {
      bedId: input.bedId,
      stayDate: { gte: getTodayDateOnly() },
    },
    select: { stayDate: true },
    orderBy: { stayDate: "asc" },
  });

  if (blockingAllocations.length === 0) {
    return;
  }

  const blockingDates = [
    ...new Set(
      blockingAllocations.map((allocation) =>
        formatDateOnly(allocation.stayDate),
      ),
    ),
  ];

  throw new BedAllocationAdminError(
    `Cannot ${input.action} this bed while future allocations exist on ${blockingDates.join(", ")}. Clear those dates on the bed allocation page first.`,
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
async function assertNoCustodianHoldsForBed(input: {
  bedId: string;
  db: BedAllocationDb;
  action: "deactivate" | "delete";
}) {
  const holds =
    input.action === "delete"
      ? await findAnyCustodianHoldsForBeds({
          bedIds: [input.bedId],
          db: input.db,
        })
      : await findFutureCustodianHoldsForBed({
          bedId: input.bedId,
          today: getTodayDateOnly(),
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

function memberName(member: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}) {
  const name = [member.firstName, member.lastName].filter(Boolean).join(" ");
  return name || member.email || "Unknown member";
}

function guestName(guest: { firstName: string; lastName: string }) {
  return [guest.firstName, guest.lastName].filter(Boolean).join(" ");
}

function overlapsDateRange(
  stayStart: Date,
  stayEnd: Date,
  range: BedAllocationDateRange,
) {
  return stayStart < range.to && stayEnd > range.from;
}

function clampGuestToRange(
  guest: { stayStart: Date; stayEnd: Date },
  range: { from: Date; to: Date },
) {
  return {
    stayStart: guest.stayStart > range.from ? guest.stayStart : range.from,
    stayEnd: guest.stayEnd < range.to ? guest.stayEnd : range.to,
  };
}

async function loadBookingRecords(
  range: BedAllocationDateRange,
  db: BedAllocationDb,
  lodgeId?: string,
) {
  return db.booking.findMany({
    where: {
      deletedAt: null,
      status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
      checkIn: { lt: range.to },
      checkOut: { gt: range.from },
      // DELIBERATELY NOT consent-filtered, unlike the guest select below (owner
      // decision D-12, #2307). This `some` decides which bookings the BOARD
      // shows; the guest select decides who is placeable. An officer still needs
      // to see a booking that overlaps their window — its held nights, its
      // whole-lodge-hold flag, its existing allocations — even if every guest
      // currently on it is awaiting consent. What they must not get is an
      // unconsented guest in the awaiting-allocation queue, and that comes from
      // the filtered select.
      guests: {
        some: {
          stayStart: { lt: range.to },
          stayEnd: { gt: range.from },
        },
      },
      // Null-tolerant: bookings still missing a lodgeId (expand-release
      // tolerance) show on every lodge's board.
      ...(lodgeId ? lodgeNullTolerantScope(lodgeId) : {}),
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      requestedRoomId: true,
      parentBookingId: true,
      // Whether this booking is the converted booking of a BookingRequest — an
      // accepted-but-unpaid quote / approved request holds capacity even while
      // PENDING (#1254), which the Held/Provisional badge must reflect. The
      // request `type` marks SCHOOL groups for the planner's adults-together /
      // students-separate grouping (#1768) — including the pre-approval held
      // booking of a SCHOOL request (#1280).
      originBookingRequest: { select: { id: true, type: true } },
      heldForBookingRequest: { select: { type: true } },
      // Admin capacity hold (#1764): held PAYMENT_PENDING shows as Held too.
      adminCapacityHoldAt: true,
      // Exclusive whole-lodge hold (ADR-001, issues #119/#120): a held booking
      // implicitly occupies the whole lodge, so it is short-circuited out of
      // per-bed allocation, and overlapping bookings are flagged.
      wholeLodgeHold: true,
      requestedRoom: {
        select: {
          id: true,
          name: true,
          active: true,
        },
      },
      member: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      guests: {
        where: {
          stayStart: { lt: range.to },
          stayEnd: { gt: range.from },
          // Owner decision D-12 (#2307): the board's guest list is what feeds
          // `buildGuestNightRows`, and from there the awaiting-allocation queue
          // and the planner's candidate set. A member guest whose consent is
          // still PENDING holds a bed under D-4 but is not somebody an officer
          // should be placing, so they never enter the queue. Occupancy on the
          // board is unaffected: `loadAllocationRecords` reads the BedAllocation
          // rows independently and names their guests from the allocation row.
          ...OPERATIONALLY_PRESENT_GUEST_WHERE,
        },
        select: {
          id: true,
          bookingId: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          stayStart: true,
          stayEnd: true,
          nights: {
            where: { stayDate: { gte: range.from, lt: range.to } },
            select: { stayDate: true },
            orderBy: { stayDate: "asc" },
          },
          member: {
            select: {
              familyGroupMemberships: {
                select: { familyGroupId: true },
                orderBy: { familyGroupId: "asc" },
              },
            },
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

async function loadAllocationRecords(
  range: BedAllocationDateRange,
  db: BedAllocationDb,
  lodgeId?: string,
) {
  return db.bedAllocation.findMany({
    where: {
      stayDate: {
        gte: range.from,
        lt: range.to,
      },
      // Allocations follow their bed's room; rooms without a lodgeId
      // (expand-release tolerance) show on every lodge's board.
      ...(lodgeId ? { room: lodgeNullTolerantScope(lodgeId) } : {}),
    },
    include: {
      booking: {
        select: {
          status: true,
          // Accepted-but-unpaid quote holds capacity while PENDING (#1254).
          originBookingRequest: { select: { id: true } },
          // Admin capacity hold (#1764): held PAYMENT_PENDING shows as Held.
          adminCapacityHoldAt: true,
        },
      },
      bookingGuest: {
        select: {
          id: true,
          bookingId: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          member: {
            select: {
              familyGroupMemberships: {
                select: { familyGroupId: true },
                orderBy: { familyGroupId: "asc" },
              },
            },
          },
        },
      },
      room: {
        select: {
          id: true,
          name: true,
        },
      },
      bed: {
        select: {
          id: true,
          name: true,
        },
      },
      approvedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
    orderBy: [
      { stayDate: "asc" },
      { room: { sortOrder: "asc" } },
      { bed: { sortOrder: "asc" } },
      { id: "asc" },
    ],
  });
}

function serializeRooms(rooms: Awaited<ReturnType<typeof listBedAllocationRooms>>) {
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

// The overlapping exclusive-hold spans, precomputed once per dashboard build so
// each booking's overlap flag (issue #119) is a cheap in-memory check.
interface HeldSpan {
  id: string;
  checkIn: Date;
  checkOut: Date;
  lodgeId: string | null;
}

function serializeBookings(
  bookings: DashboardBookingRecord[],
  heldSpans: HeldSpan[],
): DashboardBooking[] {
  return bookings.map((booking) => ({
    id: booking.id,
    status: booking.status,
    holdsCapacity: bookingHoldsCapacity({
      status: booking.status,
      isRequestConverted: Boolean(booking.originBookingRequest),
      hasAdminCapacityHold: Boolean(booking.adminCapacityHoldAt),
    }),
    createdAt: booking.createdAt.toISOString(),
    checkIn: formatDateOnly(booking.checkIn),
    checkOut: formatDateOnly(booking.checkOut),
    memberName: memberName(booking.member),
    guests: booking.guests.map((guest) => ({
      id: guest.id,
      bookingId: guest.bookingId,
      name: guestName(guest),
      ageTier: guest.ageTier,
      stayStart: formatDateOnly(guest.stayStart),
      stayEnd: formatDateOnly(guest.stayEnd),
    })),
    requestedRoom: booking.requestedRoom,
    parentBookingId: booking.parentBookingId,
    wholeLodgeHold: Boolean(booking.wholeLodgeHold),
    // A held booking never flags itself; an ordinary booking flags when it
    // overlaps ANY held booking's nights at the same lodge (issue #119).
    overlapsExclusiveHold:
      !booking.wholeLodgeHold &&
      heldSpans.some(
        (held) =>
          held.id !== booking.id &&
          sameLodgeNullTolerant(held.lodgeId, booking.lodgeId) &&
          bookingsOverlap(held, booking),
      ),
  }));
}

function serializeAllocations(
  allocations: DashboardAllocationRecord[],
): DashboardAllocation[] {
  return allocations.map((allocation) => ({
    id: allocation.id,
    bookingId: allocation.bookingId,
    bookingGuestId: allocation.bookingGuestId,
    guestName: guestName(allocation.bookingGuest),
    guestAgeTier: allocation.bookingGuest.ageTier,
    roomId: allocation.roomId,
    roomName: allocation.room.name,
    bedId: allocation.bedId,
    bedName: allocation.bed.name,
    stayDate: formatDateOnly(allocation.stayDate),
    source: allocation.source,
    approvedAt: allocation.approvedAt?.toISOString() ?? null,
    approvedByName: allocation.approvedBy
      ? memberName(allocation.approvedBy)
      : null,
    bookingStatus: allocation.booking.status,
    holdsCapacity: bookingHoldsCapacity({
      status: allocation.booking.status,
      isRequestConverted: Boolean(allocation.booking.originBookingRequest),
      hasAdminCapacityHold: Boolean(allocation.booking.adminCapacityHoldAt),
    }),
    isSecondOccupant: allocation.isSecondOccupant,
    familyGroupIds:
      allocation.bookingGuest.member?.familyGroupMemberships.map(
        (membership) => membership.familyGroupId,
      ) ?? [],
  }));
}

function buildGuestNightRows(
  bookings: DashboardBookingRecord[],
): DashboardGuestNight[] {
  const rows: DashboardGuestNight[] = [];

  for (const booking of bookings) {
    const bookingMemberName = memberName(booking.member);

    for (const guest of booking.guests) {
      for (const night of guest.nights) {
        rows.push({
          bookingId: booking.id,
          bookingGuestId: guest.id,
          guestName: guestName(guest),
          guestAgeTier: guest.ageTier,
          memberName: bookingMemberName,
          stayDate: formatDateOnly(night.stayDate),
          familyGroupIds:
            guest.member?.familyGroupMemberships.map(
              (membership) => membership.familyGroupId,
            ) ?? [],
        });
      }
    }
  }

  return rows;
}

function guestNightKey(bookingGuestId: string, stayDate: string) {
  return `${bookingGuestId}:${stayDate}`;
}

function candidateGuestBookings(
  bookings: DashboardBookingRecord[],
  guestNights: DashboardGuestNight[],
): BedAllocationBooking[] {
  const bookingById = new Map(bookings.map((booking) => [booking.id, booking]));
  const guestsByBooking = new Map<string, BedAllocationBooking["guests"]>();

  for (const guestNight of guestNights) {
    const booking = bookingById.get(guestNight.bookingId);
    if (!booking) continue;

    const stayStart = parseDateOnly(guestNight.stayDate);
    const stayEnd = addDaysDateOnly(stayStart, 1);
    const guests = guestsByBooking.get(booking.id) ?? [];

    guests.push({
      id: guestNight.bookingGuestId,
      bookingId: booking.id,
      ageTier: guestNight.guestAgeTier,
      stayStart,
      stayEnd,
      nights: [guestNight.stayDate],
      familyGroupIds: guestNight.familyGroupIds,
    });
    guestsByBooking.set(booking.id, guests);
  }

  return [...guestsByBooking.entries()]
    .map(([bookingId, guests]): BedAllocationBooking | null => {
      const booking = bookingById.get(bookingId);
      if (!booking) return null;
      return {
        id: booking.id,
        createdAt: booking.createdAt,
        lodgeId: booking.lodgeId,
        requestedRoomId: booking.requestedRoomId,
        // SCHOOL request bookings (#1768): adults room together, students
        // separately — covers both the converted booking and a SCHOOL
        // request's pre-approval held booking.
        isSchoolGroup:
          booking.originBookingRequest?.type === "SCHOOL" ||
          booking.heldForBookingRequest?.type === "SCHOOL",
        guests,
      };
    })
    .filter((booking): booking is BedAllocationBooking => Boolean(booking));
}

function buildPlannerRooms(rooms: Awaited<ReturnType<typeof listBedAllocationRooms>>) {
  return rooms.map((room) => ({
    id: room.id,
    name: room.name,
    sortOrder: room.sortOrder,
    active: room.active,
    lodgeId: room.lodgeId,
    beds: room.beds.map((bed) => ({
      id: bed.id,
      roomId: bed.roomId,
      name: bed.name,
      sortOrder: bed.sortOrder,
      active: bed.active,
    })),
  })) satisfies BedAllocationRoom[];
}

// test seam
export function buildBedAllocationWarnings(input: {
  allocations: DashboardAllocation[];
  // #2286: optional so every existing caller/test keeps working; absent means
  // "no custodian holds loaded", which emits no CUSTODIAN_BED_CONFLICT.
  custodianHolds?: DashboardCustodianHold[];
}): AdminBedAllocationWarning[] {
  const warnings: AdminBedAllocationWarning[] = [];
  const allocationsByBookingNight = new Map<string, DashboardAllocation[]>();

  for (const allocation of input.allocations) {
    const key = `${allocation.bookingId}:${allocation.stayDate}`;
    const group = allocationsByBookingNight.get(key) ?? [];
    group.push(allocation);
    allocationsByBookingNight.set(key, group);
  }

  for (const group of allocationsByBookingNight.values()) {
    const first = group[0];
    const roomIds = new Set(group.map((allocation) => allocation.roomId));

    if (roomIds.size > 1) {
      warnings.push({
        id: `BOOKING_SPLIT:${first.bookingId}:${first.stayDate}`,
        type: "BOOKING_SPLIT",
        severity: "warning",
        bookingId: first.bookingId,
        stayDate: first.stayDate,
        message: `Booking ${first.bookingId} is split across ${roomIds.size} rooms on ${first.stayDate}.`,
      });
    }

    for (const allocation of group) {
      if (allocation.guestAgeTier === "ADULT") continue;

      const hasBookingAdultInRoom = group.some(
        (candidate) =>
          candidate.roomId === allocation.roomId &&
          candidate.guestAgeTier === "ADULT",
      );

      if (!hasBookingAdultInRoom) {
        warnings.push({
          id: `MINOR_WITHOUT_BOOKING_ADULT:${allocation.bookingGuestId}:${allocation.stayDate}`,
          type: "MINOR_WITHOUT_BOOKING_ADULT",
          severity: "warning",
          bookingId: allocation.bookingId,
          bookingGuestId: allocation.bookingGuestId,
          stayDate: allocation.stayDate,
          roomId: allocation.roomId,
          message: `${allocation.guestName} is allocated without a booking adult in ${allocation.roomName} on ${allocation.stayDate}.`,
        });
      }
    }
  }

  // Cross-booking age mix (#1768): one booking's minors sharing a room-night
  // with another booking's adults violates the placement invariant the
  // planner enforces — persisted rows can only get here via manual moves or
  // pre-#1768 auto-allocation, so surface them for the admin to untangle.
  const allocationsByRoomNight = new Map<string, DashboardAllocation[]>();
  for (const allocation of input.allocations) {
    const key = `${allocation.roomId}:${allocation.stayDate}`;
    const group = allocationsByRoomNight.get(key) ?? [];
    group.push(allocation);
    allocationsByRoomNight.set(key, group);
  }
  for (const group of allocationsByRoomNight.values()) {
    const minorBookingIds = [
      ...new Set(
        group
          .filter((allocation) => allocation.guestAgeTier !== "ADULT")
          .map((allocation) => allocation.bookingId),
      ),
    ].sort();
    if (minorBookingIds.length === 0) continue;
    const adultBookingIds = new Set(
      group
        .filter((allocation) => allocation.guestAgeTier === "ADULT")
        .map((allocation) => allocation.bookingId),
    );
    const mixedMinorBookingId = minorBookingIds.find((minorBookingId) =>
      [...adultBookingIds].some((adultId) => adultId !== minorBookingId),
    );
    if (!mixedMinorBookingId) continue;
    const first = group[0];
    warnings.push({
      id: `MINOR_ADULT_MIX:${first.roomId}:${first.stayDate}`,
      type: "MINOR_ADULT_MIX",
      severity: "warning",
      bookingId: mixedMinorBookingId,
      stayDate: first.stayDate,
      roomId: first.roomId,
      message: `${first.roomName} on ${first.stayDate} mixes minors with adults from a different booking.`,
    });
  }

  // Stay-level room continuity (issue #1677): warn when a booking's set of
  // rooms changes between nights — someone has to move rooms mid-stay. This is
  // distinct from BOOKING_SPLIT, which flags a party split across rooms on ONE
  // night; a booking split identically every night raises no ROOM_SWITCH.
  const nightRoomsByBooking = new Map<string, Map<string, Set<string>>>();
  for (const allocation of input.allocations) {
    let nights = nightRoomsByBooking.get(allocation.bookingId);
    if (!nights) {
      nights = new Map();
      nightRoomsByBooking.set(allocation.bookingId, nights);
    }
    let roomIds = nights.get(allocation.stayDate);
    if (!roomIds) {
      roomIds = new Set();
      nights.set(allocation.stayDate, roomIds);
    }
    roomIds.add(allocation.roomId);
  }
  for (const [bookingId, nights] of nightRoomsByBooking) {
    const sortedNights = [...nights.keys()].sort();
    if (sortedNights.length < 2) continue;
    const roomKeyForNight = (night: string) =>
      [...(nights.get(night) ?? [])].sort().join(",");
    const firstKey = roomKeyForNight(sortedNights[0]);
    const switchNight = sortedNights.find(
      (night) => roomKeyForNight(night) !== firstKey,
    );
    if (!switchNight) continue;
    const roomCount = new Set(
      sortedNights.flatMap((night) => [...(nights.get(night) ?? [])]),
    ).size;
    warnings.push({
      id: `ROOM_SWITCH:${bookingId}`,
      type: "ROOM_SWITCH",
      severity: "warning",
      bookingId,
      stayDate: switchNight,
      message: `Booking ${bookingId} changes rooms mid-stay (from ${switchNight}; ${roomCount} rooms across ${sortedNights.length} nights).`,
    });
  }

  // Custodian bed conflict (#2286): an allocation row on a bed-night a
  // custodian holds. Unreachable through the guarded app paths, so each one is
  // evidence of direct SQL, a pre-feature row, or a deploy-drain write — all of
  // which an admin should see and clear rather than have silently overlaid.
  const custodianHeldBedNights = new Map<string, DashboardCustodianHold>();
  for (const hold of input.custodianHolds ?? []) {
    for (const night of hold.nights) {
      custodianHeldBedNights.set(`${hold.bedId}:${night}`, hold);
    }
  }
  if (custodianHeldBedNights.size > 0) {
    for (const allocation of input.allocations) {
      const hold = custodianHeldBedNights.get(
        `${allocation.bedId}:${allocation.stayDate}`,
      );
      if (!hold) continue;
      warnings.push({
        id: `CUSTODIAN_BED_CONFLICT:${allocation.bedId}:${allocation.stayDate}`,
        type: "CUSTODIAN_BED_CONFLICT",
        severity: "warning",
        bookingId: allocation.bookingId,
        bookingGuestId: allocation.bookingGuestId,
        stayDate: allocation.stayDate,
        roomId: allocation.roomId,
        message: `${allocation.guestName} is allocated to ${hold.bedName} on ${allocation.stayDate}, which is held by ${hold.memberName}'s hut-leader assignment. Remove the allocation or change that assignment.`,
      });
    }
  }

  return warnings;
}

export async function getBedAllocationDashboard(input: {
  range: BedAllocationDateRange;
  // Scope the whole board — rooms, bookings, allocations, and therefore the
  // first-fit suggestions — to one lodge (ADR-003). Omitted = club-wide,
  // preserving single-lodge behaviour.
  lodgeId?: string;
  // Deep-linked focused booking (?bookingId=…). When set and out of range, the
  // response carries its stay window so the board can snap onto it (#1302).
  bookingId?: string | null;
  db?: BedAllocationDb;
}): Promise<BedAllocationDashboardPayload> {
  const db = input.db ?? prisma;
  const [settings, rooms, bookings, allocationRecords] = await Promise.all([
    getEffectiveBedAllocationSettings(db, input.lodgeId),
    listBedAllocationRooms(db, input.lodgeId),
    loadBookingRecords(input.range, db, input.lodgeId),
    loadAllocationRecords(input.range, db, input.lodgeId),
  ]);
  const serializedAllocations = serializeAllocations(allocationRecords);

  // Exclusive whole-lodge holds (ADR-001, issues #119/#120). A held booking
  // implicitly occupies every bed, so it is short-circuited OUT of per-bed
  // allocation: its guest-nights are excluded from the awaiting-allocation set
  // and never fed to the planner (so it can never appear as an allocation gap /
  // stuck state). It is represented distinctly on the board instead, and its
  // span flags overlapping ordinary bookings (#119).
  const heldSpans: HeldSpan[] = bookings
    .filter((booking) => booking.wholeLodgeHold)
    .map((booking) => ({
      id: booking.id,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      lodgeId: booking.lodgeId,
    }));
  const heldBookingIds = new Set(heldSpans.map((held) => held.id));

  const allGuestNights = buildGuestNightRows(bookings);
  const allocatedGuestNights = new Set(
    serializedAllocations.map((allocation) =>
      guestNightKey(allocation.bookingGuestId, allocation.stayDate),
    ),
  );
  const unallocatedGuestNights = allGuestNights.filter(
    (guestNight) =>
      // A held booking needs no per-bed placement (#120): keep its guests out
      // of the awaiting-allocation bucket AND out of the planner entirely.
      !heldBookingIds.has(guestNight.bookingId) &&
      !allocatedGuestNights.has(
        guestNightKey(guestNight.bookingGuestId, guestNight.stayDate),
      ),
  );

  // Board representation for each hold (#120): the group + the held nights that
  // fall inside the current range, so staff understand the lodge is taken.
  const exclusiveHolds: DashboardExclusiveHold[] = bookings
    .filter((booking) => booking.wholeLodgeHold)
    .map((booking) => {
      const clamped = clampGuestToRange(
        { stayStart: booking.checkIn, stayEnd: booking.checkOut },
        input.range,
      );
      return {
        bookingId: booking.id,
        memberName: memberName(booking.member),
        checkIn: formatDateOnly(booking.checkIn),
        checkOut: formatDateOnly(booking.checkOut),
        guestCount: booking.guests.length,
        nights: eachDateOnlyInRange(clamped.stayStart, clamped.stayEnd).map(
          formatDateOnly,
        ),
      };
    });
  // Custodian bed holds (#2286): loaded for the board's range and fed to the
  // planner as #1768 "unknown occupant" rows — blocking, never evictable, and
  // conservative for room mix — so no suggestion can ever target a held
  // bed-night. `toExclusive` is the day AFTER the board's inclusive last night.
  // The board's range is HALF-OPEN — `toDate` is the date-out column, not the
  // last night (parseBedAllocationDateRange derives its night count with
  // eachDateOnlyInRange(from, to)). The custodian API takes the same shape, so
  // `to` passes straight through as the exclusive end; adding a day here would
  // hold a bed on a night the board never renders.
  const rangeNights = eachDateOnlyInRange(input.range.from, input.range.to);
  // Blocking whole-lodge holds (#2317): loaded on the SAME half-open window as
  // the custodian holds, and for the same reason — a hold takes every bed of
  // its lodge for its nights but owns no `BedAllocation` row anywhere, so it is
  // invisible to `serializedAllocations` above. Its own query, not a filter
  // over `bookings`: a hold blocks whether or not its guest rows have been
  // entered yet, and the board's booking load demands an overlapping guest.
  const [custodianBedHolds, blockingWholeLodgeHolds] = await Promise.all([
    findCustodianBedHolds({
      lodgeId: input.lodgeId,
      from: input.range.from,
      toExclusive: input.range.to,
      db,
    }),
    findBlockingWholeLodgeHolds({
      lodgeId: input.lodgeId,
      from: input.range.from,
      toExclusive: input.range.to,
      db,
    }),
  ]);
  const custodianHolds: DashboardCustodianHold[] = custodianBedHolds.map(
    (hold) => ({
      assignmentId: hold.assignmentId,
      memberName: hold.memberName,
      bedId: hold.bedId,
      bedName: hold.bedName,
      roomId: hold.roomId,
      roomName: hold.roomName,
      startDate: hold.startDate,
      endDate: hold.endDate,
      nights: rangeNights
        .map(formatDateOnly)
        .filter((night) => hold.startDate <= night && night <= hold.endDate),
    }),
  );

  const plannerRooms = buildPlannerRooms(rooms);
  const plannerBookings = candidateGuestBookings(bookings, unallocatedGuestNights);
  const plan = settings.autoAllocationEnabled
    ? buildFirstFitBedAllocationPlan({
        enabled: true,
        allocationPriorityOrder: settings.allocationPriorityOrder,
        rooms: plannerRooms,
        bookings: plannerBookings,
        occupiedBedNights: [
          ...serializedAllocations.map((allocation) => ({
            bedId: allocation.bedId,
            bookingId: allocation.bookingId,
            bookingGuestId: allocation.bookingGuestId,
            roomId: allocation.roomId,
            stayDate: allocation.stayDate,
            ageTier: allocation.guestAgeTier,
            familyGroupIds: allocation.familyGroupIds ?? [],
          })),
          ...custodianOccupiedBedNightsForPlanner(
            custodianBedHolds,
            rangeNights,
          ),
          // Exclusive whole-lodge holds (#2317, owner decision option (a)):
          // every active bed of the held lodge, on every held night, as
          // unattributed (null booking / null guest) non-displaceable
          // occupancy. The held group's own guests are already excluded from
          // `plannerBookings` (the #120/#2285 short-circuit above), so this
          // only ever stops ANOTHER booking's guests being auto-placed onto
          // beds the held group is physically using — the clash surfaces as
          // NO_BED_AVAILABLE in the awaiting-allocation list instead.
          ...wholeLodgeHoldOccupiedBedNightsForPlanner(
            blockingWholeLodgeHolds,
            rooms,
            rangeNights,
          ),
        ],
      })
    : { allocations: [], unallocatedGuestNights: [] };

  // Resolve a deep-linked focused booking that falls outside the current range
  // (#1302). It is absent from `bookings` (range-filtered), so the client cannot
  // snap onto it without its stay window. Look it up only when it is not already
  // in range, and only if it is an allocatable, non-deleted booking.
  let focusedBooking: BedAllocationDashboardPayload["focusedBooking"] = null;
  if (input.bookingId && !bookings.some((booking) => booking.id === input.bookingId)) {
    const found = await db.booking.findFirst({
      where: {
        id: input.bookingId,
        deletedAt: null,
        status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
      },
      select: { id: true, checkIn: true, checkOut: true },
    });
    if (found) {
      focusedBooking = {
        id: found.id,
        checkIn: formatDateOnly(found.checkIn),
        checkOut: formatDateOnly(found.checkOut),
      };
    }
  }

  return {
    settings,
    range: {
      fromDate: input.range.fromDate,
      toDate: input.range.toDate,
    },
    rooms: serializeRooms(rooms),
    bookings: serializeBookings(bookings, heldSpans),
    allocations: serializedAllocations,
    unallocatedGuestNights,
    exclusiveHolds,
    custodianHolds,
    suggestedAllocations: plan.allocations,
    suggestedUnallocatedGuestNights: plan.unallocatedGuestNights,
    warnings: buildBedAllocationWarnings({
      allocations: serializedAllocations,
      custodianHolds,
    }),
    focusedBooking,
  };
}

/**
 * Count the distinct guests with at least one bed-night still awaiting
 * allocation inside a bounded window — the "work to do" headline for the admin
 * dashboard's Bed Allocation officer card (#2091). This is a window-scoped
 * mirror of `getBedAllocationDashboard`'s `unallocatedGuestNights` construction
 * (the board's own awaiting-allocation set), kept cheap by the bounded window
 * (the dashboard passes today..+7, the board's own landing window):
 *   - loads only BED_ALLOCATABLE_BOOKING_STATUSES bookings with ≥1 guest
 *     overlapping the window (`loadBookingRecords`'s guest-existence rule), and
 *   - excludes whole-lodge holds up front (a held lodge implicitly occupies
 *     every bed and needs no per-bed placement — ADR-001/#120 — so the board
 *     drops its guests from the awaiting-allocation set entirely), then
 *   - treats a guest-night as awaiting when no BedAllocation row exists for that
 *     (guest, night), counting each guest ONCE if any of their window nights is
 *     unallocated (the board renders one bucket card per such guest).
 *
 * Because the diff is at guest-night granularity, a booking with guest A placed
 * and guest B pending still contributes B here — exactly the guest the board
 * lists in its bucket — instead of the whole booking dropping out the moment one
 * guest is allocated. Club-wide (no lodge scope) for the dashboard.
 */
export async function countGuestsAwaitingBed(input: {
  from: Date;
  to: Date;
  lodgeId?: string;
  db?: BedAllocationDb;
}): Promise<number> {
  const db = input.db ?? prisma;
  const { from, to } = input;

  const [bookings, allocations] = await Promise.all([
    db.booking.findMany({
      where: {
        deletedAt: null,
        status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
        wholeLodgeHold: false,
        checkIn: { lt: to },
        checkOut: { gt: from },
        // Left broad for the same reason as `loadBookingRecords`' `some` above
        // (D-12, #2307): this mirrors the board's booking-existence rule, and the
        // exclusion that matters is on the guest select below. A booking whose
        // only overlapping guests are unconsented loads here and contributes
        // nobody, which is the right answer either way.
        guests: {
          some: {
            stayStart: { lt: to },
            stayEnd: { gt: from },
          },
        },
        ...(input.lodgeId ? lodgeNullTolerantScope(input.lodgeId) : {}),
      },
      select: {
        id: true,
        guests: {
          where: {
            stayStart: { lt: to },
            stayEnd: { gt: from },
            // D-12 (#2307): this counter is a window-scoped mirror of the
            // board's own awaiting-allocation construction, so it has to apply
            // the same exclusion — otherwise the officer card advertises work
            // the board itself does not list.
            ...OPERATIONALLY_PRESENT_GUEST_WHERE,
          },
          select: {
            id: true,
            stayStart: true,
            stayEnd: true,
          },
        },
      },
    }),
    db.bedAllocation.findMany({
      where: {
        stayDate: { gte: from, lt: to },
        ...(input.lodgeId ? { room: lodgeNullTolerantScope(input.lodgeId) } : {}),
      },
      select: {
        bookingGuestId: true,
        stayDate: true,
      },
    }),
  ]);

  const allocatedGuestNights = new Set(
    allocations.map((allocation) =>
      guestNightKey(allocation.bookingGuestId, formatDateOnly(allocation.stayDate)),
    ),
  );

  const awaitingGuestIds = new Set<string>();
  for (const booking of bookings) {
    for (const guest of booking.guests) {
      const clamped = clampGuestToRange(guest, { from, to });
      for (const date of eachDateOnlyInRange(clamped.stayStart, clamped.stayEnd)) {
        if (!allocatedGuestNights.has(guestNightKey(guest.id, formatDateOnly(date)))) {
          awaitingGuestIds.add(guest.id);
          // One unallocated night makes the guest awaiting; count them once.
          break;
        }
      }
    }
  }

  return awaitingGuestIds.size;
}

export async function runAutoBedAllocation(input: {
  range: BedAllocationDateRange;
  // Auto-allocation follows the board's lodge scope, so a suggestion can
  // never place a guest into another lodge's bed.
  lodgeId: string;
}) {
  const db = prisma;
  const dashboard = await getBedAllocationDashboard({
    range: input.range,
    lodgeId: input.lodgeId,
    db,
  });

  if (!dashboard.settings.autoAllocationEnabled) {
    throw new BedAllocationAdminError(
      "Auto allocation is disabled; use manual allocation.",
      409,
    );
  }

  if (dashboard.suggestedAllocations.length === 0) {
    return { count: 0 };
  }

  const candidateRows = dashboard.suggestedAllocations.map((allocation) => ({
    bookingId: allocation.bookingId,
    bookingGuestId: allocation.bookingGuestId,
    roomId: allocation.roomId,
    bedId: allocation.bedId,
    stayDate: parseDateOnly(allocation.stayDate),
    source: "AUTO" as const,
  }));

  // Which lodge is each suggestion's room in? A scoped run already knows (the
  // whole board is that lodge); a club-wide run resolves it once, here. This
  // answers two questions with one lookup: which lodges the write must lock,
  // and — for the #2317 whole-lodge-hold re-filter — which lodge's hold could
  // take a given suggestion's bed. Resolved before the transaction opens so the
  // lock stays the transaction's first statement.
  /**
   * The locked write half of the run (#2286).
   *
   * This function used to write with a plain `db.bedAllocation.createMany` and
   * NO transaction and NO lock at all — every check above ran against an
   * unlocked dashboard read. That was survivable while the only concurrent
   * writer was another allocation path guarded by the same unique indexes; a
   * custodian hold is not protected by any index, so the re-filter below has to
   * run under the same per-lodge advisory lock the hold writer takes, inside
   * the same transaction as the write.
   */
  const writeUnderLocks = async (
    tx: BedAllocationDb,
    lodgeIds: string[],
  ): Promise<{ count: number }> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    // Locks FIRST, in sorted order: the auto-allocate route accepts an omitted
    // lodgeId (a club-wide run), so this transaction can span several lodges
    // and must never deadlock against the per-lodge transactions taking the
    // same keys one at a time. Sorted acquisition is the codebase's established
    // multi-lodge pattern (instrumentation.node.ts draft cleanup).
    for (const lodgeId of lodgeIds) {
      await acquireLodgeCapacityLock(tx, lodgeId);
    }

    // Write-time re-check (#2285 review): the dashboard read above is not held
    // under any lock, so an exclusive hold set (or a cancel / soft delete) can
    // commit between the read and this write. Its prune frees the unique keys,
    // so `skipDuplicates` cannot stop us re-inserting rows for a booking that
    // must own none — re-read the payload's bookings and drop those that are no
    // longer allocatable. Shared with the lifecycle planner so both writers
    // agree.
    const { rows, droppedBookingIds } =
      await dropAllocationRowsForUnallocatableBookings(tx, candidateRows);

    if (droppedBookingIds.length > 0) {
      logger.info(
        { droppedBookingIds, lodgeId: input.lodgeId },
        "Run Auto Allocation write-time re-check dropped suggestions for bookings that became unallocatable (held/cancelled/deleted) after planning",
      );
    }
    if (rows.length === 0) {
      return { count: 0 };
    }

    // Custodian re-filter (#2286), defence in depth: the planner was already
    // fed these bed-nights as blocking unknown-occupant rows, but that read was
    // unlocked. Re-read the holds HERE, under the locks, and drop any
    // suggestion that would land on one.
    const stayDates = rows.map((row) => row.stayDate);
    const from = stayDates.reduce((a, b) => (a < b ? a : b));
    const latest = stayDates.reduce((a, b) => (a > b ? a : b));
    const toExclusive = addDaysDateOnly(latest, 1);
    const heldKeys = custodianHeldBedNightKeys(
      await findCustodianBedHolds({
        lodgeId: input.lodgeId,
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
          lodgeId: input.lodgeId,
        },
        "Run Auto Allocation dropped suggestions targeting custodian-held bed-nights",
      );
    }
    if (writableRows.length === 0) {
      return { count: 0 };
    }

    // Whole-lodge-hold re-filter (#2317), the exact mirror of the custodian one
    // above. The planner WAS fed these nights as blocking unattributed
    // occupancy — but from the same unlocked dashboard read, and the
    // unallocatable re-check above cannot cover this: it asks whether the
    // SUGGESTED booking became unallocatable, and a hold set on somebody ELSE's
    // booking leaves the suggested booking perfectly allocatable while taking
    // every bed it was about to be placed on. Re-read the holds HERE, under the
    // locks the hold writer takes, and drop any suggestion landing on a held
    // lodge-night. A row whose lodge cannot be resolved is treated as held by
    // ANY hold (null-tolerant), which is the conservative direction.
    const isWholeLodgeHeld = buildWholeLodgeHeldNightPredicate(
      await findBlockingWholeLodgeHolds({
        lodgeId: input.lodgeId,
        from,
        toExclusive,
        db: tx,
      }),
    );
    const unheldRows = writableRows.filter(
      (row) =>
        !isWholeLodgeHeld(input.lodgeId, formatDateOnly(row.stayDate)),
    );
    if (unheldRows.length < writableRows.length) {
      logger.info(
        {
          droppedCount: writableRows.length - unheldRows.length,
          lodgeId: input.lodgeId,
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

  // A caller-supplied client is already transactional, so run inline on it
  // rather than nesting a transaction (the other self-wrapping helpers here do
  // the same). The locks are still taken on that client — pg advisory locks are
  // re-entrant within a session, so re-acquiring one the caller already holds
  // is a no-op, and acquiring one it does not is exactly what we need.
  return prisma.$transaction((tx) => writeUnderLocks(tx, [input.lodgeId]));
}

async function assertGuestAndBedForAllocation(input: {
  bookingGuestId: string;
  bedId: string;
  db: BedAllocationDb;
  // ADR-001 short-circuit (#120/#2285): a whole-lodge-held booking owns NO
  // per-bed rows. Every manual write path refuses by default; the range path
  // (#2251) passes true so it can report the hold as its own refusal category
  // instead of a bare 409.
  reportWholeLodgeHold?: boolean;
}) {
  const [guest, bed] = await Promise.all([
    input.db.bookingGuest.findUnique({
      where: { id: input.bookingGuestId },
      include: {
        // Explicit night set (#713): a stay can be NON-CONTIGUOUS — 1-5 and
        // 8-10, with nothing on the 6th and 7th. Without this the manual paths
        // saw only stayStart..stayEnd and happily placed a guest on a gap night
        // the lifecycle then pruned again, so the bed looked taken until the
        // next reconcile quietly emptied it. guestIsStayingOn() prefers this set
        // whenever it is non-empty, exactly as the lifecycle's
        // getGuestNightDatesInRange does.
        nights: { select: { stayDate: true } },
        booking: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            lodgeId: true,
            // ADR-001 (#120/#2285): a held booking implicitly occupies every
            // bed, so it must never collect per-bed rows — the lifecycle now
            // prunes any it finds, which would silently undo a manual
            // placement. Refused here at the write chokepoint instead.
            wholeLodgeHold: true,
          },
        },
      },
    }),
    input.db.lodgeBed.findUnique({
      where: { id: input.bedId },
      include: { room: true },
    }),
  ]);

  if (!guest) {
    throw new BedAllocationAdminError("Guest not found", 404);
  }
  if (!bed || bed.active === false || bed.room.active === false) {
    throw new BedAllocationAdminError("Active bed not found", 404);
  }
  if (guest.booking.deletedAt) {
    throw new BedAllocationAdminError("Cannot allocate deleted booking", 409);
  }
  // ADR-001 (#120), write half of #2285: the lifecycle prunes every per-bed row
  // a held booking owns, so a manual placement here would be silently swept on
  // the next reconcile. Refuse it at the write chokepoint. The range path
  // (#2251) opts out of the throw to report it as its own category.
  if (guest.booking.wholeLodgeHold && !input.reportWholeLodgeHold) {
    throw new BedAllocationAdminError(
      "This booking holds the whole lodge for its nights, so it needs no per-bed allocation.",
      409,
    );
  }
  if (
    !BED_ALLOCATABLE_BOOKING_STATUSES.includes(
      guest.booking.status as (typeof BED_ALLOCATABLE_BOOKING_STATUSES)[number],
    )
  ) {
    throw new BedAllocationAdminError(
      "Booking status is not allocatable",
      409,
    );
  }
  // Owner decision D-12 (#2307), the WRITE half. Every read surface filters
  // unconsented member guests out with OPERATIONALLY_PRESENT_GUEST_WHERE, so an
  // officer never sees one in the awaiting-allocation queue — but the manual
  // paths take a bookingGuestId from the request, not from the queue, so a
  // pending guest's id supplied by hand (or left in a stale browser tab) would
  // still write bed rows here. Those rows are exactly what
  // `pruneAllocationsForBooking` sweeps on the next reconcile, so the officer's
  // work would quietly disappear and the bed would look free again.
  //
  // Refused at the write chokepoint for the same reason as the whole-lodge hold
  // above: it is the one place all three manual paths — single night, bulk, and
  // the #2251 range path — pass through. `consentStatus` comes back on the
  // `include` above and is read inside the caller's transaction, so it cannot be
  // a stale pre-transaction snapshot.
  if (!isOperationallyPresentConsent(guest.consentStatus)) {
    throw new BedAllocationAdminError(
      "This guest has not consented to being on this booking, so they cannot be given a bed yet.",
      409,
    );
  }
  // Lodge-scoping contract: a booking's bed allocations must belong to the
  // booking's lodge. Rows still missing a lodgeId (expand-release tolerance)
  // pass on either side.
  if (
    guest.booking.lodgeId &&
    bed.room.lodgeId &&
    guest.booking.lodgeId !== bed.room.lodgeId
  ) {
    throw new BedAllocationAdminError(
      "Bed belongs to a different lodge than the booking",
      409,
    );
  }

  return { guest, bed };
}

/**
 * Whether a guest actually stays on a night.
 *
 * Prefers the EXPLICIT night set when the caller loaded one and it is non-empty
 * (#713 non-contiguous stays), because stayStart..stayEnd is only an envelope:
 * a guest booked 1-5 and 8-10 has that envelope spanning the 6th and 7th, which
 * they are not booked on. Falls back to the envelope when no night rows were
 * selected or the guest has none — the pre-#713 behaviour, and the same rule the
 * lifecycle's getGuestNightDatesInRange applies.
 */
function guestIsStayingOn(
  guest: { stayStart: Date; stayEnd: Date; nights?: { stayDate: Date }[] },
  stayDate: Date,
): boolean {
  if (guest.nights && guest.nights.length > 0) {
    const wanted = formatDateOnly(stayDate);
    return guest.nights.some((night) => formatDateOnly(night.stayDate) === wanted);
  }
  return overlapsDateRange(guest.stayStart, guest.stayEnd, {
    from: stayDate,
    to: addDaysDateOnly(stayDate, 1),
    fromDate: formatDateOnly(stayDate),
    toDate: formatDateOnly(addDaysDateOnly(stayDate, 1)),
  });
}

async function assertManualAllocationInput(input: {
  bookingGuestId: string;
  bedId: string;
  stayDate: Date;
  db: BedAllocationDb;
}) {
  const { guest, bed } = await assertGuestAndBedForAllocation(input);

  if (!guestIsStayingOn(guest, input.stayDate)) {
    throw new BedAllocationAdminError(
      "Guest is not staying on the selected date",
      400,
    );
  }

  return { guest, bed };
}

/**
 * Decide whether allocating `guest` to `bed` on `stayDate` creates a SECOND
 * occupant on a shared DOUBLE bed (#1701), enforcing every sharing rule, or a
 * normal (primary) allocation. Returns the `isSecondOccupant` flag to persist,
 * or throws a BedAllocationAdminError when the bed-night is already taken and
 * sharing is not permitted.
 *
 * Sharing is allowed only when the bed is a DOUBLE that currently holds exactly
 * one PRIMARY occupant (a different guest), AND:
 *   - that occupant's booking holds capacity (a capacity-holding booking is
 *     never wholly-displaceable, so auto-allocation can never move the primary
 *     out from under the partner and pair the second occupant with an unrelated
 *     booking — the #1701 displacement-safety pin);
 *   - both guests are linked to a member; and
 *   - mayShareDoubleBed() says the two members may share (a CONFIRMED partner
 *     link between two adults, #1744 — the single source of truth for the
 *     who-may-share rule).
 *
 * The composite @@unique([bedId, stayDate, isSecondOccupant]) and the non-double
 * partial index are the DB backstop against races and non-double beds.
 */
async function resolveSecondOccupant(input: {
  bed: { id: string; bedType: BedType };
  guest: { id: string; memberId: string | null };
  stayDate: Date;
  db: BedAllocationDb;
}): Promise<{ isSecondOccupant: boolean }> {
  const { bed, guest, stayDate, db } = input;

  const occupants = await db.bedAllocation.findMany({
    where: {
      bedId: bed.id,
      stayDate,
      bookingGuestId: { not: guest.id },
    },
    select: {
      isSecondOccupant: true,
      bookingGuest: {
        select: {
          memberId: true,
          booking: { select: { status: true } },
        },
      },
    },
  });

  // Free bed-night → normal primary allocation.
  if (occupants.length === 0) {
    return { isSecondOccupant: false };
  }

  if (bed.bedType !== "DOUBLE") {
    throw new BedAllocationAdminError(
      "That bed is already allocated for the selected date.",
      409,
    );
  }
  if (occupants.length >= 2 || occupants.some((row) => row.isSecondOccupant)) {
    throw new BedAllocationAdminError(
      "This double bed already has two occupants for the selected date.",
      409,
    );
  }

  const [primary] = occupants;
  if (!isCapacityHoldingBookingStatus(primary.bookingGuest.booking.status)) {
    throw new BedAllocationAdminError(
      "A partner can only be added to a confirmed booking's double bed.",
      409,
    );
  }
  if (!guest.memberId || !primary.bookingGuest.memberId) {
    throw new BedAllocationAdminError(
      "Both guests must be linked to a member to share a double bed.",
      409,
    );
  }
  const eligible = await mayShareDoubleBed(
    primary.bookingGuest.memberId,
    guest.memberId,
    db,
  );
  if (!eligible) {
    throw new BedAllocationAdminError(
      "Only two adults with a confirmed partner relationship may share a double bed.",
      409,
    );
  }

  return { isSecondOccupant: true };
}

// Only a genuine move of a PRIMARY off its bed can strand a partner on the OLD
// bed-night, so promote the surviving second occupant there (#1750). Skips when:
//   - previous == null: a fresh CREATE, no old bed-night to repair;
//   - previous.isSecondOccupant: moving a second occupant leaves the primary in
//     place, so nothing is orphaned;
//   - previous.bedId === newBedId: a same-bed re-upsert can't orphan a partner.
//     If the double is shared, resolveSecondOccupant 409s before the upsert (the
//     partner left on the bed reads as a second occupant → "already has two
//     occupants"), so this code is never reached; if it isn't shared there is no
//     partner to strand. Either way the old bed-night is not vacated.
async function promoteVacatedOldBedNight(input: {
  previous: { bedId: string; isSecondOccupant: boolean } | null;
  newBedId: string;
  stayDate: Date;
  db: BedAllocationDb;
}): Promise<BedAllocation | null> {
  const { previous, newBedId, stayDate, db } = input;
  if (!previous || previous.isSecondOccupant || previous.bedId === newBedId) {
    return null;
  }
  const [promoted] = await promoteOrphanedSecondOccupants(db, [
    { bedId: previous.bedId, stayDate },
  ]);
  return promoted ?? null;
}

// Allocate one guest-night to a bed via upsert, promoting any partner stranded
// on the guest's OLD bed-night by the move (#1750). Reads the pre-move row,
// upserts, then repairs the old bed-night — the caller wraps this in a
// transaction so the three writes are atomic and no transient
// @@unique([bedId, stayDate, isSecondOccupant]) collision can occur (the move
// vacates the old bed-night before the partner is flipped). Throws P2002 on a
// taken bed-night for the caller to classify (409 vs bulk conflict).
async function allocateBedNight(input: {
  guest: { id: string; bookingId: string; memberId: string | null };
  bed: { id: string; roomId: string; bedType: BedType };
  stayDate: Date;
  db: BedAllocationDb;
}): Promise<{ allocation: BedAllocation; promotedPartner: BedAllocation | null }> {
  const { guest, bed, stayDate, db } = input;

  // Custodian occupancy (#2286), THE manual-placement chokepoint. Every manual
  // placement — single night, bulk drop, board move — funnels through this
  // upsert, so one guard call covers all of them. The callers hold the
  // per-lodge advisory lock, so a hold created concurrently either commits
  // before this read (and is seen here) or waits behind the allocation.
  //
  // Thrown as CustodianHoldConflictError, not BedAllocationAdminError: each
  // caller maps it to its own refusal shape (a 409 for the single-night path,
  // a per-night CUSTODIAN_HOLD conflict entry for the bulk path).
  await assertBedNightsFreeOfCustodianHold({
    bedId: bed.id,
    stayDates: [stayDate],
    db,
  });

  const { isSecondOccupant } = await resolveSecondOccupant({
    bed,
    guest,
    stayDate,
    db,
  });

  const previous = await db.bedAllocation.findUnique({
    where: {
      bookingGuestId_stayDate: { bookingGuestId: guest.id, stayDate },
    },
    select: { bedId: true, isSecondOccupant: true },
  });

  const allocation = await db.bedAllocation.upsert({
    where: {
      bookingGuestId_stayDate: { bookingGuestId: guest.id, stayDate },
    },
    create: {
      bookingId: guest.bookingId,
      bookingGuestId: guest.id,
      roomId: bed.roomId,
      bedId: bed.id,
      stayDate,
      source: "MANUAL",
      isSecondOccupant,
      bedType: bed.bedType,
    },
    update: {
      roomId: bed.roomId,
      bedId: bed.id,
      source: "MANUAL",
      approvedAt: null,
      approvedByMemberId: null,
      isSecondOccupant,
      bedType: bed.bedType,
    },
  });

  const promotedPartner = await promoteVacatedOldBedNight({
    previous,
    newBedId: bed.id,
    stayDate,
    db,
  });

  return { allocation, promotedPartner };
}

/**
 * Resolve the lodge a bed belongs to, purely to derive the advisory-lock key
 * (#2286). Read OUTSIDE the transaction so `acquireLodgeCapacityLock` can be
 * the FIRST statement inside it — one xact-scoped lock, always taken first, is
 * what keeps this deadlock-free against every other capacity writer.
 *
 * A missing bed returns null and the caller skips the lock: the authoritative
 * validation inside the transaction answers 404 for it anyway, and locking a
 * lodge we could not identify would buy nothing.
 */
async function resolveBedLodgeIdForLock(
  bedId: string,
  db: BedAllocationDb,
): Promise<string | null> {
  const bed = await db.lodgeBed.findUnique({
    where: { id: bedId },
    select: { room: { select: { lodgeId: true } } },
  });
  return bed?.room.lodgeId ?? null;
}

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
    return await allocateBedNight({ guest, bed, stayDate, db });
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
    const firstAllocation = allocations[0];
    await createAuditLog(
      {
        action: isBulk
          ? "BED_ALLOCATION_BULK_SET"
          : "BED_ALLOCATION_MANUAL_SET",
        memberId: input.actorMemberId,
        targetId: firstAllocation.bookingId,
        entityType: "BedAllocation",
        entityId: isBulk ? undefined : firstAllocation.id,
        category: "admin",
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
          category: "admin",
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
      const { allocation, promotedPartner } = await allocateBedNight({
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

/*
 * Range assignment (#2251)
 * ------------------------
 * "Put this guest in this bed from X to Y" for a stay of ANY length, written
 * all-or-nothing in one transaction with ONE audit entry (owner decision,
 * 26 Jul 2026) — the audit row is written INSIDE that transaction, so rows and
 * record commit or roll back together. There is deliberately NO dry-run/preview
 * endpoint: the assign is attempted, and if any night is blocked NOTHING is
 * written and the refusal itself carries the evidence. The admin's second action
 * sends back the EXPLICIT night list it was shown (`nights`); the server writes
 * exactly that set or refuses it with a fresh report. A partial result is
 * reachable only because a human chose those nights, never as a silent default,
 * and never as a set the server re-derived behind them.
 *
 * The three blocker categories are kept distinct (never merged into "skipped"):
 *   - EXCLUSIVE_HOLD  — the guest's OWN booking holds the whole lodge (ADR-001):
 *                       a held booking owns no per-bed rows at all, so this is
 *                       structural, not a clash, and it blocks the whole range.
 *                       ANOTHER booking's hold is deliberately NOT a blocker
 *                       here: ADR-001's short-circuit is scoped to the held
 *                       booking's own guests, the planner and every other
 *                       allocation path still place ordinary bookings over an
 *                       overlapping hold, and the board surfaces such a hold as
 *                       a banner/`overlapsExclusiveHold` badge rather than a
 *                       refusal. This endpoint must not invent a stricter rule
 *                       than the domain enforces anywhere else (#2251 review).
 *   - GUEST_NOT_BOOKED — a BAD REQUEST, not a conflict: the range or the guest is
 *                       wrong. Never silently skipped, because skipping hides the
 *                       mistake. Includes a GAP night in a non-contiguous stay
 *                       (#713), which the lifecycle would prune again anyway.
 *   - BED_TAKEN       — a genuine clash; the occupying guest is named, and a
 *                       provisional (non-capacity-holding) occupant still counts
 *                       as a conflict so nothing is silently overwritten.
 * One category per night, RESOLVED in that precedence order, so the report is
 * unambiguous. The dialog DISPLAYS them in a different order (most actionable
 * first: BED_TAKEN, GUEST_NOT_BOOKED, EXCLUSIVE_HOLD) — resolution precedence
 * and display order are deliberately independent.
 *
 * Range assignments AUTO-APPROVE (owner decision, 28 Jul 2026): rows land with
 * approvedAt/approvedByMemberId stamped rather than as drafts. That is what
 * makes the FIRST range assign flip isBookingBedAllocationLocked for the
 * booking, locking the member out of editing their requested room (#776) — the
 * dialog says so before the admin commits. Single-night board placements are
 * deliberately NOT auto-approved: draft-vs-approved remains the domain's
 * suggestion-vs-confirmation distinction.
 */

// Independent of MAX_BED_ALLOCATION_RANGE_NIGHTS, which bounds the BOARD's read
// window (parseBedAllocationDateRange) and the board's own bulk drop. Nothing in
// the capacity or locking model bounds an allocation WRITE at 31 nights: lodge
// capacity is `lodgeBed.count({ active: true })` and never reads BedAllocation
// rows (lodge-capacity.ts), no capacity/advisory lock is taken on any allocation
// write path, and the lifecycle auto-allocator already writes a booking's whole
// (unbounded) stay in one createMany. This cap therefore exists only to keep one
// transaction's size finite and its payload reviewable; it is REFUSED at, never
// silently truncated to.
export const MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS = 366;

/**
 * Cap on how many partner promotions the range path's ONE batched
 * `BED_ALLOCATION_PARTNERS_PROMOTED` entry lists verbatim (#2251 residual R4).
 *
 * Pinned, like `MAX_AUDITED_PRUNED_ALLOCATIONS` in `bed-allocation-lifecycle.ts`,
 * to the audit layer's own `MAX_METADATA_ARRAY_ITEMS` (`src/lib/audit.ts`): the
 * sanitiser silently truncates any metadata array past 50 entries and replaces
 * the WHOLE blob with a short preview once the serialised JSON passes its size
 * budget, so listing more would not preserve them and could cost the entries that
 * DO fit. The exact figure is always recorded alongside as `promotedCount`, and
 * `promotionsTruncated` says the list is partial.
 */
export const MAX_AUDITED_RANGE_PARTNER_PROMOTIONS = 50;

/**
 * How many DISTINCT promoted-partner booking ids the batched entry repeats into
 * its searchable `details` string (#2251 residual R4, review follow-up).
 *
 * The admin audit search matches `action, summary, details, requestId, entityId,
 * targetId` and never metadata (`src/lib/audit-admin-query.ts`), and a booking
 * page's audit link is `?q=<bookingId>`. One batched entry has only one
 * `targetId` — the booking whose range assignment caused the promotions — so
 * without this the promoted partner's OWN booking could no longer find the entry
 * that explains why its guest became a primary. 30 × a 25-character cuid plus the
 * prefix stays inside `sanitizeMetadataString`'s 1000-character budget
 * (`src/lib/audit.ts`), so the string is never truncated mid-id; a longer list
 * (many different bookings' partners stranded by one range) states the overflow
 * and leaves the full set in `metadata.promotions`.
 */
const MAX_SEARCHABLE_PROMOTED_BOOKING_IDS = 30;

export type BedRangeRefusalCategory =
  | "EXCLUSIVE_HOLD"
  | "GUEST_NOT_BOOKED"
  // #2286: the bed is held for a season by a custodian on that night. Its own
  // category, never merged into BED_TAKEN: there is no occupying booking to
  // name and the admin's fix is a different page (Hut Leaders, not the board).
  | "CUSTODIAN_HOLD"
  | "BED_TAKEN";

export interface BedRangeRefusal {
  stayDate: string;
  category: BedRangeRefusalCategory;
  // BED_TAKEN only. `holdsCapacity: false` is the "Provisional" badge — the
  // occupant does not hold the night, but it is still a conflict (#2251
  // decision 2: nothing is silently overwritten).
  occupiedBy?: {
    guestName: string;
    memberName: string;
    bookingId: string;
    holdsCapacity: boolean;
  };
  // EXCLUSIVE_HOLD only, and always the guest's OWN booking — the only hold this
  // path refuses on. `ownBooking` stays on the wire so the dialog's wording (and
  // any future cross-booking rule) has an explicit signal rather than an
  // assumption.
  hold?: {
    bookingId: string;
    memberName: string;
    ownBooking: boolean;
  };
}

export interface AssignBedRangeResult {
  // False whenever nothing was written — either the atomic attempt was refused,
  // or the admin's explicit night list turned out to be blocked too.
  applied: boolean;
  // True when the admin sent an explicit `nights` subset rather than asking for
  // the whole range: a partial write they chose, night by night.
  partialByConsent: boolean;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  bedId: string;
  bedName: string;
  roomName: string;
  // Date-only lodge nights: `fromDate` is the first night, `toDate` the
  // check-out date (exclusive), matching every other bed-allocation endpoint.
  fromDate: string;
  toDate: string;
  requestedNights: string[];
  freeNights: string[];
  writtenNights: string[];
  refusals: BedRangeRefusal[];
  // #1750: partners stranded on a vacated bed-night by this operation. Recorded
  // as ONE batched audit entry inside the same transaction (#2251 residual R4);
  // each listed promotion carries its own booking, because a promoted partner may
  // belong to a different booking than the row that moved.
  promotedPartners: BedAllocation[];
}

// A long range's night list is bounded (366) but noisy in an audit record, so
// contiguous nights collapse into readable runs: ["2026-06-01 → 2026-06-30",
// "2026-07-02"]. The counts recorded alongside stay exact.
export function summariseNightRuns(nights: string[]): string[] {
  const sorted = [...new Set(nights)].sort();
  const runs: string[] = [];
  let runStart: string | null = null;
  let runEnd: string | null = null;

  const flush = () => {
    if (!runStart || !runEnd) return;
    runs.push(runStart === runEnd ? runStart : `${runStart} → ${runEnd}`);
  };

  for (const night of sorted) {
    if (
      runEnd &&
      formatDateOnly(addDaysDateOnly(parseDateOnly(runEnd), 1)) === night
    ) {
      runEnd = night;
      continue;
    }
    flush();
    runStart = night;
    runEnd = night;
  }
  flush();

  return runs;
}

export interface ParsedBedAssignRange {
  from: Date;
  to: Date;
  nights: string[];
}

/**
 * Validate and materialise a requested range — called BEFORE any transaction is
 * opened, so a malformed or absurd range never holds a database connection.
 *
 * The night cap is checked ARITHMETICALLY first (#2251 review): enumerating
 * "2026-06-01 → 9999-06-01" to discover it is too long would build nearly three
 * million Date objects before the refusal, which is a denial of service handed
 * to any admin with a slipped keystroke.
 */
function parseBedAssignRange(input: {
  from: string;
  to: string;
}): ParsedBedAssignRange {
  if (!isDateOnlyString(input.from)) {
    throw new BedAllocationAdminError("Invalid from date", 400);
  }
  if (!isDateOnlyString(input.to)) {
    throw new BedAllocationAdminError("Invalid to date", 400);
  }

  const from = parseDateOnly(input.from);
  const to = parseDateOnly(input.to);
  if (to <= from) {
    throw new BedAllocationAdminError("Date out must be after date in", 400);
  }

  const nightCount = countNightsDateOnly(from, to);
  if (nightCount > MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS) {
    // Refuse, never truncate (#2251 requirement 4): shortening the request
    // silently would write a different assignment from the one the admin asked
    // for and call it a success.
    throw new BedAllocationAdminError(
      `A range assignment covers at most ${MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS} nights; that range is ${nightCount}. Split it into shorter ranges.`,
      400,
    );
  }

  return { from, to, nights: eachDateOnlyInRange(from, to).map(formatDateOnly) };
}

/**
 * The explicit night list the admin consented to, checked against the range.
 *
 * The second action is "assign these N nights, the ones you just showed me".
 * The server therefore takes the list rather than recomputing "whatever is free
 * now": between the refusal and the click, a night can be freed by someone else,
 * and re-deriving would write a night the admin never saw (#2251 review A6/B5).
 */
function parseConsentedNights(
  nights: string[],
  range: ParsedBedAssignRange,
): string[] {
  if (nights.length === 0) {
    throw new BedAllocationAdminError(
      "Choose at least one night to assign",
      400,
    );
  }
  const requested = new Set(range.nights);
  const chosen = new Set<string>();
  for (const night of nights) {
    if (!isDateOnlyString(night) || !requested.has(night)) {
      throw new BedAllocationAdminError(
        "Those nights are not all inside the requested range — reload the board and try again.",
        400,
      );
    }
    chosen.add(night);
  }
  // Range order, so the written set reads the same way everywhere.
  return range.nights.filter((night) => chosen.has(night));
}

async function classifyBedTakenNights(input: {
  db: BedAllocationDb;
  bed: { id: string; bedType: BedType };
  guest: { id: string; memberId: string | null };
  candidateNights: string[];
}): Promise<{
  refusals: BedRangeRefusal[];
  secondOccupantNights: Set<string>;
}> {
  const refusals: BedRangeRefusal[] = [];
  const secondOccupantNights = new Set<string>();
  if (input.candidateNights.length === 0) {
    return { refusals, secondOccupantNights };
  }

  const occupantRows = await input.db.bedAllocation.findMany({
    where: {
      bedId: input.bed.id,
      stayDate: { in: input.candidateNights.map(parseDateOnly) },
      bookingGuestId: { not: input.guest.id },
    },
    select: {
      stayDate: true,
      isSecondOccupant: true,
      bookingGuest: {
        select: {
          memberId: true,
          firstName: true,
          lastName: true,
          booking: {
            select: {
              id: true,
              status: true,
              originBookingRequest: { select: { id: true } },
              adminCapacityHoldAt: true,
              member: {
                select: { firstName: true, lastName: true, email: true },
              },
            },
          },
        },
      },
    },
  });

  const byNight = new Map<string, typeof occupantRows>();
  for (const row of occupantRows) {
    const key = formatDateOnly(row.stayDate);
    const existing = byNight.get(key);
    if (existing) {
      existing.push(row);
    } else {
      byNight.set(key, [row]);
    }
  }

  // Partner eligibility is a DB lookup, and a long range can meet a different
  // occupying member on every night. Ask ONCE for every distinct occupant
  // instead of per night, so the statement count stays fixed however long the
  // range is (#2251 review A1). Only DOUBLE beds can share at all.
  const shareEligibleMemberIds =
    input.bed.bedType === "DOUBLE" && input.guest.memberId
      ? await mayShareDoubleBedWith(
          input.guest.memberId,
          occupantRows
            .map((row) => row.bookingGuest.memberId)
            .filter((id): id is string => Boolean(id)),
          input.db,
        )
      : new Set<string>();

  for (const stayDate of input.candidateNights) {
    const occupants = byNight.get(stayDate);
    if (!occupants || occupants.length === 0) continue;

    const [primary] = occupants;
    const describe = (): BedRangeRefusal => ({
      stayDate,
      category: "BED_TAKEN",
      occupiedBy: {
        guestName: guestName(primary.bookingGuest),
        memberName: memberName(primary.bookingGuest.booking.member),
        bookingId: primary.bookingGuest.booking.id,
        holdsCapacity: bookingHoldsCapacity({
          status: primary.bookingGuest.booking.status,
          isRequestConverted: Boolean(
            primary.bookingGuest.booking.originBookingRequest,
          ),
          hasAdminCapacityHold: Boolean(
            primary.bookingGuest.booking.adminCapacityHoldAt,
          ),
        }),
      },
    });

    // Mirrors resolveSecondOccupant()'s rules exactly, batched: only a DOUBLE
    // holding exactly one PRIMARY occupant from a capacity-holding booking, both
    // member-linked and confirmed partners, may be shared (#1701/#1744).
    if (
      input.bed.bedType !== "DOUBLE" ||
      occupants.length >= 2 ||
      occupants.some((row) => row.isSecondOccupant) ||
      !isCapacityHoldingBookingStatus(primary.bookingGuest.booking.status) ||
      !input.guest.memberId ||
      !primary.bookingGuest.memberId
    ) {
      refusals.push(describe());
      continue;
    }

    if (!shareEligibleMemberIds.has(primary.bookingGuest.memberId)) {
      refusals.push(describe());
      continue;
    }
    secondOccupantNights.add(stayDate);
  }

  return { refusals, secondOccupantNights };
}

/**
 * Record the range operation and hand the result back — INSIDE the caller's
 * transaction (#2251 review A4/C5/B4).
 *
 * The audit write used to sit in the route, AFTER the transaction committed. A
 * failure there (or a crash between the two) left rows on real beds with no
 * record of who put them there, and answered the admin with a 500 for an
 * assignment that had in fact happened. Written here, rows and record commit or
 * roll back together.
 *
 * The entry describes an attempt that COMPLETED, either way: `applied` true, or
 * a refusal with its report. Attempts that THROW — unknown guest/bed, cancelled
 * booking, deactivated bed, an over-cap range, a lost write race — roll the
 * transaction back and deliberately record nothing, because nothing happened.
 *
 * Privacy (#2251 review C6): the metadata records SHAPE, not people. Up to 366
 * refusals, each naming another booking's guest and member, would file a roster
 * of unrelated members into an admin audit row that long outlives the board.
 * Counts, the refused night runs per category and the involved booking ids are
 * what an auditor needs; the names go to the admin who asked, in the API
 * response, and nowhere else. This matches the sibling BED_ALLOCATION_BULK_SET
 * entry, which records `{stayDate, reason}` conflicts and no names.
 */
async function recordRangeAssignAudit(
  db: BedAllocationDb,
  actorMemberId: string,
  result: AssignBedRangeResult,
): Promise<AssignBedRangeResult> {
  const refusedNights: Record<BedRangeRefusalCategory, string[]> = {
    EXCLUSIVE_HOLD: [],
    GUEST_NOT_BOOKED: [],
    CUSTODIAN_HOLD: [],
    BED_TAKEN: [],
  };
  const involvedBookingIds = new Set<string>();
  for (const refusal of result.refusals) {
    refusedNights[refusal.category].push(refusal.stayDate);
    if (refusal.occupiedBy) involvedBookingIds.add(refusal.occupiedBy.bookingId);
    if (refusal.hold) involvedBookingIds.add(refusal.hold.bookingId);
  }

  /*
   * ONE audit entry for the whole operation, whichever way it went (owner
   * decision, 26 Jul 2026) — including the "assign the nights I chose" path,
   * which is one deliberate action and should read as one. A refused attempt is
   * recorded too, with outcome "failure": someone tried, and the trail should
   * say so and say why.
   *
   * targetId is the BOOKING id so the booking page's "Audit log" deep link
   * (?q=<bookingId>, which matches targetId and never metadata) surfaces range
   * operations — required by #2252, which drives this same path from inside a
   * booking.
   */
  await createAuditLog(
    {
      action: "BED_ALLOCATION_RANGE_SET",
      memberId: actorMemberId,
      targetId: result.bookingId,
      entityType: "BedAllocation",
      category: "admin",
      outcome: result.applied ? "success" : "failure",
      summary: result.applied
        ? `Bed assigned across ${result.writtenNights.length} night${result.writtenNights.length === 1 ? "" : "s"}${result.partialByConsent ? " (a subset the admin chose)" : ""}`
        : "Range bed assignment refused — nothing written",
      metadata: {
        bookingGuestId: result.bookingGuestId,
        bedId: result.bedId,
        bedName: result.bedName,
        roomName: result.roomName,
        requestedFrom: result.fromDate,
        requestedTo: result.toDate,
        requestedNightCount: result.requestedNights.length,
        // Auto-approved (#2251 decision 4): these rows land approved, which is
        // what locks the member's requested-room editing for this booking.
        autoApproved: result.applied,
        partialByConsent: result.partialByConsent,
        writtenNightCount: result.writtenNights.length,
        writtenNightRuns: summariseNightRuns(result.writtenNights),
        refusedNightCount: result.refusals.length,
        refusedNightCountsByCategory: {
          EXCLUSIVE_HOLD: refusedNights.EXCLUSIVE_HOLD.length,
          GUEST_NOT_BOOKED: refusedNights.GUEST_NOT_BOOKED.length,
          CUSTODIAN_HOLD: refusedNights.CUSTODIAN_HOLD.length,
          BED_TAKEN: refusedNights.BED_TAKEN.length,
        },
        refusedNightRunsByCategory: {
          EXCLUSIVE_HOLD: summariseNightRuns(refusedNights.EXCLUSIVE_HOLD),
          GUEST_NOT_BOOKED: summariseNightRuns(refusedNights.GUEST_NOT_BOOKED),
          CUSTODIAN_HOLD: summariseNightRuns(refusedNights.CUSTODIAN_HOLD),
          BED_TAKEN: summariseNightRuns(refusedNights.BED_TAKEN),
        },
        involvedBookingIds: [...involvedBookingIds],
      },
    },
    db,
  );

  /*
   * Moving a shared double's primary onto another bed auto-promotes the partner
   * left on the OLD bed-night (#1750). On the range path this is recorded as ONE
   * batched entry, not one per promotion (#2251 residual R4): a 366-night move
   * off shared doubles would otherwise write up to 366 audit rows inside the
   * transaction, so the one thing left growing with the range length is now
   * bounded too — every statement AND every audit row in this transaction is
   * fixed whatever the night count.
   *
   * The single-night and bulk board paths keep their per-promotion
   * BED_ALLOCATION_PARTNER_PROMOTED entries: they vacate one bed-night, so there
   * is nothing to batch and the established shape stays untouched.
   *
   * Shape follows the #2285 prune precedent (MAX_AUDITED_PRUNED_ALLOCATIONS): a
   * compact list capped at the audit sanitiser's array limit, the exact count
   * alongside it, and a flag saying the list is partial. `targetId` is the
   * booking whose range assignment caused the promotions — a promoted partner may
   * belong to a DIFFERENT booking, so each entry in the list carries its own
   * `bookingId`/`bookingGuestId` rather than the trail implying it was this
   * booking's row that moved.
   *
   * SEARCHABILITY (review finding on the batching): the admin audit search ORs
   * over `action, summary, details, requestId, entityId, targetId` and never
   * metadata (`audit-admin-query.ts`), and the booking page's audit link is
   * `?q=<bookingId>`. One batched entry can only carry ONE `targetId`, so the
   * promoted partner's own booking would stop being findable from its own
   * booking page — exactly the property the range entry above relies on. The
   * distinct promoted booking ids are therefore also written into `details`,
   * which IS searched, capped so the string stays inside the audit layer's
   * per-string budget with the overflow stated rather than silently dropped.
   */
  if (result.promotedPartners.length > 0) {
    const promotedBookingIds = [
      ...new Set(result.promotedPartners.map((row) => row.bookingId)),
    ];
    const searchableBookingIds = promotedBookingIds.slice(
      0,
      MAX_SEARCHABLE_PROMOTED_BOOKING_IDS,
    );
    const overflow = promotedBookingIds.length - searchableBookingIds.length;
    await createAuditLog(
      {
        action: "BED_ALLOCATION_PARTNERS_PROMOTED",
        memberId: actorMemberId,
        targetId: result.bookingId,
        entityType: "BedAllocation",
        category: "admin",
        outcome: "success",
        summary: `${result.promotedPartners.length} second occupant${result.promotedPartners.length === 1 ? "" : "s"} auto-promoted to primary after a range assignment moved the shared double's primary to another bed`,
        details: `Promoted partner bookings: ${searchableBookingIds.join(", ")}${overflow > 0 ? ` (+${overflow} more in metadata.promotions)` : ""}`,
        metadata: {
          issue: 1750,
          // The guest whose range assignment vacated the bed-nights, named
          // distinctly from each promoted partner's own bookingGuestId below:
          // they are different people on possibly different bookings.
          movedBookingGuestId: result.bookingGuestId,
          movedToBedId: result.bedId,
          promotedCount: result.promotedPartners.length,
          promotions: result.promotedPartners
            .slice(0, MAX_AUDITED_RANGE_PARTNER_PROMOTIONS)
            .map((promotedPartner) => ({
              allocationId: promotedPartner.id,
              bookingId: promotedPartner.bookingId,
              bookingGuestId: promotedPartner.bookingGuestId,
              bedId: promotedPartner.bedId,
              stayDate: formatDateOnly(promotedPartner.stayDate),
            })),
          promotionsTruncated:
            result.promotedPartners.length >
            MAX_AUDITED_RANGE_PARTNER_PROMOTIONS,
        },
      },
      db,
    );
  }

  return result;
}

async function runAssignBedRangeAttempt(input: {
  bookingGuestId: string;
  bedId: string;
  range: ParsedBedAssignRange;
  approvedByMemberId: string;
  consentedNights?: string[];
  db: BedAllocationDb;
}): Promise<AssignBedRangeResult> {
  const db = input.db;
  const range = input.range;
  const { guest, bed } = await assertGuestAndBedForAllocation({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    db,
    reportWholeLodgeHold: true,
  });

  const base = {
    partialByConsent: input.consentedNights !== undefined,
    bookingId: guest.bookingId,
    bookingGuestId: guest.id,
    guestName: guestName(guest),
    bedId: bed.id,
    bedName: bed.name,
    roomName: bed.room.name,
    fromDate: formatDateOnly(range.from),
    toDate: formatDateOnly(range.to),
    requestedNights: range.nights,
  };

  const refusalByNight = new Map<string, BedRangeRefusal>();

  // 1. EXCLUSIVE_HOLD — the guest's OWN booking holds the lodge (ADR-001): it
  //    implicitly occupies every bed, so no night of the range is allocatable
  //    and the free-nights action has nothing to offer either. The flag is read
  //    inside this transaction (assertGuestAndBedForAllocation selects it on the
  //    booking above), so it cannot be a stale pre-transaction snapshot.
  //
  //    ANOTHER booking's overlapping hold is NOT refused here. ADR-001 scopes
  //    the bed-allocation short-circuit to the held booking's own guests; the
  //    planner, the auto-allocator, the single-night and bulk manual paths and
  //    the lifecycle all still place ordinary bookings on beds across an
  //    overlapping hold, and the hold-set flow surfaces those bookings as
  //    conflicts rather than blocking them. Refusing only here would make this
  //    one endpoint stricter than the rule the rest of the domain enforces.
  if (guest.booking.wholeLodgeHold) {
    const ownBooking = await db.booking.findUnique({
      where: { id: guest.bookingId },
      select: {
        member: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    for (const stayDate of range.nights) {
      refusalByNight.set(stayDate, {
        stayDate,
        category: "EXCLUSIVE_HOLD",
        hold: {
          bookingId: guest.bookingId,
          memberName: ownBooking
            ? memberName(ownBooking.member)
            : "Unknown member",
          ownBooking: true,
        },
      });
    }
  }

  // 2. GUEST_NOT_BOOKED — a bad request, reported rather than skipped.
  for (const stayDate of range.nights) {
    if (refusalByNight.has(stayDate)) continue;
    if (guestIsStayingOn(guest, parseDateOnly(stayDate))) continue;
    refusalByNight.set(stayDate, { stayDate, category: "GUEST_NOT_BOOKED" });
  }

  // 3. CUSTODIAN_HOLD (#2286) — the bed is held for a season by a custodian on
  //    that night, with no booking anywhere. Classified BEFORE BED_TAKEN: it is
  //    the harder block (there is no occupying guest to negotiate with, and no
  //    second-occupant sharing can ever apply to a bed with no primary row), and
  //    the admin's fix is on the Hut Leaders page, not the board. Read inside
  //    this transaction, under the lodge lock the caller took.
  const custodianHeld = new Set(
    await custodianHeldNightsForBed({
      bedId: bed.id,
      stayDates: range.nights
        .filter((stayDate) => !refusalByNight.has(stayDate))
        .map(parseDateOnly),
      db,
    }),
  );
  for (const stayDate of range.nights) {
    if (refusalByNight.has(stayDate)) continue;
    if (!custodianHeld.has(stayDate)) continue;
    refusalByNight.set(stayDate, { stayDate, category: "CUSTODIAN_HOLD" });
  }

  // 4. BED_TAKEN — a genuine clash on the remaining nights.
  const { refusals: bedTaken, secondOccupantNights } =
    await classifyBedTakenNights({
      db,
      bed,
      guest,
      candidateNights: range.nights.filter(
        (stayDate) => !refusalByNight.has(stayDate),
      ),
    });
  for (const refusal of bedTaken) {
    refusalByNight.set(refusal.stayDate, refusal);
  }

  const refusals = range.nights
    .filter((stayDate) => refusalByNight.has(stayDate))
    .map((stayDate) => refusalByNight.get(stayDate) as BedRangeRefusal);
  const freeNights = range.nights.filter(
    (stayDate) => !refusalByNight.has(stayDate),
  );

  // Atomic by default: any blocker refuses the WHOLE range and writes nothing.
  // The refusal report is the evidence the admin acts on; an explicit night list
  // is their second action, not a fallback this code may take itself. That list
  // is honoured EXACTLY — if any night on it has since been blocked, the whole
  // attempt refuses with a FRESH report rather than quietly writing the rest, and
  // no night outside the list is ever written.
  const targetNights = input.consentedNights ?? range.nights;
  const blockedTargets = targetNights.filter((stayDate) =>
    refusalByNight.has(stayDate),
  );
  if (blockedTargets.length > 0 || targetNights.length === 0) {
    return recordRangeAssignAudit(db, input.approvedByMemberId, {
      ...base,
      applied: false,
      freeNights,
      writtenNights: [],
      refusals,
      promotedPartners: [],
    });
  }

  const existingRows = await db.bedAllocation.findMany({
    where: {
      bookingGuestId: guest.id,
      stayDate: { in: targetNights.map(parseDateOnly) },
    },
    select: { id: true, bedId: true, stayDate: true, isSecondOccupant: true },
  });
  const existingByNight = new Map(
    existingRows.map((row) => [formatDateOnly(row.stayDate), row]),
  );

  // AUTO-APPROVE (#2251 decision 4): a range assignment is a deliberate
  // confirmation, so it lands approved rather than draft.
  const approvedAt = new Date();
  const approval = {
    approvedAt,
    approvedByMemberId: input.approvedByMemberId,
  };

  // Batched by (already exists?, is second occupant?): at most two updateMany +
  // two createMany however long the range is — the whole reason a 366-night
  // assign can be atomic at all. The real bound for ONE attempt is AT MOST 14
  // statements, whatever the night count: guest + bed (2), the occupant scan
  // (1), up to two partner-eligibility lookups (2), the existing-row scan (1),
  // up to two updateMany + two createMany (4), the batched promotion's findMany
  // + updateMany (2), the range audit row (1), and — only when this move strands
  // partners on shared doubles — ONE batched partner-promotion audit row for all
  // of them (1, #2251 residual R4). (The own-hold member lookup is on the
  // mutually exclusive refusal path, which runs 4 statements and writes nothing.)
  // Nothing in this transaction, statement or audit row, may grow with the night
  // count.
  for (const isSecondOccupant of [false, true]) {
    const nights = targetNights.filter(
      (stayDate) => secondOccupantNights.has(stayDate) === isSecondOccupant,
    );
    const updateIds = nights
      .map((stayDate) => existingByNight.get(stayDate)?.id)
      .filter((id): id is string => Boolean(id));
    if (updateIds.length > 0) {
      await db.bedAllocation.updateMany({
        where: { id: { in: updateIds } },
        data: {
          roomId: bed.roomId,
          bedId: bed.id,
          source: "MANUAL",
          isSecondOccupant,
          bedType: bed.bedType,
          ...approval,
        },
      });
    }

    const createNights = nights.filter(
      (stayDate) => !existingByNight.has(stayDate),
    );
    if (createNights.length > 0) {
      await db.bedAllocation.createMany({
        data: createNights.map((stayDate) => ({
          bookingId: guest.bookingId,
          bookingGuestId: guest.id,
          roomId: bed.roomId,
          bedId: bed.id,
          stayDate: parseDateOnly(stayDate),
          source: "MANUAL" as const,
          isSecondOccupant,
          bedType: bed.bedType,
          ...approval,
        })),
      });
    }
  }

  // #1750: moving a PRIMARY off its old bed can strand a partner there. The
  // rows above already vacated those bed-nights, so promote afterwards, exactly
  // as the single-night path does — but through the BATCHED promoter: the
  // per-night helper runs two statements per vacated bed-night, which is the one
  // place a long range could still make this transaction grow with its length.
  const vacatedBedNights = targetNights.flatMap((stayDate) => {
    const previous = existingByNight.get(stayDate);
    if (!previous || previous.isSecondOccupant || previous.bedId === bed.id) {
      return [];
    }
    return [{ bedId: previous.bedId, stayDate: previous.stayDate }];
  });
  const promotedPartners = await promoteOrphanedSecondOccupantsBatch(
    db,
    vacatedBedNights,
  );

  return recordRangeAssignAudit(db, input.approvedByMemberId, {
    ...base,
    applied: true,
    freeNights,
    writtenNights: targetNights,
    refusals,
    promotedPartners,
  });
}

// A concurrent write that cost us the transaction. Both are retryable ONCE
// against fresh state, and both must end in a plain-English 409 rather than a
// generic 500 if the retry loses too (#2251 review A3):
//   P2002 — someone claimed one of the bed-nights between our scan and our write
//           (the unique index on bed/night did its job).
//   P2034 — the database aborted this transaction to break a write conflict or
//           deadlock. Prisma surfaces it as a distinct code; without an arm here
//           it fell through to "Bed allocation request failed", a 500 for what is
//           really "try again".
const RETRYABLE_RANGE_WRITE_CODES: Record<string, string> = {
  P2002:
    "Another admin claimed one of those bed-nights while this range was being assigned. Nothing was written — reload the board and try again.",
  P2034:
    "That range collided with another change being saved at the same moment, twice. Nothing was written — reload the board and try again.",
};

function retryableRangeWriteCode(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  return error.code in RETRYABLE_RANGE_WRITE_CODES ? error.code : null;
}

/**
 * Assign one guest to one bed across a range of any length, atomically.
 *
 * Returns a result rather than throwing when the range is BLOCKED: `applied`
 * false with the per-night refusals. It throws BedAllocationAdminError only for
 * genuinely malformed input (bad dates, unknown guest/bed, non-allocatable or
 * deleted booking, over the range cap, nights outside the range) and for a lost
 * write race.
 *
 * `nights`, when given, is the EXPLICIT set the admin consented to after seeing
 * a refusal report — assigned exactly, or refused with a fresh report. Omit it
 * for the ordinary all-or-nothing attempt.
 */
interface AssignBedRangeInput {
  bookingGuestId: string;
  bedId: string;
  from: string;
  to: string;
  approvedByMemberId: string;
  nights?: string[];
}

export async function assignBedRangeWithLocksHeld(
  input: AssignBedRangeInput & { db: BedAllocationDb },
): Promise<AssignBedRangeResult> {
  const range = parseBedAssignRange({ from: input.from, to: input.to });
  const consentedNights = input.nights
    ? parseConsentedNights(input.nights, range)
    : undefined;
  return runAssignBedRangeAttempt({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    range,
    approvedByMemberId: input.approvedByMemberId,
    consentedNights,
    db: input.db,
  });
}

export async function assignBedRange(
  input: AssignBedRangeInput,
): Promise<AssignBedRangeResult> {
  // Parsed and validated BEFORE any transaction opens (#2251 review C2): a
  // malformed range, or one absurd enough to blow the night cap, must never
  // occupy a database connection to be told so.
  const range = parseBedAssignRange({ from: input.from, to: input.to });
  if (input.nights) {
    parseConsentedNights(input.nights, range);
  }

  // The scan, the writes and the audit row share one transaction so the refusal
  // report, the rows written from it and the record of both describe the same
  // instant. The default 5s interactive timeout is raised because the statement
  // count is fixed (see runAssignBedRangeAttempt) but a 366-night createMany is
  // a big single statement — generous headroom, not a licence to grow the
  // statement count with nights.
  // #2286: the lodge lock is acquired FIRST inside the transaction, so the
  // custodian scan below cannot race a hold being created or cleared. Resolved
  // outside the transaction so it is genuinely the first statement.
  const lockLodgeId = await resolveBedLodgeIdForLock(input.bedId, prisma);
  const runAttempt = () =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        if (lockLodgeId) await acquireLodgeCapacityLock(tx, lockLodgeId);
        return assignBedRangeWithLocksHeld({ ...input, db: tx });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

  try {
    return await runAttempt();
  } catch (error) {
    if (!retryableRangeWriteCode(error)) {
      throw error;
    }
    // Nothing was written (the transaction rolled back), so re-attempt once
    // against fresh state: the second scan sees the new occupant and returns it
    // as an ordinary BED_TAKEN refusal instead of an opaque error.
    try {
      return await runAttempt();
    } catch (retryError) {
      const code = retryableRangeWriteCode(retryError);
      if (code) {
        throw new BedAllocationAdminError(
          RETRYABLE_RANGE_WRITE_CODES[code],
          409,
        );
      }
      throw retryError;
    }
  }
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

/**
 * How many of a booking's bed nights are already approved — the booking-wide
 * count, ignoring any date window (#2252 review).
 *
 * `isBookingBedAllocationLocked` above answers "is the member's room request
 * locked?", which only needs existence. The in-booking panel needs the COUNT,
 * because it must decide whether the run an officer is about to remove holds
 * the booking's LAST approved nights — and on a stay longer than the 31-night
 * read window, the panel's own page cannot see the approved nights sitting on
 * the other pages. Deciding from the page alone made the "this re-opens the
 * member's room request" warning fire on stays where it was simply false.
 */
export async function countApprovedBedAllocationNights(input: {
  bookingId: string;
  db?: BedAllocationDb;
}): Promise<number> {
  const db = input.db ?? prisma;
  return db.bedAllocation.count({
    where: {
      bookingId: input.bookingId,
      approvedAt: { not: null },
    },
  });
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

export async function approveBedAllocationsWithLocksHeld(
  input: ApproveBedAllocationsInput & { db: BedAllocationDb },
) {
  const where: Prisma.BedAllocationWhereInput = {
    approvedAt: null,
  };

  if (input.bookingId) {
    where.bookingId = input.bookingId;
    /*
     * ADR-003 lodge scope on the BOOKING selector too (#2252 review).
     *
     * The in-booking panel's read is lodge-scoped, so a row of this booking
     * sitting in another lodge's room — an anomaly, but a reachable one across
     * a booking that moved lodge, or a pre-backfill row — is invisible on the
     * card. Without this the approve would stamp it anyway, making the write
     * scope strictly wider than the read: the officer would confirm a bed they
     * were never shown. Scoped, Confirm can only approve what was on screen.
     *
     * Omitting `lodgeId` still means club-wide, exactly as before, so the
     * board's own selector forms are untouched (the board never sends a
     * bookingId).
     */
    if (input.lodgeId) {
      where.room = lodgeNullTolerantScope(input.lodgeId);
    }
  }

  if (input.allocationIds?.length) {
    where.id = { in: input.allocationIds };
  } else if (input.range) {
    where.stayDate = {
      gte: input.range.from,
      lt: input.range.to,
    };
    if (input.lodgeId) {
      where.room = lodgeNullTolerantScope(input.lodgeId);
    }
  } else if (!input.bookingId) {
    // Fires only when NONE of the three selectors is given: an unselected
    // approve would otherwise stamp every pending allocation in the database.
    throw new BedAllocationAdminError(
      "Select allocations, a booking, or a date range to approve.",
      400,
    );
  }

  return input.db.bedAllocation.updateMany({
    where,
    data: {
      approvedAt: new Date(),
      approvedByMemberId: input.approvedByMemberId,
    },
  });
}

export async function approveBedAllocations(input: ApproveBedAllocationsInput) {
  const lockWhere: Prisma.BedAllocationWhereInput = input.allocationIds?.length
    ? { id: { in: input.allocationIds } }
    : input.range
      ? { stayDate: { gte: input.range.from, lt: input.range.to } }
      : input.bookingId
        ? { bookingId: input.bookingId }
        : { id: { in: [] } };
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const lockRows = input.lodgeId
      ? []
      : await tx.bedAllocation.findMany({
          where: lockWhere,
          select: { room: { select: { lodgeId: true } } },
        });
    const lodgeIds = input.lodgeId
      ? [input.lodgeId]
      : ([
          ...new Set(lockRows.map((row) => row.room.lodgeId).filter(Boolean)),
        ].sort() as string[]);
    for (const lodgeId of lodgeIds) {
      await acquireLodgeCapacityLock(tx, lodgeId);
    }
    return approveBedAllocationsWithLocksHeld({ ...input, db: tx });
  });
}
