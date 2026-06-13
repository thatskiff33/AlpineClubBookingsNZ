export interface DashboardBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface DashboardRoom {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  notes: string | null;
  beds: DashboardBed[];
}

export interface DashboardAllocation {
  id: string;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: string;
  roomId: string;
  roomName: string;
  bedId: string;
  bedName: string;
  stayDate: string;
  source: "AUTO" | "MANUAL";
  approvedAt: string | null;
  approvedByName: string | null;
}

export interface DashboardGuestNight {
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: string;
  memberName: string;
  stayDate: string;
}

export interface DashboardRequestedRoom {
  id: string;
  name: string;
  active: boolean;
}

export interface DashboardBookingSummary {
  id: string;
  status: string;
  createdAt: string;
  checkIn: string;
  checkOut: string;
  memberName: string;
  // Preferred room requested at booking time (#706). Inactive rooms are
  // surfaced as a warning chip rather than treated as a preference.
  requestedRoom: DashboardRequestedRoom | null;
}

export interface DashboardWarning {
  id: string;
  type: "BOOKING_SPLIT" | "MINOR_WITHOUT_BOOKING_ADULT";
  bookingId: string;
  bookingGuestId?: string;
  stayDate: string;
  roomId?: string;
  message: string;
}

export interface DashboardPayload {
  settings: {
    autoAllocationEnabled: boolean;
    updatedAt: string | null;
    updatedByMemberId: string | null;
  };
  range: { fromDate: string; toDate: string };
  rooms: DashboardRoom[];
  bookings: DashboardBookingSummary[];
  allocations: DashboardAllocation[];
  unallocatedGuestNights: DashboardGuestNight[];
  suggestedAllocations: Array<{
    bookingId: string;
    bookingGuestId: string;
    roomId: string;
    bedId: string;
    stayDate: string;
  }>;
  suggestedUnallocatedGuestNights: Array<{
    bookingId: string;
    bookingGuestId: string;
    stayDate: string;
    reason: string;
  }>;
  warnings: DashboardWarning[];
}

export interface BedOption {
  id: string;
  roomId: string;
  roomName: string;
  bedName: string;
  label: string;
}

export interface BucketGuestGroup {
  bookingGuestId: string;
  bookingId: string;
  guestName: string;
  guestAgeTier: string;
  memberName: string;
  stayDates: string[];
}

export const BUCKET_DROPPABLE_ID = "bucket";

export function cellDroppableId(bedId: string, stayDate: string) {
  return `cell:${bedId}:${stayDate}`;
}

export function bucketDraggableId(bookingGuestId: string) {
  return `bucket-guest:${bookingGuestId}`;
}

export function allocationDraggableId(allocationId: string) {
  return `allocation:${allocationId}`;
}

export type DragData =
  | {
      type: "bucket-guest";
      bookingGuestId: string;
    }
  | {
      type: "allocation";
      allocationId: string;
    };

export type DropData =
  | {
      type: "cell";
      bedId: string;
      roomId: string;
      stayDate: string;
    }
  | {
      type: "bucket";
    };

export interface BulkAllocationConflict {
  stayDate: string;
  reason: "BED_TAKEN";
}
