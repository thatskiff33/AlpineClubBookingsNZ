import { BookingStatus, Prisma } from "@prisma/client";

import { featureFlags } from "@/config/features";
import type { FeatureFlags } from "@/config/schema";
import {
  buildFirstFitBedAllocationPlan,
  type BedAllocationBooking,
  type BedAllocationRoom,
} from "@/lib/bed-allocation";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
} from "@/lib/date-only";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { prisma } from "@/lib/prisma";

type BedAllocationLifecycleDb = Prisma.TransactionClient | typeof prisma;

export const BED_ALLOCATABLE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
  BookingStatus.AWAITING_REVIEW,
  BookingStatus.WAITLIST_OFFERED,
] as const;

export interface BedAllocationLifecycleRange {
  checkIn: Date;
  checkOut: Date;
}

export interface BedAllocationLifecycleResult {
  enabled: boolean;
  deletedCount: number;
  createdCount: number;
}

interface ReconcileBedAllocationsForBookingInput {
  bookingId: string;
  db?: BedAllocationLifecycleDb;
  previousRange?: BedAllocationLifecycleRange | null;
  envCapability?: FeatureFlags;
}

interface AutoAllocateMissingBedNightsInput {
  db: BedAllocationLifecycleDb;
  range: BedAllocationLifecycleRange;
}

type BookingForBedAllocation = Awaited<
  ReturnType<typeof loadBookingForBedAllocation>
>;

function isAllocatableBookingStatus(status: string): boolean {
  return (BED_ALLOCATABLE_BOOKING_STATUSES as readonly string[]).includes(status);
}

function normalizeRange(
  range?: BedAllocationLifecycleRange | null,
): BedAllocationLifecycleRange | null {
  if (!range || range.checkOut <= range.checkIn) return null;
  return range;
}

function mergeRanges(
  left?: BedAllocationLifecycleRange | null,
  right?: BedAllocationLifecycleRange | null,
): BedAllocationLifecycleRange | null {
  const normalizedLeft = normalizeRange(left);
  const normalizedRight = normalizeRange(right);

  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;

  return {
    checkIn:
      normalizedLeft.checkIn < normalizedRight.checkIn
        ? normalizedLeft.checkIn
        : normalizedRight.checkIn,
    checkOut:
      normalizedLeft.checkOut > normalizedRight.checkOut
        ? normalizedLeft.checkOut
        : normalizedRight.checkOut,
  };
}

function clampRange(
  stayStart: Date,
  stayEnd: Date,
  range: BedAllocationLifecycleRange,
): BedAllocationLifecycleRange | null {
  return normalizeRange({
    checkIn: stayStart > range.checkIn ? stayStart : range.checkIn,
    checkOut: stayEnd < range.checkOut ? stayEnd : range.checkOut,
  });
}

async function loadBookingForBedAllocation(
  db: BedAllocationLifecycleDb,
  bookingId: string,
) {
  return db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          id: true,
          bookingId: true,
          ageTier: true,
          stayStart: true,
          stayEnd: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
}

async function pruneAllocationsForBooking(
  db: BedAllocationLifecycleDb,
  bookingId: string,
  booking: BookingForBedAllocation,
): Promise<number> {
  if (
    !booking ||
    booking.deletedAt ||
    !isAllocatableBookingStatus(booking.status) ||
    booking.guests.length === 0
  ) {
    const deleted = await db.bedAllocation.deleteMany({
      where: { bookingId },
    });
    return deleted.count;
  }

  const guestIds = booking.guests.map((guest) => guest.id);
  const staleGuestNightClauses: Prisma.BedAllocationWhereInput[] = [
    { bookingGuestId: { notIn: guestIds } },
  ];

  for (const guest of booking.guests) {
    staleGuestNightClauses.push(
      {
        bookingGuestId: guest.id,
        stayDate: { lt: guest.stayStart },
      },
      {
        bookingGuestId: guest.id,
        stayDate: { gte: guest.stayEnd },
      },
    );
  }

  const deleted = await db.bedAllocation.deleteMany({
    where: {
      bookingId,
      OR: staleGuestNightClauses,
    },
  });

  return deleted.count;
}

