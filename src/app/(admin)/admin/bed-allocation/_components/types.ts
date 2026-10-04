// Mirrors the Prisma BedType enum (#1675). Kept as a local union so the board
// components need no @prisma/client import.
export type BedType = "SINGLE" | "BUNK_TOP" | "BUNK_BOTTOM" | "DOUBLE";

interface DashboardBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  active: boolean;
  // Descriptive bed type (#1675); does not affect capacity.
  bedType: BedType;
  // Pairing label within a room (one top + one bottom max); null when unpaired.
  bunkGroup: string | null;
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
  // Raw booking status (#1251), kept for display/debugging.
  bookingStatus: string;
  // Server-computed "does this booking hold capacity" flag (#1254). Because
  // holding is no longer a pure function of status (an accepted-but-unpaid quote
  // is PENDING but holds), the board reads this precomputed flag —
  // bookingHoldsCapacity() — for the "Held" vs "Provisional" badge.
  holdsCapacity: boolean;
  // #1701: the second occupant of a shared DOUBLE bed (declared partners). The
  // board renders both occupants of a double in one cell and marks this one.
  isSecondOccupant: boolean;
}

export interface DashboardGuestNight {
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: string;
  memberName: string;
  stayDate: string;
}

interface DashboardRequestedRoom {
  id: string;
  name: string;
  active: boolean;
}

export interface DashboardBookingSummary {
  id: string;
  status: string;
  // Server-computed capacity-holding flag (#1254); see DashboardAllocation.
  holdsCapacity: boolean;
  createdAt: string;
  checkIn: string;
  checkOut: string;
  memberName: string;
  // Preferred room requested at booking time (#706). Inactive rooms are
  // surfaced as a warning chip rather than treated as a preference.
  requestedRoom: DashboardRequestedRoom | null;
  // Split-booking group link (#738). Set on the provisional non-member child;
  // null on the member booking and on un-split bookings.
  parentBookingId: string | null;
  // Exclusive whole-lodge hold on THIS booking (ADR-001, #120): shown as a
  // board banner, never in the awaiting-allocation bucket.
  wholeLodgeHold: boolean;
  // This ordinary booking overlaps another booking's exclusive hold (#119):
  // badge it so staff see the clash.
  overlapsExclusiveHold: boolean;
  // Per-guest stay windows (stayEnd exclusive). Always present in the dashboard
  // payload; optional here because the board only reads it to prefill the
  // range-assign dialog with the GUEST's own stay (#2251) — a guest who joins
  // late or leaves early must not be handed the booking's wider envelope, which
  // would refuse as "guest not booked" on the nights outside their stay.
  guests?: Array<{ id: string; stayStart: string; stayEnd: string }>;
}

// An exclusive whole-lodge hold overlapping the board range (ADR-001, #120):
// no per-bed allocation is needed — it implicitly occupies every bed.
export interface DashboardExclusiveHold {
  bookingId: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  nights: string[];
}

// A custodian bed hold overlapping the board's range (#2286): a bed held for a
// season by a hut-leader assignment, with no booking anywhere. Rendered as a
// hatched non-allocatable band rather than a chip — nobody is booked in.
export interface DashboardCustodianHold {
  assignmentId: string;
  memberName: string;
  bedId: string;
  bedName: string;
  roomId: string;
  roomName: string;
  startDate: string;
  endDate: string;
  nights: string[];
}

