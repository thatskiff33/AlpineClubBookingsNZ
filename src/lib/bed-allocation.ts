import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";

export type BedAllocationSource = "AUTO" | "MANUAL";
export type BedAllocationAgeTier = "INFANT" | "CHILD" | "YOUTH" | "ADULT";

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
  ageTier?: BedAllocationAgeTier | null;
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
  reason: "NO_ACTIVE_BEDS" | "NO_BED_AVAILABLE" | "NO_BOOKING_ADULT";
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

interface SortedRoomWithBeds extends BedAllocationRoom {
  beds: BedAllocationBed[];
}

function sortedActiveRoomsWithBeds(
  rooms: BedAllocationRoom[],
): SortedRoomWithBeds[] {
  return [...rooms]
    .filter((room) => room.active !== false)
    .sort(compareSortThenName)
    .map((room) => ({
      ...room,
      beds: [...room.beds]
        .filter((bed) => bed.active !== false)
        .sort(compareSortThenName)
        .map((bed) => ({ ...bed, roomId: room.id })),
    }));
}

function guestStayNights(guest: BedAllocationGuest): string[] {
  return eachDateOnlyInRange(guest.stayStart, guest.stayEnd).map(formatDateOnly);
}

function bookingStayNights(booking: BedAllocationBooking): Array<{
  stayDate: string;
  guests: BedAllocationGuest[];
}> {
  const guestsByNight = new Map<string, BedAllocationGuest[]>();

  for (const guest of booking.guests) {
    for (const stayDate of guestStayNights(guest)) {
      const guests = guestsByNight.get(stayDate) ?? [];
      guests.push(guest);
      guestsByNight.set(stayDate, guests);
    }
  }

  return [...guestsByNight.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stayDate, guests]) => ({ stayDate, guests }));
}

function isAdultGuest(guest: BedAllocationGuest): boolean {
  return !guest.ageTier || guest.ageTier === "ADULT";
}

function roomHasAvailableBeds(
  room: SortedRoomWithBeds,
  stayDate: string,
  occupied: Set<string>,
): BedAllocationBed[] {
  return room.beds.filter((bed) => !occupied.has(occupiedKey(bed.id, stayDate)));
}

function allocationReasonForNoBed(beds: BedAllocationBed[]) {
  return beds.length === 0 ? "NO_ACTIVE_BEDS" : "NO_BED_AVAILABLE";
}

function createAllocation(
  booking: BedAllocationBooking,
  guest: BedAllocationGuest,
  bed: BedAllocationBed,
  stayDate: string,
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
): BedAllocationCandidate {
  occupied.add(occupiedKey(bed.id, stayDate));
  allocatedGuestNights.add(guestNightKey(guest.id, stayDate));

  return {
    bookingId: booking.id,
    bookingGuestId: guest.id,
    roomId: bed.roomId,
    bedId: bed.id,
    stayDate,
    source: "AUTO",
  };
}

function allocateGuestsToBeds(
  booking: BedAllocationBooking,
  guests: BedAllocationGuest[],
  beds: BedAllocationBed[],
  stayDate: string,
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
  allocations: BedAllocationCandidate[],
) {
  for (let index = 0; index < guests.length; index += 1) {
    allocations.push(
      createAllocation(
        booking,
        guests[index],
        beds[index],
        stayDate,
        occupied,
        allocatedGuestNights,
      ),
    );
  }
}

function addUnallocatedGuestNights(
  bookingId: string,
  guests: BedAllocationGuest[],
  stayDate: string,
  reason: UnallocatedGuestNight["reason"],
  unallocatedGuestNights: UnallocatedGuestNight[],
) {
  for (const guest of guests) {
    unallocatedGuestNights.push({
      bookingId,
      bookingGuestId: guest.id,
      stayDate,
      reason,
    });
  }
}

function tryAllocateWholeBookingNight(
  booking: BedAllocationBooking,
  guests: BedAllocationGuest[],
  stayDate: string,
  rooms: SortedRoomWithBeds[],
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
  allocations: BedAllocationCandidate[],
): boolean {
  const hasMinor = guests.some((guest) => !isAdultGuest(guest));
  const hasAdult = guests.some(isAdultGuest);

  if (hasMinor && !hasAdult) {
    return false;
  }

  for (const room of rooms) {
    const availableBeds = roomHasAvailableBeds(room, stayDate, occupied);

    if (availableBeds.length >= guests.length) {
      allocateGuestsToBeds(
        booking,
        guests,
        availableBeds,
        stayDate,
        occupied,
        allocatedGuestNights,
        allocations,
      );
      return true;
    }
  }

  return false;
}

