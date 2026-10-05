/**
 * The wire shapes the bed-allocation board returns (#2688).
 *
 * Types only, so a client component can name one without pulling `prisma`,
 * `logger` or the audit writer into its bundle. Nothing here reads or writes.
 */
import type { BedType } from "@prisma/client";
import type {
  BedAllocationAgeTier,
  BedAllocationCandidate,
  UnallocatedGuestNight,
} from "@/lib/bed-allocation";
import type { BedAllocationSettingsPayload } from "@/lib/bed-allocation-admin-settings";

export interface AdminBedAllocationWarning {
  id: string;
  // BOOKING_SPLIT is same-night (party split across rooms on one night);
  // ROOM_SWITCH is stay-level (issue #1677) — the booking's room set changes
  // between nights, so someone must move rooms mid-stay. MINOR_ADULT_MIX
  // (#1768) flags a room-night where one booking's minors share the room with
  // another booking's adults — the planner never creates this, so it marks a
  // pre-existing or manual placement for the admin to resolve.
  // CUSTODIAN_BED_CONFLICT (#2286) is the NET behind the app-code exclusion
  // (owner decision, option (a)): an allocation row sitting on a bed-night a
  // custodian holds. The guards make it unreachable through the app, so a row
  // here means direct SQL, a pre-#2286 row, or the one accepted deploy-drain
  // exposure (an old-colour admin allocation path has no custodian check for
  // the seconds-to-minutes of a drain). Surfacing it is what makes that
  // exposure acceptable — see docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.
  type:
    | "BOOKING_SPLIT"
    | "MINOR_WITHOUT_BOOKING_ADULT"
    | "ROOM_SWITCH"
    | "MINOR_ADULT_MIX"
    | "CUSTODIAN_BED_CONFLICT";
  severity: "warning";
  bookingId: string;
  bookingGuestId?: string;
  stayDate: string;
  roomId?: string;
  message: string;
}

export interface DashboardRoom {
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

export interface DashboardBooking {
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

export interface DashboardAllocation {
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
  isSecondOccupant?: boolean;
  // Raw booking status (issue #1251), kept for display/debugging.
  bookingStatus: string;
  // Server-computed "Held" vs "Provisional" signal (#1254). Holding is no longer
  // a pure function of status (an accepted-but-unpaid quote is PENDING but holds),
  // so the board reads this precomputed flag from bookingHoldsCapacity().
  holdsCapacity: boolean;
}

export interface DashboardGuestNight {
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

// A custodian bed hold overlapping the board's range (#2286): a bed held for a
// season by a hut-leader assignment, with NO booking and NO BedAllocation row
// anywhere. The board renders it as a non-allocatable band across that bed's
// cells and refuses any drop onto it.
export interface DashboardCustodianHold {
  assignmentId: string;
  memberName: string;
  bedId: string;
  bedName: string;
  roomId: string;
  roomName: string;
  /** The hold's own inclusive range, so the tooltip can state the whole season. */
  startDate: string;
  endDate: string;
  /** The held nights that fall within the board's current date range. */
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
  // Custodian bed holds overlapping the range (#2286). Additive, following the
  // exclusiveHolds precedent: the board draws a hatched non-allocatable band on
  // those bed-nights and the server 409s any drop regardless.
  custodianHolds: DashboardCustodianHold[];
  /** Anonymous school adults reserve capacity but cannot be assigned a bed until named. */
  pendingAdultReservations: Array<{ bookingId: string; night: string; adultCount: number }>;
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