async function autoAllocateMissingBedNights({
  db,
  range,
}: AutoAllocateMissingBedNightsInput): Promise<number> {
  const settings = await db.bedAllocationSettings.findUnique({
    where: { id: "default" },
  });

  if (settings?.autoAllocationEnabled === false) {
    return 0;
  }

  const [rooms, bookings, existingAllocations] = await Promise.all([
    db.lodgeRoom.findMany({
      include: { beds: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
    }),
    db.booking.findMany({
      where: {
        deletedAt: null,
        status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
        checkIn: { lt: range.checkOut },
        checkOut: { gt: range.checkIn },
        guests: {
          some: {
            stayStart: { lt: range.checkOut },
            stayEnd: { gt: range.checkIn },
          },
        },
      },
      select: {
        id: true,
        createdAt: true,
        requestedRoomId: true,
        guests: {
          where: {
            stayStart: { lt: range.checkOut },
            stayEnd: { gt: range.checkIn },
          },
          select: {
            id: true,
            bookingId: true,
            ageTier: true,
            stayStart: true,
            stayEnd: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.bedAllocation.findMany({
      where: {
        stayDate: {
          gte: range.checkIn,
          lt: range.checkOut,
        },
      },
      select: {
        bedId: true,
        bookingId: true,
        bookingGuestId: true,
        roomId: true,
        stayDate: true,
        bookingGuest: {
          select: {
            ageTier: true,
          },
        },
      },
    }),
  ]);

  const allocatedGuestNights = new Set(
    existingAllocations.map(
      (allocation) =>
        `${allocation.bookingGuestId}:${formatDateOnly(allocation.stayDate)}`,
    ),
  );

  const plannerBookings: BedAllocationBooking[] = bookings
    .map((booking) => {
      const guests: BedAllocationBooking["guests"] = [];

      for (const guest of booking.guests) {
        const clamped = clampRange(guest.stayStart, guest.stayEnd, range);
        if (!clamped) continue;

        for (const stayDate of eachDateOnlyInRange(
          clamped.checkIn,
          clamped.checkOut,
        )) {
          const stayDateKey = formatDateOnly(stayDate);
          if (allocatedGuestNights.has(`${guest.id}:${stayDateKey}`)) {
            continue;
          }

          guests.push({
            id: guest.id,
            bookingId: booking.id,
            ageTier: guest.ageTier,
            stayStart: stayDate,
            stayEnd: addDaysDateOnly(stayDate, 1),
          });
        }
      }

      return guests.length
        ? {
            id: booking.id,
            createdAt: booking.createdAt,
            requestedRoomId: booking.requestedRoomId,
            guests,
          }
        : null;
    })
    .filter((booking): booking is BedAllocationBooking => Boolean(booking));

  if (plannerBookings.length === 0) {
    return 0;
  }

  const plannerRooms = rooms.map((room) => ({
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

  const plan = buildFirstFitBedAllocationPlan({
    enabled: true,
    rooms: plannerRooms,
    bookings: plannerBookings,
    occupiedBedNights: existingAllocations.map((allocation) => ({
      bedId: allocation.bedId,
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      roomId: allocation.roomId,
      stayDate: allocation.stayDate,
      ageTier: allocation.bookingGuest.ageTier,
    })),
  });

  if (plan.allocations.length === 0) {
    return 0;
  }

  const created = await db.bedAllocation.createMany({
    data: plan.allocations.map((allocation) => ({
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      roomId: allocation.roomId,
      bedId: allocation.bedId,
      stayDate: new Date(`${allocation.stayDate}T00:00:00.000Z`),
      source: allocation.source,
    })),
    skipDuplicates: true,
  });

  return created.count;
}

export async function reconcileBedAllocationsForBooking({
  bookingId,
  db = prisma,
  previousRange,
  envCapability = featureFlags,
}: ReconcileBedAllocationsForBookingInput): Promise<BedAllocationLifecycleResult> {
  const enabled = await isEffectiveModuleEnabled(
    "bedAllocation",
    envCapability,
    db,
  );

  if (!enabled) {
    return { enabled: false, deletedCount: 0, createdCount: 0 };
  }

  const booking = await loadBookingForBedAllocation(db, bookingId);
  const deletedCount = await pruneAllocationsForBooking(db, bookingId, booking);
  const currentRange = booking
    ? { checkIn: booking.checkIn, checkOut: booking.checkOut }
    : null;
  const autoAllocationRange = mergeRanges(previousRange, currentRange);
  const createdCount = autoAllocationRange
    ? await autoAllocateMissingBedNights({
        db,
        range: autoAllocationRange,
      })
    : 0;

  return { enabled: true, deletedCount, createdCount };
}
