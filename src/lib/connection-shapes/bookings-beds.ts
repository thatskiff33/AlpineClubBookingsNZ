/**
 * What the Bookings & Beds bed allocation officer actions return (ALP-719,
 * `INV-MCP-006`): the board, its settings, rooms and beds, and the answers of
 * placing, moving, approving and removing allocations. The catalogue entry and
 * the route's `connectionJson` both read these (`INV-SSOT`).
 *
 * Kept: what an officer's AI app needs to read the board and act on it, the
 * guest and booking-owner names included, as the board shows them.
 * Dropped: row timestamps, the board's internal ordering and debugging fields
 * (warning ids, raw booking status beside the computed `holdsCapacity`), the
 * custodian assignment id, and every other member's id or name the screen does
 * not need: who approved an allocation and who last saved the settings.
 *
 * Types only from the route modules: nothing here reaches the database.
 */
import type { BedAllocation, LodgeBed, LodgeRoom } from "@prisma/client";

import type { BedAllocationDashboardPayload } from "@/lib/bed-allocation-board-payload";
import type { BedAllocationMoveApplyResult, BedAllocationMovePreview } from "@/lib/bed-allocation-move";
import type { AssignBedRangeResult } from "@/lib/bed-allocation-range-report";
import type {
  BedAllocationRemovalApplyResult,
  BedAllocationRemovalPreview,
} from "@/lib/bed-allocation-removal";
import type {
  createBedAllocationRoomsBulk,
  ImportRoomsAndBedsResult,
  RoomsAndBedsConfigurationPayload,
} from "@/lib/bed-allocation-rooms";
import type { EffectiveBedAllocationSettings } from "@/lib/bed-allocation-settings";
import { connectionShapeFor, eachEntry } from "@/lib/connection-projection";

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** The board's answer: the dashboard plus the lodge the route scoped it to. */
export type BedAllocationBoardAnswer = BedAllocationDashboardPayload & { scopedLodgeId: string | null };

// Nested shapes are plain constants, checked where a typed shape uses them.
const BOARD_ROOM_SHAPE = {
  id: true,
  name: true,
  active: true,
  notes: true,
  beds: { id: true, name: true, active: true, bedType: true, bunkGroup: true },
} as const;

