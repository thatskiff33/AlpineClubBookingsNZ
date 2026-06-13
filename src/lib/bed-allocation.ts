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
  /**
   * Preferred room from the booking's room request, if any. Auto-allocation
   * tries this room first before falling back to family-grouping and
   * first-fit. A missing/inactive room (filtered out of `activeRooms`) is
   * treated as no preference — never an error.
   */
  requestedRoomId: string | null;
}

export interface OccupiedBedNight {
  bedId: string;
  stayDate: string | Date;
  bookingId?: string | null;
  bookingGuestId?: string | null;
  roomId?: string | null;
  ageTier?: BedAllocationAgeTier | null;
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

function bookingNightKey(bookingId: string, stayDate: string) {
  return `${bookingId}:${stayDate}`;
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

/**
 * Returns `rooms` reordered so the booking's requested room (if active and
 * present) is tried first. If there is no request, or the requested room is
 * not in `rooms` (inactive, deleted, or never set), the original order is
 * returned unchanged — the request is silently treated as no preference.
 */
function roomsForBooking(
  rooms: SortedRoomWithBeds[],
  booking: BedAllocationBooking,
): SortedRoomWithBeds[] {
  const requestedRoomId = booking.requestedRoomId;
  if (!requestedRoomId) return rooms;

  const requestedIndex = rooms.findIndex((room) => room.id === requestedRoomId);
  if (requestedIndex <= 0) return rooms;

  const reordered = [...rooms];
  const [requestedRoom] = reordered.splice(requestedIndex, 1);
  reordered.unshift(requestedRoom);
  return reordered;
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

function isAdultAgeTier(ageTier?: BedAllocationAgeTier | null): boolean {
  return !ageTier || ageTier === "ADULT";
}

function isAdultGuest(guest: BedAllocationGuest): boolean {
  return isAdultAgeTier(guest.ageTier);
}

function roomHasAvailableBeds(
  room: SortedRoomWithBeds,
  stayDate: string,
  occupied: Set<string>,
): BedAllocationBed[] {
  return room.beds.filter((bed) => !occupied.has(occupiedKey(bed.id, stayDate)));
}

function existingAllocationsByBookingNight(
  occupiedBedNights: OccupiedBedNight[],
) {
  const existing = new Map<string, OccupiedBedNight[]>();

  for (const occupiedBedNight of occupiedBedNights) {
    if (!occupiedBedNight.bookingId) continue;

    const stayDate = normalizeStayDate(occupiedBedNight.stayDate);
    const key = bookingNightKey(occupiedBedNight.bookingId, stayDate);
    const bookingNight = existing.get(key) ?? [];
    bookingNight.push(occupiedBedNight);
    existing.set(key, bookingNight);
  }

  return existing;
}

function existingAdultRoomIds(
  existingAllocations: OccupiedBedNight[],
  guests: BedAllocationGuest[],
) {
  const guestById = new Map(guests.map((guest) => [guest.id, guest]));
  const roomIds = new Set<string>();

  for (const allocation of existingAllocations) {
    if (!allocation.roomId || !allocation.bookingGuestId) continue;

    const existingGuest = guestById.get(allocation.bookingGuestId);
    const ageTier = allocation.ageTier ?? existingGuest?.ageTier;
    if (!isAdultAgeTier(ageTier)) {
      continue;
    }

    roomIds.add(allocation.roomId);
  }

  return roomIds;
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
  existingAdultRooms: Set<string>,
): boolean {
  const hasMinor = guests.some((guest) => !isAdultGuest(guest));
  const hasAdult = guests.some(isAdultGuest);

  if (hasMinor && !hasAdult && existingAdultRooms.size === 0) {
    return false;
  }

  for (const room of rooms) {
    if (hasMinor && !hasAdult && !existingAdultRooms.has(room.id)) {
      continue;
    }

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
  existingAdultRooms: Set<string>,
) {
  const adults = guests.filter(isAdultGuest);
  const minors = guests.filter((guest) => !isAdultGuest(guest));
  const roomAvailability = rooms
    .map((room, roomIndex) => ({
      roomId: room.id,
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

  if (adults.length === 0 && existingAdultRooms.size === 0) {
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
  const roomsWithExistingAdults = roomAvailability
    .filter((room) => existingAdultRooms.has(room.roomId))
    .sort((a, b) => a.roomIndex - b.roomIndex);

  for (const room of roomsWithExistingAdults) {
    if (remainingMinors.length === 0) break;

    const roomMinors = remainingMinors.splice(0, room.beds.length);
    const roomBeds = room.beds.splice(0, roomMinors.length);

    allocateGuestsToBeds(
      booking,
      roomMinors,
      roomBeds,
      stayDate,
      occupied,
      allocatedGuestNights,
      allocations,
    );
  }

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
  const existingByBookingNight =
    existingAllocationsByBookingNight(occupiedBedNights);
  const allocatedGuestNights = new Set(
    occupiedBedNights
      .filter((night) => night.bookingGuestId)
      .map((night) =>
        guestNightKey(
          night.bookingGuestId as string,
          normalizeStayDate(night.stayDate),
        ),
      ),
  );
  const allocations: BedAllocationCandidate[] = [];
  const unallocatedGuestNights: UnallocatedGuestNight[] = [];
  const sortedBookings = [...bookings].sort((a, b) => {
    const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
    return createdDiff !== 0 ? createdDiff : a.id.localeCompare(b.id);
  });

  for (const booking of sortedBookings) {
    const roomsForThisBooking = roomsForBooking(activeRooms, booking);

    for (const { stayDate, guests } of bookingStayNights(booking)) {
      const existingAdultRooms = existingAdultRoomIds(
        existingByBookingNight.get(bookingNightKey(booking.id, stayDate)) ?? [],
        guests,
      );
      const unallocatedGuests = guests.filter(
        (guest) => !allocatedGuestNights.has(guestNightKey(guest.id, stayDate)),
      );
      if (unallocatedGuests.length === 0) continue;

      if (
        tryAllocateWholeBookingNight(
          booking,
          unallocatedGuests,
          stayDate,
          roomsForThisBooking,
          occupied,
          allocatedGuestNights,
          allocations,
          existingAdultRooms,
        )
      ) {
        continue;
      }

      allocateSplitBookingNight(
        booking,
        unallocatedGuests,
        stayDate,
        roomsForThisBooking,
        beds,
        occupied,
        allocatedGuestNights,
        allocations,
        unallocatedGuestNights,
        existingAdultRooms,
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
