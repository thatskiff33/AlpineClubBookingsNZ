/**
 * The bed board's warnings (#2688).
 *
 * Pure: it reads the serialised allocations and the custodian holds already
 * loaded for the board and reports what a human should look at. It never
 * queries and never writes, which is why it is a test seam.
 */
import type {
  AdminBedAllocationWarning,
  DashboardAllocation,
  DashboardCustodianHold,
} from "@/lib/bed-allocation-board-payload";

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
    // A group exists only because a row was pushed into it, so it always has a
    // first row; an empty group names no booking-night to warn about (#2800).
    const first = group[0];
    if (first === undefined) continue;
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
    if (first === undefined) continue;
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
    // Two nights or more, and reading the first is what says so; a single
    // night has nothing to switch between (#2800).
    const [firstNight, ...laterNights] = [...nights.keys()].sort();
    if (firstNight === undefined || laterNights.length === 0) continue;
    const sortedNights = [firstNight, ...laterNights];
    const roomKeyForNight = (night: string) =>
      [...(nights.get(night) ?? [])].sort().join(",");
    const firstKey = roomKeyForNight(firstNight);
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
