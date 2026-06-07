import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";

export type BedAllocationSource = "AUTO" | "MANUAL";

export interface BedAllocationBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder?: number | null;
  active?: boolean | null;
}

export interface BedAllocationRoom {
  id: string;
  name: string;
  sortOrder?: number | null;
  active?: boolean | null;
  beds: BedAllocationBed[];
}

export interface BedAllocationGuest {
  id: string;
  bookingId: string;
  stayStart: Date;
  stayEnd: Date;
}

export interface BedAllocationBooking {
  id: string;
  createdAt: Date;
  guests: BedAllocationGuest[];
}

export interface OccupiedBedNight {
  bedId: string;
  stayDate: string | Date;
}

export interface BedAllocationCandidate {
  bookingId: string;
  bookingGuestId: string;
  roomId: string;
  bedId: string;
  stayDate: string;
  source: BedAllocationSource;
}

export interface UnallocatedGuestNight {
  bookingId: string;
  bookingGuestId: string;
  stayDate: string;
  reason: "NO_ACTIVE_BEDS" | "NO_BED_AVAILABLE";
}

export interface BuildBedAllocationPlanInput {
  enabled: boolean;
  rooms: BedAllocationRoom[];
  bookings: BedAllocationBooking[];
  occupiedBedNights?: OccupiedBedNight[];
}

export interface BedAllocationPlan {
  allocations: BedAllocationCandidate[];
  unallocatedGuestNights: UnallocatedGuestNight[];
}

export interface BedAllocationPersistenceClient {
  bedAllocation: {
    deleteMany: (args: { where: { bookingId: string } }) => Promise<unknown>;
    createMany: (args: {
      data: Array<{
        bookingId: string;
        bookingGuestId: string;
        roomId: string;
        bedId: string;
        stayDate: Date;
        source: BedAllocationSource;
      }>;
    }) => Promise<{ count: number }>;
  };
}

function compareSortThenName<T extends { sortOrder?: number | null; name: string; id: string }>(
  a: T,
  b: T,
) {
  const sortDiff = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  if (sortDiff !== 0) return sortDiff;
  const nameDiff = a.name.localeCompare(b.name);
  return nameDiff !== 0 ? nameDiff : a.id.localeCompare(b.id);
}

function normalizeStayDate(value: string | Date): string {
  return typeof value === "string" ? value : formatDateOnly(value);
}

function occupiedKey(bedId: string, stayDate: string) {
  return `${bedId}:${stayDate}`;
}

function guestNightKey(bookingGuestId: string, stayDate: string) {
  return `${bookingGuestId}:${stayDate}`;
}

function sortedActiveBeds(rooms: BedAllocationRoom[]): BedAllocationBed[] {
  return [...rooms]
    .filter((room) => room.active !== false)
    .sort(compareSortThenName)
    .flatMap((room) =>
      [...room.beds]
        .filter((bed) => bed.active !== false)
        .sort(compareSortThenName)
        .map((bed) => ({ ...bed, roomId: room.id })),
    );
}

function guestStayNights(guest: BedAllocationGuest): string[] {
  return eachDateOnlyInRange(guest.stayStart, guest.stayEnd).map(formatDateOnly);
}

export function buildFirstFitBedAllocationPlan({
  enabled,
  rooms,
  bookings,
  occupiedBedNights = [],
}: BuildBedAllocationPlanInput): BedAllocationPlan {
  if (!enabled) {
    return { allocations: [], unallocatedGuestNights: [] };
  }

  const beds = sortedActiveBeds(rooms);
  const occupied = new Set(
    occupiedBedNights.map((night) =>
      occupiedKey(night.bedId, normalizeStayDate(night.stayDate)),
    ),
  );
  const allocatedGuestNights = new Set<string>();
  const allocations: BedAllocationCandidate[] = [];
  const unallocatedGuestNights: UnallocatedGuestNight[] = [];
  const sortedBookings = [...bookings].sort((a, b) => {
    const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
    return createdDiff !== 0 ? createdDiff : a.id.localeCompare(b.id);
  });

  for (const booking of sortedBookings) {
    for (const guest of booking.guests) {
      for (const stayDate of guestStayNights(guest)) {
        const guestKey = guestNightKey(guest.id, stayDate);
        if (allocatedGuestNights.has(guestKey)) continue;

        const bed = beds.find(
          (candidate) => !occupied.has(occupiedKey(candidate.id, stayDate)),
        );
        if (!bed) {
          unallocatedGuestNights.push({
            bookingId: booking.id,
            bookingGuestId: guest.id,
            stayDate,
            reason: beds.length === 0 ? "NO_ACTIVE_BEDS" : "NO_BED_AVAILABLE",
          });
          continue;
        }

        occupied.add(occupiedKey(bed.id, stayDate));
        allocatedGuestNights.add(guestKey);
        allocations.push({
          bookingId: booking.id,
          bookingGuestId: guest.id,
          roomId: bed.roomId,
          bedId: bed.id,
          stayDate,
          source: "AUTO",
        });
      }
    }
  }

  return { allocations, unallocatedGuestNights };
}

export async function replaceBedAllocationsForBooking(
  client: BedAllocationPersistenceClient,
  bookingId: string,
  allocations: BedAllocationCandidate[],
) {
  await client.bedAllocation.deleteMany({ where: { bookingId } });

  const data = allocations.map((allocation) => ({
    bookingId: allocation.bookingId,
    bookingGuestId: allocation.bookingGuestId,
    roomId: allocation.roomId,
    bedId: allocation.bedId,
    stayDate: parseDateOnly(allocation.stayDate),
    source: allocation.source,
  }));

  if (data.length === 0) {
    return { count: 0 };
  }

  return client.bedAllocation.createMany({ data });
}