export const ADMIN_BED_ALLOCATION_BOARD_CONNECTION_SHAPE = connectionShapeFor<BedAllocationBoardAnswer>({
  settings: { autoAllocationEnabled: true, allocationPriorityOrder: true },
  range: { fromDate: true, toDate: true },
  rooms: BOARD_ROOM_SHAPE,
  bookings: {
    id: true,
    status: true,
    holdsCapacity: true,
    checkIn: true,
    checkOut: true,
    memberName: true,
    guests: { id: true, name: true, ageTier: true, stayStart: true, stayEnd: true },
    requestedRoom: { id: true, name: true, active: true },
    parentBookingId: true,
    wholeLodgeHold: true,
    overlapsExclusiveHold: true,
  },
  allocations: {
    id: true,
    bookingId: true,
    bookingGuestId: true,
    guestName: true,
    guestAgeTier: true,
    roomId: true,
    roomName: true,
    bedId: true,
    bedName: true,
    stayDate: true,
    source: true,
    approvedAt: true,
    isSecondOccupant: true,
    holdsCapacity: true,
  },
  unallocatedGuestNights: {
    bookingId: true,
    bookingGuestId: true,
    guestName: true,
    guestAgeTier: true,
    memberName: true,
    stayDate: true,
  },
  exclusiveHolds: {
    bookingId: true,
    memberName: true,
    checkIn: true,
    checkOut: true,
    guestCount: true,
    nights: true,
  },
  custodianHolds: {
    memberName: true,
    bedId: true,
    bedName: true,
    roomName: true,
    startDate: true,
    endDate: true,
    nights: true,
  },
  pendingAdultReservations: { bookingId: true, night: true, adultCount: true },
  suggestedAllocations: { bookingId: true, bookingGuestId: true, roomId: true, bedId: true, stayDate: true },
  suggestedUnallocatedGuestNights: { bookingId: true, bookingGuestId: true, stayDate: true, reason: true },
  warnings: {
    type: true,
    bookingId: true,
    bookingGuestId: true,
    stayDate: true,
    roomId: true,
    message: true,
  },
  focusedBooking: { id: true, checkIn: true, checkOut: true },
  scopedLodgeId: true,
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The GET and PUT answer the lodge's effective settings, and where they come from. */
export const ADMIN_BED_ALLOCATION_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<{
  settings: EffectiveBedAllocationSettings;
}>({
  settings: { autoAllocationEnabled: true, allocationPriorityOrder: true, source: true, updatedAt: true },
});

// ---------------------------------------------------------------------------
// Rooms and beds
// ---------------------------------------------------------------------------

const INVENTORY_ROOM_SHAPE = {
  id: true,
  name: true,
  sortOrder: true,
  active: true,
  notes: true,
  beds: { id: true, name: true, sortOrder: true, active: true, bedType: true, bunkGroup: true },
} as const;

export const ADMIN_LODGE_ROOMS_CONNECTION_SHAPE = connectionShapeFor<RoomsAndBedsConfigurationPayload>({
  rooms: INVENTORY_ROOM_SHAPE,
  capacity: {
    capacity: true,
    source: true,
    bedAllocationEnabled: true,
    activeBedCount: true,
    fallbackCapacity: true,
    activeDoubleBedCount: true,
    partnerSharedHeadroom: true,
  },
  canImportFromConfig: true,
  configBeds: { id: true, name: true, capacity: true, type: true },
});

/** A room create, change or delete answers the room row. */
export const ADMIN_LODGE_ROOM_CONNECTION_SHAPE = connectionShapeFor<{ room: LodgeRoom }>({
  room: { id: true, name: true, sortOrder: true, active: true, notes: true, lodgeId: true },
});

export const ADMIN_LODGE_ROOMS_BULK_CONNECTION_SHAPE = connectionShapeFor<
  Awaited<ReturnType<typeof createBedAllocationRoomsBulk>>
>({
  createdRoomCount: true,
  createdBedCount: true,
});

export const ADMIN_LODGE_ROOMS_IMPORT_CONNECTION_SHAPE = connectionShapeFor<ImportRoomsAndBedsResult>({
  createdRoomCount: true,
  createdBedCount: true,
  rooms: INVENTORY_ROOM_SHAPE,
});

/** A bed create, change or delete answers the bed row. */
export const ADMIN_LODGE_BED_CONNECTION_SHAPE = connectionShapeFor<{ bed: LodgeBed }>({
  bed: { id: true, roomId: true, name: true, sortOrder: true, active: true, bedType: true, bunkGroup: true },
});

// ---------------------------------------------------------------------------
// Placing and moving guests
// ---------------------------------------------------------------------------

/** One guest placed for one night: the allocation row. */
export const ADMIN_BED_ALLOCATION_CONNECTION_SHAPE = connectionShapeFor<{ allocation: BedAllocation }>({
  allocation: {
    id: true,
    bookingId: true,
    bookingGuestId: true,
    roomId: true,
    bedId: true,
    stayDate: true,
    source: true,
    isSecondOccupant: true,
  },
});

/** An allocation row as the bulk placement and the older move send it. */
interface PlacedAllocationAnswer {
  id: string;
  bookingId: string;
  bookingGuestId: string;
  roomId: string;
  bedId: string;
  stayDate: string;
  source: BedAllocation["source"];
}

/** The bulk placement's answer, as the route builds it. */
export interface BedAllocationBulkAnswer {
  allocations: PlacedAllocationAnswer[];
  conflicts: Array<{ stayDate: string; reason: "BED_TAKEN" | "CUSTODIAN_HOLD" }>;
  skipped: string[];
}

export const ADMIN_BED_ALLOCATION_BULK_CONNECTION_SHAPE = connectionShapeFor<BedAllocationBulkAnswer>({
  allocations: { id: true, bookingId: true, bookingGuestId: true, roomId: true, bedId: true, stayDate: true, source: true },
  conflicts: { stayDate: true, reason: true },
  skipped: true,
});

/** The range report the route answers with: the result less the partner rows it audits. */
export type BedAllocationRangeAnswer = { result: Omit<AssignBedRangeResult, "promotedPartners"> };

export const ADMIN_BED_ALLOCATION_RANGE_CONNECTION_SHAPE = connectionShapeFor<BedAllocationRangeAnswer>({
  result: {
    applied: true,
    partialByConsent: true,
    bookingId: true,
    bookingGuestId: true,
    guestName: true,
    bedId: true,
    bedName: true,
    roomName: true,
    fromDate: true,
    toDate: true,
    requestedNights: true,
    freeNights: true,
    writtenNights: true,
    refusals: {
      stayDate: true,
      category: true,
      occupiedBy: { guestName: true, memberName: true, bookingId: true, holdsCapacity: true },
      hold: { bookingId: true, memberName: true, ownBooking: true },
    },
  },
});

const MOVE_DETAIL_SHAPE = {
  allocationId: true,
  stayDate: true,
  source: true,
  approved: true,
  sourceRoomName: true,
  sourceBedName: true,
} as const;

/** The move preview, with the `digest` the apply sends back. */
export const ADMIN_BED_ALLOCATION_MOVE_PREVIEW_CONNECTION_SHAPE = connectionShapeFor<BedAllocationMovePreview>({
  digest: true,
  scope: true,
  anchor: { allocationId: true, guestName: true, stayDate: true },
  destination: { bedId: true, label: true, available: true },
  resolvedRowCount: true,
  changedRowCount: true,
  unchangedRowCount: true,
  approvedToDraftCount: true,
  changed: MOVE_DETAIL_SHAPE,
  unchanged: MOVE_DETAIL_SHAPE,
  promotions: { stayDate: true, bedName: true },
  conflicts: { allocationId: true, stayDate: true, code: true, message: true },
});

export const ADMIN_BED_ALLOCATION_MOVE_CONNECTION_SHAPE = connectionShapeFor<BedAllocationMoveApplyResult>({
  noop: true,
  movedRowCount: true,
  promotedRowCount: true,
  affectedNights: true,
});

// ---------------------------------------------------------------------------
// Removing, approving and auto-allocating
// ---------------------------------------------------------------------------

/**
 * The removal preview, with the `digest` the apply sends back. Its `scope`
 * echo is dropped: the app sent it and sends it again to apply.
 */
export const ADMIN_BED_ALLOCATION_REMOVAL_PREVIEW_CONNECTION_SHAPE = connectionShapeFor<BedAllocationRemovalPreview>({
  digest: true,
  context: {
    lodgeId: true,
    lodgeName: true,
    from: true,
    to: true,
    bookingId: true,
    bookingGuestId: true,
    guestName: true,
    anchorNight: true,
  },
  categories: eachEntry(true),
  matchedRowCount: true,
  affectedBookingCount: true,
  affectedNights: true,
  promotions: {
    allocationId: true,
    bookingId: true,
    bookingGuestId: true,
    guestName: true,
    roomName: true,
    bedId: true,
    bedName: true,
    stayDate: true,
  },
  reopenedBookings: { bookingId: true, memberName: true },
});

export const ADMIN_BED_ALLOCATION_REMOVAL_CONNECTION_SHAPE = connectionShapeFor<BedAllocationRemovalApplyResult>({
  removedRowCount: true,
  promotedRowCount: true,
  affectedBookingCount: true,
  affectedNights: true,
});

export const ADMIN_BED_ALLOCATION_APPROVE_CONNECTION_SHAPE = connectionShapeFor<{ approvedCount: number }>({
  approvedCount: true,
});

export const ADMIN_BED_ALLOCATION_AUTO_ALLOCATE_CONNECTION_SHAPE = connectionShapeFor<{ createdCount: number }>({
  createdCount: true,
});
