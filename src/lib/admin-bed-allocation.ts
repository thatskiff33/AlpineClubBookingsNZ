import {
  Prisma,
  type BedAllocation,
  type BedType,
  type LodgeBed,
  type LodgeRoom,
} from "@prisma/client";
import { clubConfig } from "@/config/club";
import { DEFAULT_BED_ALLOCATION_SETTINGS } from "@/config/club-settings-defaults";
import {
  addDaysDateOnly,
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
} from "@/lib/bed-allocation-lifecycle";
import logger from "@/lib/logger";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import {
  bookingHoldsCapacity,
  isCapacityHoldingBookingStatus,
} from "@/lib/booking-status";
import { mayShareDoubleBed } from "@/lib/double-bed-sharing";
import { bookingsOverlap, sameLodgeNullTolerant } from "@/lib/capacity";
import { prisma } from "@/lib/prisma";

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

export interface BedAllocationSettingsPayload {
  autoAllocationEnabled: boolean;
  updatedByMemberId: string | null;
  updatedAt: string | null;
}

export interface AdminBedAllocationWarning {
  id: string;
  // BOOKING_SPLIT is same-night (party split across rooms on one night);
  // ROOM_SWITCH is stay-level (issue #1677) — the booking's room set changes
  // between nights, so someone must move rooms mid-stay. MINOR_ADULT_MIX
  // (#1768) flags a room-night where one booking's minors share the room with
  // another booking's adults — the planner never creates this, so it marks a
  // pre-existing or manual placement for the admin to resolve.
  type:
    | "BOOKING_SPLIT"
    | "MINOR_WITHOUT_BOOKING_ADULT"
    | "ROOM_SWITCH"
    | "MINOR_ADULT_MIX";
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

async function getBedAllocationSettings(
  db: BedAllocationDb = prisma,
  // Lodge scope (lodge-scoping contract): the lodge's own row (id =
  // lodgeId) wins; else the legacy "default" row applies when unlinked or
  // soft-linked to this lodge; else code defaults.
  lodgeId?: string | null,
): Promise<BedAllocationSettingsPayload> {
  if (lodgeId && lodgeId !== BED_ALLOCATION_SETTINGS_ID) {
    const ownRow = await db.bedAllocationSettings.findUnique({
      where: { id: lodgeId },
    });
    if (ownRow) {
      return {
        autoAllocationEnabled: ownRow.autoAllocationEnabled,
        updatedByMemberId: ownRow.updatedByMemberId,
        updatedAt: ownRow.updatedAt.toISOString(),
      };
    }
  }
  const record = await db.bedAllocationSettings.findUnique({
    where: { id: BED_ALLOCATION_SETTINGS_ID },
  });
  if (record && lodgeId && record.lodgeId && record.lodgeId !== lodgeId) {
    return {
      autoAllocationEnabled: DEFAULT_BED_ALLOCATION_SETTINGS.autoAllocationEnabled,
      updatedByMemberId: null,
      updatedAt: null,
    };
  }

  return {
    autoAllocationEnabled:
      record?.autoAllocationEnabled ??
      DEFAULT_BED_ALLOCATION_SETTINGS.autoAllocationEnabled,
    updatedByMemberId: record?.updatedByMemberId ?? null,
    updatedAt: record?.updatedAt.toISOString() ?? null,
  };
}

export async function updateBedAllocationSettings(input: {
  autoAllocationEnabled: boolean;
  updatedByMemberId: string;
  db?: BedAllocationDb;
  // Lodge scope: the legacy "default" row keeps serving the lodge it was
  // soft-linked to (and single-lodge clubs); other lodges get their own
  // row keyed by lodge id. An unlinked legacy row is claimed on write.
  lodgeId?: string | null;
}): Promise<BedAllocationSettingsPayload> {
  const db = input.db ?? prisma;
  const legacy = await db.bedAllocationSettings.findUnique({
    where: { id: BED_ALLOCATION_SETTINGS_ID },
  });
  const targetsLegacyRow =
    !input.lodgeId ||
    !legacy ||
    legacy.lodgeId === null ||
    legacy.lodgeId === input.lodgeId;
  const targetId = targetsLegacyRow
    ? BED_ALLOCATION_SETTINGS_ID
    : input.lodgeId!;

  const record = await db.bedAllocationSettings.upsert({
    where: { id: targetId },
    create: {
      id: targetId,
      autoAllocationEnabled: input.autoAllocationEnabled,
      updatedByMemberId: input.updatedByMemberId,
      lodgeId: input.lodgeId ?? null,
    },
    update: {
      autoAllocationEnabled: input.autoAllocationEnabled,
      updatedByMemberId: input.updatedByMemberId,
      ...(input.lodgeId && (!legacy || legacy.lodgeId === null) && targetsLegacyRow
        ? { lodgeId: input.lodgeId }
        : {}),
    },
  });

  return {
    autoAllocationEnabled: record.autoAllocationEnabled,
    updatedByMemberId: record.updatedByMemberId,
    updatedAt: record.updatedAt.toISOString(),
  };
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
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
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
  db?: BedAllocationDb;
}) {
  const data: Prisma.LodgeRoomUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.active !== undefined) data.active = input.active;
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;

  return (input.db ?? prisma).lodgeRoom.update({
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
  await db.$queryRaw`SELECT id FROM "LodgeRoom" WHERE id = ${roomId} FOR UPDATE`;
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
  db?: BedAllocationDb;
}): Promise<LodgeBed> {
  // A bunk-affecting edit (type or group) re-validates pairing under a room
  // lock, so it must run in a transaction; self-wrap when no client is given.
  const touchesBunk =
    input.bedType !== undefined || input.bunkGroup !== undefined;
  if (touchesBunk && !input.db) {
    return prisma.$transaction((tx) =>
      updateBedAllocationBed({ ...input, db: tx }),
    );
  }

  const db = input.db ?? prisma;
  if (input.active === false) {
    await assertNoFutureBedAllocations({
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

export async function deleteBedAllocationBed(input: {
  id: string;
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
  await assertNoFutureBedAllocations({
    bedId: input.id,
    db,
    action: "delete",
  });

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

// Classify a P2003 caught during the bed+room deletes. The pg driver adapter
// can drop the structured constraint field (see booking-envelope-invariants),
// so scan the message and any surviving meta. A BedAllocation FK means real
// allocation history (the raw pg message names LodgeBed as the table being
// modified in that case too, so BedAllocation must win when both appear); a
// LodgeBed -> room FK means a bed was added mid-delete; anything else falls
// back to the allocation-history steer.
function p2003TargetsLodgeBedRoomFk(
  error: Prisma.PrismaClientKnownRequestError,
): boolean {
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
  if (text.includes("bedallocation")) return false;
  return text.includes("lodgebed");
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
}

export async function deleteBedAllocationRoom(input: {
  id: string;
  // Optional lodge scope, consistent with the other room functions: when
  // supplied the room must belong to this lodge (else 404). The route mirrors
  // the bed DELETE and does not pass it; callers that carry lodge context can
  // scope the delete defensively.
  lodgeId?: string;
  db?: BedAllocationDb;
  // Explicit return type: the function references itself in the $transaction
  // branch, which TS cannot infer through (TS7023), matching the annotation on
  // the other self-recursive transaction helpers here.
}): Promise<LodgeRoom> {
  // Run the history guard and the bed+room deletes in one transaction so a
  // concurrent allocation cannot slip between the check and the delete. A
  // caller-supplied client is assumed to already be transactional.
  if (!input.db) {
    return prisma.$transaction((tx) =>
      deleteBedAllocationRoom({ ...input, db: tx }),
    );
  }
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
      throw new BedAllocationAdminError(
        p2003TargetsLodgeBedRoomFk(error)
          ? ROOM_CHANGED_WHILE_DELETING_MESSAGE
          : ROOM_HAS_ALLOCATION_HISTORY_MESSAGE,
        409,
      );
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
        },
        select: {
          id: true,
          bookingId: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          stayStart: true,
          stayEnd: true,
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
  }));
}

function buildGuestNightRows(
  bookings: DashboardBookingRecord[],
  range: BedAllocationDateRange,
): DashboardGuestNight[] {
  const rows: DashboardGuestNight[] = [];

  for (const booking of bookings) {
    const bookingMemberName = memberName(booking.member);

    for (const guest of booking.guests) {
      const clamped = clampGuestToRange(guest, range);

      for (const date of eachDateOnlyInRange(clamped.stayStart, clamped.stayEnd)) {
        rows.push({
          bookingId: booking.id,
          bookingGuestId: guest.id,
          guestName: guestName(guest),
          guestAgeTier: guest.ageTier,
          memberName: bookingMemberName,
          stayDate: formatDateOnly(date),
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
    getBedAllocationSettings(db, input.lodgeId),
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

  const allGuestNights = buildGuestNightRows(bookings, input.range);
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
  const plannerRooms = buildPlannerRooms(rooms);
  const plannerBookings = candidateGuestBookings(bookings, unallocatedGuestNights);
  const plan = settings.autoAllocationEnabled
    ? buildFirstFitBedAllocationPlan({
        enabled: true,
        rooms: plannerRooms,
        bookings: plannerBookings,
        occupiedBedNights: serializedAllocations.map((allocation) => ({
          bedId: allocation.bedId,
          bookingId: allocation.bookingId,
          bookingGuestId: allocation.bookingGuestId,
          roomId: allocation.roomId,
          stayDate: allocation.stayDate,
          ageTier: allocation.guestAgeTier,
        })),
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
    suggestedAllocations: plan.allocations,
    suggestedUnallocatedGuestNights: plan.unallocatedGuestNights,
    warnings: buildBedAllocationWarnings({ allocations: serializedAllocations }),
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
  lodgeId?: string;
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
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

  // Write-time re-check (#2285 review): the dashboard read above is not held
  // under any lock, so an exclusive hold set (or a cancel / soft delete) can
  // commit between the read and this write. Its prune frees the unique keys, so
  // `skipDuplicates` cannot stop us re-inserting rows for a booking that must
  // own none — re-read the payload's bookings and drop those that are no longer
  // allocatable. Shared with the lifecycle planner so both writers agree.
  const { rows, droppedBookingIds } =
    await dropAllocationRowsForUnallocatableBookings(
      db,
      dashboard.suggestedAllocations.map((allocation) => ({
        bookingId: allocation.bookingId,
        bookingGuestId: allocation.bookingGuestId,
        roomId: allocation.roomId,
        bedId: allocation.bedId,
        stayDate: parseDateOnly(allocation.stayDate),
        source: "AUTO" as const,
      })),
    );

  if (droppedBookingIds.length > 0) {
    logger.info(
      { droppedBookingIds, lodgeId: input.lodgeId ?? null },
      "Run Auto Allocation write-time re-check dropped suggestions for bookings that became unallocatable (held/cancelled/deleted) after planning",
    );
  }
  if (rows.length === 0) {
    return { count: 0 };
  }

  return db.bedAllocation.createMany({
    data: rows,
    skipDuplicates: true,
  });
}

async function assertGuestAndBedForAllocation(input: {
  bookingGuestId: string;
  bedId: string;
  db: BedAllocationDb;
}) {
  const [guest, bed] = await Promise.all([
    input.db.bookingGuest.findUnique({
      where: { id: input.bookingGuestId },
      include: {
        booking: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            lodgeId: true,
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

function guestIsStayingOn(
  guest: { stayStart: Date; stayEnd: Date },
  stayDate: Date,
): boolean {
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

export async function manuallyAllocateBed(input: {
  bookingGuestId: string;
  bedId: string;
  stayDate: string;
  db?: BedAllocationDb;
  // Explicit return type: the function references itself in the $transaction
  // branch, which TS cannot infer through (TS7023).
}): Promise<{ allocation: BedAllocation; promotedPartner: BedAllocation | null }> {
  if (!isDateOnlyString(input.stayDate)) {
    throw new BedAllocationAdminError("Invalid stay date", 400);
  }

  // Pre-move read + upsert + orphan promotion must be atomic so moving a shared
  // double's primary to another bed can't strand its partner between the writes
  // (#1750). A caller-supplied client is assumed to already be transactional.
  if (!input.db) {
    return prisma.$transaction((tx) =>
      manuallyAllocateBed({ ...input, db: tx }),
    );
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

interface BulkAllocationConflict {
  stayDate: string;
  reason: "BED_TAKEN";
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
export async function manuallyAllocateBedForNights(input: {
  bookingGuestId: string;
  bedId: string;
  stayDates: string[];
  db?: BedAllocationDb;
}): Promise<BulkAllocationResult> {
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

  const db = input.db ?? prisma;
  const { guest, bed } = await assertGuestAndBedForAllocation({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    db,
  });

  const allocations: BedAllocation[] = [];
  const conflicts: BulkAllocationConflict[] = [];
  const skipped: string[] = [];
  const promotedPartners: BedAllocation[] = [];

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
      const { allocation, promotedPartner } = input.db
        ? await allocateBedNight({ guest, bed, stayDate, db })
        : await prisma.$transaction((tx) =>
            allocateBedNight({ guest, bed, stayDate, db: tx }),
          );
      allocations.push(allocation);
      if (promotedPartner) {
        promotedPartners.push(promotedPartner);
      }
    } catch (error) {
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

export async function deleteBedAllocation(input: {
  id: string;
  db?: BedAllocationDb;
  // Explicit return type: the function references itself in the $transaction
  // branch, which TS cannot infer through (TS7023), matching the annotation on
  // the other self-recursive transaction helpers here.
}): Promise<{ deleted: BedAllocation; promotedPartner: BedAllocation | null }> {
  // Delete + orphan auto-promotion must be atomic so a failure between the two
  // writes cannot strand a lone isSecondOccupant=true row (#1743). A
  // caller-supplied client is assumed to already be transactional.
  if (!input.db) {
    return prisma.$transaction((tx) =>
      deleteBedAllocation({ ...input, db: tx }),
    );
  }
  const db = input.db;

  const deleted = await db.bedAllocation.delete({
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
    const [promoted] = await promoteOrphanedSecondOccupants(db, [
      { bedId: deleted.bedId, stayDate: deleted.stayDate },
    ]);
    promotedPartner = promoted ?? null;
  }

  return { deleted, promotedPartner };
}

/**
 * Whether an admin has confirmed (locked) the bed allocation for a booking.
 *
 * Issue #776: members may set/clear their requested room until the lodge
 * confirms beds. The lock signal is the presence of at least one approved
 * BedAllocation row for the booking — `approveBedAllocations` stamps
 * `approvedAt`/`approvedByMemberId` when an admin explicitly confirms beds.
 * Unapproved (auto-suggested or pending manual) allocations do not lock it.
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

export async function approveBedAllocations(input: {
  approvedByMemberId: string;
  allocationIds?: string[];
  range?: BedAllocationDateRange;
  // Range approval follows the board's lodge scope so approving one lodge's
  // board never approves another lodge's pending allocations.
  lodgeId?: string;
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
  const where: Prisma.BedAllocationWhereInput = {
    approvedAt: null,
  };

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
  } else {
    throw new BedAllocationAdminError(
      "Select allocations or provide a date range to approve.",
      400,
    );
  }

  return db.bedAllocation.updateMany({
    where,
    data: {
      approvedAt: new Date(),
      approvedByMemberId: input.approvedByMemberId,
    },
  });
}