function allocateAdultsAcrossBeds(
  booking: BedAllocationBooking,
  adults: BedAllocationGuest[],
  availableBeds: BedAllocationBed[],
  stayDate: string,
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
  allocations: BedAllocationCandidate[],
  unallocatedGuestNights: UnallocatedGuestNight[],
  unallocatedReason: UnallocatedGuestNight["reason"],
) {
  const allocatedAdults = adults.slice(0, availableBeds.length);
  const unallocatedAdults = adults.slice(availableBeds.length);

  allocateGuestsToBeds(
    booking,
    allocatedAdults,
    availableBeds.slice(0, allocatedAdults.length),
    stayDate,
    occupied,
    allocatedGuestNights,
    allocations,
  );
  addUnallocatedGuestNights(
    booking.id,
    unallocatedAdults,
    stayDate,
    unallocatedReason,
    unallocatedGuestNights,
  );
}

function allocateSplitBookingNight(
  booking: BedAllocationBooking,
  guests: BedAllocationGuest[],
  stayDate: string,
  rooms: SortedRoomWithBeds[],
  beds: BedAllocationBed[],
  occupied: Set<string>,
  allocatedGuestNights: Set<string>,
  allocations: BedAllocationCandidate[],
  unallocatedGuestNights: UnallocatedGuestNight[],
) {
  const adults = guests.filter(isAdultGuest);
  const minors = guests.filter((guest) => !isAdultGuest(guest));
  const roomAvailability = rooms
    .map((room, roomIndex) => ({
      roomIndex,
      beds: roomHasAvailableBeds(room, stayDate, occupied),
    }))
    .filter((room) => room.beds.length > 0);

  if (minors.length === 0) {
    allocateAdultsAcrossBeds(
      booking,
      adults,
      roomAvailability.flatMap((room) => room.beds),
      stayDate,
      occupied,
      allocatedGuestNights,
      allocations,
      unallocatedGuestNights,
      allocationReasonForNoBed(beds),
    );
    return;
  }

  if (adults.length === 0) {
    addUnallocatedGuestNights(
      booking.id,
      minors,
      stayDate,
      "NO_BOOKING_ADULT",
      unallocatedGuestNights,
    );
    return;
  }

  const remainingAdults = [...adults];
  const remainingMinors = [...minors];
  const roomsForMinors = roomAvailability
    .filter((room) => room.beds.length >= 2)
    .sort((a, b) => {
      const capacityDiff = b.beds.length - a.beds.length;
      return capacityDiff !== 0 ? capacityDiff : a.roomIndex - b.roomIndex;
    });

  for (const room of roomsForMinors) {
    if (remainingAdults.length === 0 || remainingMinors.length === 0) break;

    const adult = remainingAdults.shift();
    if (!adult) break;

    const roomMinors = remainingMinors.splice(0, room.beds.length - 1);
    const roomGuests = [adult, ...roomMinors];
    const roomBeds = room.beds.splice(0, roomGuests.length);

    allocateGuestsToBeds(
      booking,
      roomGuests,
      roomBeds,
      stayDate,
      occupied,
      allocatedGuestNights,
      allocations,
    );
  }

  const leftoverBeds = roomAvailability.flatMap((room) => room.beds);
  allocateAdultsAcrossBeds(
    booking,
    remainingAdults,
    leftoverBeds,
    stayDate,
    occupied,
    allocatedGuestNights,
    allocations,
    unallocatedGuestNights,
    allocationReasonForNoBed(beds),
  );

  addUnallocatedGuestNights(
    booking.id,
    remainingMinors,
    stayDate,
    allocationReasonForNoBed(beds),
    unallocatedGuestNights,
  );
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

  const activeRooms = sortedActiveRoomsWithBeds(rooms);
  const beds = activeRooms.flatMap((room) => room.beds);
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
    for (const { stayDate, guests } of bookingStayNights(booking)) {
      const unallocatedGuests = guests.filter(
        (guest) => !allocatedGuestNights.has(guestNightKey(guest.id, stayDate)),
      );
      if (unallocatedGuests.length === 0) continue;

      if (
        tryAllocateWholeBookingNight(
          booking,
          unallocatedGuests,
          stayDate,
          activeRooms,
          occupied,
          allocatedGuestNights,
          allocations,
        )
      ) {
        continue;
      }

      allocateSplitBookingNight(
        booking,
        unallocatedGuests,
        stayDate,
        activeRooms,
        beds,
        occupied,
        allocatedGuestNights,
        allocations,
        unallocatedGuestNights,
      );
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