interface DashboardWarning {
  id: string;
  // ROOM_SWITCH (#1677) is stay-level: the booking's rooms change mid-stay.
  // CUSTODIAN_BED_CONFLICT (#2286) means an allocation row is sitting on a
  // custodian-held bed-night — unreachable through the guarded app paths, so it
  // always wants an admin's eyes.
  type:
    | "BOOKING_SPLIT"
    | "MINOR_WITHOUT_BOOKING_ADULT"
    | "ROOM_SWITCH"
    | "CUSTODIAN_BED_CONFLICT";
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
  // Exclusive whole-lodge holds overlapping the range (#120): their guests are
  // absent from unallocatedGuestNights — shown as a banner instead.
  exclusiveHolds: DashboardExclusiveHold[];
  // Custodian bed holds overlapping the range (#2286): the board draws a
  // hatched, non-droppable band across those bed-nights. The server refuses any
  // drop regardless, so this is presentation, not the enforcement.
  custodianHolds: DashboardCustodianHold[];
  pendingAdultReservations?: Array<{ bookingId: string; night: string; adultCount: number }>;
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
  // Stay window of a deep-linked focused booking (?bookingId=…) when it is out
  // of the current range; lets the board snap Date In / Date Out onto it (#1302).
  focusedBooking: { id: string; checkIn: string; checkOut: string } | null;
  // #2701: the lodge this payload was ACTUALLY scoped to — derived from the
  // focused booking when one is named, otherwise the requested lodge, and null
  // for a deliberate club-wide read. The board adopts it so the selector, the
  // data and the focused booking cannot disagree. Optional on the wire for the
  // same reason `custodianHolds` is read tolerantly: during a deploy drain a
  // new-colour bundle can be served an old-colour payload that has no such
  // field, and an absent value must read as "the server did not say" (no
  // adoption), never as a club-wide answer.
  scopedLodgeId?: string | null;
}

/**
 * Why every lodge-dependent allocation control on the board is disabled, or
 * `undefined` when they are live (#2701).
 *
 * Threaded down beside `canEdit` rather than folded into it: the two are
 * different refusals with different fixes — a view-only role cannot be fixed
 * from this screen, a club-wide board is fixed by choosing a lodge — and
 * collapsing them would put the wrong explanation on the control.
 */
export type AllocationLockReason = string | undefined;

/**
 * The club-wide board is a read-only overview, not an allocation workspace
 * (#2701 owner decision 4). One sentence, shown once at the top of the board
 * and reused as the tooltip on each control it disables, rather than scattering
 * unexplained disabled states.
 */
export const ALL_LODGES_ALLOCATION_LOCK_REASON =
  "Allocation changes need one lodge selected. This board is showing every lodge, so it is read-only.";

/**
 * The other state with no concrete lodge (#2701): the board has data — because
 * a deep-linked booking scoped it server-side — but has not been told which
 * lodge that was yet, or the lodge list failed and there is nothing to select.
 *
 * Distinct from the club-wide reason on purpose: nobody chose this, so telling
 * the admin to "choose a lodge instead" would be wrong. It exists because
 * "Remove allocation" is otherwise a clickable silent no-op in exactly this
 * state (owner decision 6) — its handler needs a lodge and simply returns.
 */
export const UNSCOPED_ALLOCATION_LOCK_REASON =
  "The board is still settling on this booking's lodge. Allocation changes become available once it has.";

/**
 * A role that may open this board but may not read the lodge list — shipped
 * `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` both hold `bookings: "view"` and no
 * `lodge` entry. Club-wide read-only is the only view they can have, and it is
 * the view they had before #2701; saying "choose a lodge" to someone who has no
 * way to choose one would be worse than saying nothing.
 */
export const NO_LODGE_PERMISSION_ALLOCATION_LOCK_REASON =
  "Your admin role cannot choose a lodge, so this board shows every lodge and is read-only.";

/**
 * The lodge list genuinely failed. Distinct from the club-wide reasons because
 * a retry can fix it, and distinct from the settling reason because this one
 * does NOT clear by itself (PR #2885 review, LOW).
 */
export const LODGE_LIST_FAILED_ALLOCATION_LOCK_REASON =
  "The lodge list could not be loaded, so allocation changes are unavailable until it is.";

/** The list loaded and the club has no active lodge to allocate against. */
export const NO_ACTIVE_LODGE_ALLOCATION_LOCK_REASON =
  "This club has no active lodge, so there is nothing to allocate beds in.";

export interface BedOption {
  id: string;
  roomId: string;
  roomName: string;
  bedName: string;
  label: string;
}

export interface BedOptionGroup {
  roomId: string;
  roomName: string;
  beds: BedOption[];
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
  // CUSTODIAN_HOLD (#2286): the bed is held for a custodian on that night. Kept
  // distinct from BED_TAKEN because the admin's fix is a different page.
  reason: "BED_TAKEN" | "CUSTODIAN_HOLD";
}
