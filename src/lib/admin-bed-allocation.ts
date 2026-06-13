import { Prisma, type BedAllocation } from "@prisma/client";
import { clubConfig } from "@/config/club";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import { getLodgeCapacityStatus, type LodgeCapacityStatus } from "@/lib/lodge-capacity";
import {
  buildFirstFitBedAllocationPlan,
  type BedAllocationAgeTier,
  type BedAllocationBooking,
  type BedAllocationCandidate,
  type BedAllocationRoom,
  type UnallocatedGuestNight,
} from "@/lib/bed-allocation";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import { prisma } from "@/lib/prisma";

export const BED_ALLOCATION_SETTINGS_ID = "default";
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
  type: "BOOKING_SPLIT" | "MINOR_WITHOUT_BOOKING_ADULT";
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
}

interface DashboardBooking {
  id: string;
  status: string;
  createdAt: string;
  checkIn: string;
  checkOut: string;
  memberName: string;
  guests: DashboardGuest[];
  requestedRoom: DashboardRequestedRoom | null;
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
  suggestedAllocations: BedAllocationCandidate[];
  suggestedUnallocatedGuestNights: UnallocatedGuestNight[];
  warnings: AdminBedAllocationWarning[];
}

export interface RoomsAndBedsConfigurationPayload {
  rooms: DashboardRoom[];
  capacity: LodgeCapacityStatus;
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

export async function getBedAllocationSettings(
  db: BedAllocationDb = prisma,
): Promise<BedAllocationSettingsPayload> {
  const record = await db.bedAllocationSettings.findUnique({
    where: { id: BED_ALLOCATION_SETTINGS_ID },
  });

  return {
    autoAllocationEnabled: record?.autoAllocationEnabled ?? true,
    updatedByMemberId: record?.updatedByMemberId ?? null,
    updatedAt: record?.updatedAt.toISOString() ?? null,
  };
}

export async function updateBedAllocationSettings(input: {
  autoAllocationEnabled: boolean;
  updatedByMemberId: string;
  db?: BedAllocationDb;
}): Promise<BedAllocationSettingsPayload> {
  const db = input.db ?? prisma;
  const record = await db.bedAllocationSettings.upsert({
    where: { id: BED_ALLOCATION_SETTINGS_ID },
    create: {
      id: BED_ALLOCATION_SETTINGS_ID,
      autoAllocationEnabled: input.autoAllocationEnabled,
      updatedByMemberId: input.updatedByMemberId,
    },
    update: {
      autoAllocationEnabled: input.autoAllocationEnabled,
      updatedByMemberId: input.updatedByMemberId,
    },
  });

  return {
    autoAllocationEnabled: record.autoAllocationEnabled,
    updatedByMemberId: record.updatedByMemberId,
    updatedAt: record.updatedAt.toISOString(),
  };
}

export async function listBedAllocationRooms(db: BedAllocationDb = prisma) {
  return db.lodgeRoom.findMany({
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
): Promise<RoomsAndBedsConfigurationPayload> {
  const [rooms, capacity] = await Promise.all([
    listBedAllocationRooms(db),
    getLodgeCapacityStatus(db),
  ]);
  const bedCount = rooms.reduce((total, room) => total + room.beds.length, 0);

  return {
    rooms: serializeRooms(rooms),
    capacity,
    canImportFromConfig: rooms.length === 0 && bedCount === 0,
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
  db?: BedAllocationDb;
}) {
  return (input.db ?? prisma).lodgeRoom.create({
    data: {
      name: input.name.trim(),
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
      notes: input.notes?.trim() || null,
    },
  });
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

export async function createBedAllocationBed(input: {
  roomId: string;
  name: string;
  sortOrder?: number;
  active?: boolean;
  db?: BedAllocationDb;
}) {
  return (input.db ?? prisma).lodgeBed.create({
    data: {
      roomId: input.roomId,
      name: input.name.trim(),
      sortOrder: input.sortOrder ?? 0,
      active: input.active ?? true,
    },
  });
}

export async function updateBedAllocationBed(input: {
  id: string;
  name?: string;
  sortOrder?: number;
  active?: boolean;
  db?: BedAllocationDb;
}) {
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
  range: BedAllocationDateRange,
) {
  return {
    stayStart: guest.stayStart > range.from ? guest.stayStart : range.from,
    stayEnd: guest.stayEnd < range.to ? guest.stayEnd : range.to,
  };
}

async function loadBookingRecords(
  range: BedAllocationDateRange,
  db: BedAllocationDb,
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
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      checkIn: true,
      checkOut: true,
      requestedRoomId: true,
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
) {
  return db.bedAllocation.findMany({
    where: {
      stayDate: {
        gte: range.from,
        lt: range.to,
      },
    },
    include: {
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
    })),
  }));
}

function serializeBookings(
  bookings: DashboardBookingRecord[],
): DashboardBooking[] {
  return bookings.map((booking) => ({
    id: booking.id,
    status: booking.status,
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
    .map(([bookingId, guests]) => {
      const booking = bookingById.get(bookingId);
      if (!booking) return null;
      return {
        id: booking.id,
        createdAt: booking.createdAt,
        requestedRoomId: booking.requestedRoomId,
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
    beds: room.beds.map((bed) => ({
      id: bed.id,
      roomId: bed.roomId,
      name: bed.name,
      sortOrder: bed.sortOrder,
      active: bed.active,
    })),
  })) satisfies BedAllocationRoom[];
}

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

  return warnings;
}

export async function getBedAllocationDashboard(input: {
  range: BedAllocationDateRange;
  db?: BedAllocationDb;
}): Promise<BedAllocationDashboardPayload> {
  const db = input.db ?? prisma;
  const [settings, rooms, bookings, allocationRecords] = await Promise.all([
    getBedAllocationSettings(db),
    listBedAllocationRooms(db),
    loadBookingRecords(input.range, db),
    loadAllocationRecords(input.range, db),
  ]);
  const serializedAllocations = serializeAllocations(allocationRecords);
  const allGuestNights = buildGuestNightRows(bookings, input.range);
  const allocatedGuestNights = new Set(
    serializedAllocations.map((allocation) =>
      guestNightKey(allocation.bookingGuestId, allocation.stayDate),
    ),
  );
  const unallocatedGuestNights = allGuestNights.filter(
    (guestNight) =>
      !allocatedGuestNights.has(
        guestNightKey(guestNight.bookingGuestId, guestNight.stayDate),
      ),
  );
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

  return {
    settings,
    range: {
      fromDate: input.range.fromDate,
      toDate: input.range.toDate,
    },
    rooms: serializeRooms(rooms),
    bookings: serializeBookings(bookings),
    allocations: serializedAllocations,
    unallocatedGuestNights,
    suggestedAllocations: plan.allocations,
    suggestedUnallocatedGuestNights: plan.unallocatedGuestNights,
    warnings: buildBedAllocationWarnings({ allocations: serializedAllocations }),
  };
}

export async function runAutoBedAllocation(input: {
  range: BedAllocationDateRange;
  db?: BedAllocationDb;
}) {
  const db = input.db ?? prisma;
  const dashboard = await getBedAllocationDashboard({ range: input.range, db });

  if (!dashboard.settings.autoAllocationEnabled) {
    throw new BedAllocationAdminError(
      "Auto allocation is disabled; use manual allocation.",
      409,
    );
  }

  if (dashboard.suggestedAllocations.length === 0) {
    return { count: 0 };
  }

  return db.bedAllocation.createMany({
    data: dashboard.suggestedAllocations.map((allocation) => ({
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      roomId: allocation.roomId,
      bedId: allocation.bedId,
      stayDate: parseDateOnly(allocation.stayDate),
      source: "AUTO" as const,
    })),
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

export async function manuallyAllocateBed(input: {
  bookingGuestId: string;
  bedId: string;
  stayDate: string;
  db?: BedAllocationDb;
}) {
  if (!isDateOnlyString(input.stayDate)) {
    throw new BedAllocationAdminError("Invalid stay date", 400);
  }

  const db = input.db ?? prisma;
  const stayDate = parseDateOnly(input.stayDate);
  const { guest, bed } = await assertManualAllocationInput({
    bookingGuestId: input.bookingGuestId,
    bedId: input.bedId,
    stayDate,
    db,
  });

  try {
    return await db.bedAllocation.upsert({
      where: {
        bookingGuestId_stayDate: {
          bookingGuestId: input.bookingGuestId,
          stayDate,
        },
      },
      create: {
        bookingId: guest.bookingId,
        bookingGuestId: guest.id,
        roomId: bed.roomId,
        bedId: bed.id,
        stayDate,
        source: "MANUAL",
      },
      update: {
        roomId: bed.roomId,
        bedId: bed.id,
        source: "MANUAL",
        approvedAt: null,
        approvedByMemberId: null,
      },
    });
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

export interface BulkAllocationConflict {
  stayDate: string;
  reason: "BED_TAKEN";
}

export interface BulkAllocationResult {
  allocations: BedAllocation[];
  conflicts: BulkAllocationConflict[];
  skipped: string[];
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

  for (const stayDateStr of [...new Set(input.stayDates)].sort()) {
    const stayDate = parseDateOnly(stayDateStr);
    if (!guestIsStayingOn(guest, stayDate)) {
      skipped.push(stayDateStr);
      continue;
    }

    try {
      const allocation = await db.bedAllocation.upsert({
        where: {
          bookingGuestId_stayDate: {
            bookingGuestId: input.bookingGuestId,
            stayDate,
          },
        },
        create: {
          bookingId: guest.bookingId,
          bookingGuestId: guest.id,
          roomId: bed.roomId,
          bedId: bed.id,
          stayDate,
          source: "MANUAL",
        },
        update: {
          roomId: bed.roomId,
          bedId: bed.id,
          source: "MANUAL",
          approvedAt: null,
          approvedByMemberId: null,
        },
      });
      allocations.push(allocation);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        conflicts.push({ stayDate: stayDateStr, reason: "BED_TAKEN" });
        continue;
      }
      throw error;
    }
  }

  return { allocations, conflicts, skipped };
}

export async function deleteBedAllocation(input: {
  id: string;
  db?: BedAllocationDb;
}) {
  return (input.db ?? prisma).bedAllocation.delete({
    where: { id: input.id },
  });
}

export async function approveBedAllocations(input: {
  approvedByMemberId: string;
  allocationIds?: string[];
  range?: BedAllocationDateRange;
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
