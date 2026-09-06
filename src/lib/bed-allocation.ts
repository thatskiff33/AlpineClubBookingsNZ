import type { AgeTier } from "@prisma/client";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { expandStayEnvelopeToNightKeys } from "@/lib/booking-guest-stay-ranges";
import {
  BED_ALLOCATION_PRIORITY_VOCABULARY,
  parseBedAllocationPriorityOrder,
  type BedAllocationPriority,
} from "@/lib/bed-allocation-settings";

type BedAllocationSource = "AUTO" | "MANUAL";
// Matches the DB enum so freshly-read guest rows type-check. Guests are
// people, so NOT_APPLICABLE (the organisation tier, #1440) cannot enter
// through validated inputs; if legacy data ever carries it, the guest is
// simply grouped as a non-adult by isAdultAgeTier.
export type BedAllocationAgeTier = AgeTier;

interface BedAllocationBed {
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
  // The lodge this room belongs to. A null lodgeId during the expand release
  // (rooms written before the backfill, or by a draining old colour) is
  // treated as club-wide-compatible. Used by roomsForBooking so a booking's
  // guests can never land in another lodge's beds, even when the caller pools
  // multiple lodges' rooms (club-wide auto-allocation).
  lodgeId?: string | null;
  beds: BedAllocationBed[];
}

interface BedAllocationGuest {
  id: string;
  bookingId: string;
  stayStart: Date;
  stayEnd: Date;
  ageTier?: BedAllocationAgeTier | null;
  /** Canonical BookingGuestNight rows. Present (including []) beats envelopes. */
  nights?: Array<string | Date>;
  /** Direct canonical FamilyGroup memberships for the linked registered guest. */
  familyGroupIds?: string[];
}

export interface BedAllocationBooking {
  id: string;
  createdAt: Date;
  // The lodge this booking belongs to (ADR-001: one booking = one lodge). Null
  // during the expand release stays club-wide-compatible. roomsForBooking uses
  // it to restrict the booking to its own lodge's rooms.
  lodgeId?: string | null;
  guests: BedAllocationGuest[];
  /**
   * Preferred room from the booking's room request, if any. Auto-allocation
   * tries this room first before falling back to family-grouping and
   * first-fit. A missing/inactive room (filtered out of `activeRooms`) is
   * treated as no preference — never an error.
   */
  requestedRoomId: string | null;
  /**
   * Whether this booking holds lodge capacity (issue #1387). Only meaningful
   * when `prioritizeCapacityHolding` is set: capacity-holding bookings are
   * allocated FIRST and may displace a provisional occupant to claim a bed;
   * provisional bookings never displace anyone. Undefined is treated as
   * non-holding, preserving the pure first-fit order for callers that do not
   * classify bookings.
   */
  holdsCapacity?: boolean;
  /**
   * School/organisation booking (#1768): derived by the loaders from the
   * booking's origin/held BookingRequest type (SCHOOL, #709). The split
   * fallback then groups the booking's adults together and its minors
   * separately (students in their own rooms), instead of the family
   * one-adult-per-room pairing. Undefined = family behaviour.
   */
  isSchoolGroup?: boolean;
}

interface OccupiedBedNight {
  bedId: string;
  stayDate: string | Date;
  bookingId?: string | null;
  bookingGuestId?: string | null;
  roomId?: string | null;
  ageTier?: BedAllocationAgeTier | null;
  familyGroupIds?: string[];
  /** Read-only booking context used when a provisional occupant is relocated. */
  bookingRequestedRoomId?: string | null;
  /** Read-only SCHOOL classification used to preserve separation on relocation. */
  bookingIsSchoolGroup?: boolean;
  /**
   * Whether the occupying booking holds lodge capacity (issue #1387). Only
   * consulted when `prioritizeCapacityHolding` is set. A capacity-holding
   * occupant (true) is NEVER displaced; a provisional occupant (false) may be
   * moved aside or unallocated to make room for a capacity-holding booking.
   * Undefined is treated as non-displaceable (conservative), so a caller that
   * does not classify occupants can never trigger a displacement.
   */
  holdsCapacity?: boolean;
  /**
   * When set, this allocation was explicitly APPROVED by an admin (the #776
   * bed-lock). An approved allocation is NEVER displaced (issue #1387) — moving
   * or unallocating it would silently undo an admin lock with no human step —
   * and, because displacement now operates on WHOLE provisional stays (issue
   * #1677), one approved night pins the occupying booking's entire stay.
   */
  approvedAt?: Date | string | null;
  /**
   * createdAt of the occupying booking (issue #1677). Used to pick the
   * displacement order when a capacity-holding booking must evict provisional
   * stays from a room: newest provisional bookings are evicted first. Optional;
   * a missing value sorts as oldest, so unclassified occupants are evicted
   * last.
   */
  bookingCreatedAt?: Date | string | null;
  /**
   * True when the occupying booking's stay extends beyond the window the
   * caller loaded (issue #1677). Displacement moves or unallocates a
   * provisional booking's ENTIRE stay; a stay that is only partially visible
   * cannot be moved whole, so it is treated as non-displaceable — mirroring
   * the conservative `holdsCapacity: undefined → non-displaceable` default.
   */
  stayExtendsBeyondWindow?: boolean;
}

type BedAllocationDisplacementType = "MOVE" | "UNALLOCATE";

/**
 * A provisional bed-night that auto-allocation displaced so a capacity-holding
 * booking could claim the bed (issue #1387). `MOVE` relocates the provisional
 * allocation to a still-free bed (`toBedId`/`toRoomId`); `UNALLOCATE` removes
 * it entirely, returning the guest-night to the awaiting-allocation queue. The
 * lifecycle applies these (update / delete) BEFORE creating the new
 * capacity-holding allocations so no transient `@@unique([bedId, stayDate])`
 * conflict occurs, and writes an audit row for each.
 *
 * Since issue #1677 the displacement UNIT is a provisional booking's whole
 * stay: within one plan a displaced booking's records are either all MOVEs
 * into ONE destination room or all UNALLOCATEs — a provisional stay is never
 * night-split, and MOVE/UNALLOCATE are never mixed for one booking.
 */
export interface BedAllocationDisplacement {
  type: BedAllocationDisplacementType;
  /** The displaced PROVISIONAL booking / guest-night (identifies the row). */
  bookingId: string;
  bookingGuestId: string;
  stayDate: string;
  /** The bed the provisional occupant originally held (for the audit trail). */
  fromBedId: string;
  fromRoomId: string;
  /** Destination bed for a MOVE; absent for UNALLOCATE. */
  toBedId?: string;
  toRoomId?: string;
  /** The capacity-holding booking that claimed the freed bed (audit trail). */
  displacedByBookingId: string;
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
  allocationPriorityOrder?: BedAllocationPriority[];
  /**
   * When true (issue #1387, the lifecycle auto-allocation path), capacity-
   * holding bookings are allocated before provisional ones and may displace
   * provisional occupants — relocating each displaced booking's WHOLE stay to
   * one other room, else unallocating the whole stay (issue #1677) — to claim
   * the beds a provisional booking is blocking. A capacity-holding occupant is
   * never displaced. Default false emits no displacements, so the admin board
   * preview and any other caller stay displacement-free.
   */
  prioritizeCapacityHolding?: boolean;
  /**
   * Reports an internal bookkeeping divergence the planner detected while
   * building this plan (#2656). The hard throw stays TEST-ONLY: a live lodge
   * must not get a 500 mid-booking over a diagnostic. Production callers pass a
   * callback so the divergence is logged and breadcrumbed instead of being
   * silently carried, which is what it was before.
   *
   * This module is pure and deterministic — no logger, no Sentry, no clock — so
   * the reporting itself belongs to the caller. `bed-allocation-lifecycle.ts`
   * and `bed-allocation-board.ts` already have a logger and wire this up; the
   * callback must not throw.
   */
  onInvariantViolation?: (message: string) => void;
}

export interface BedAllocationPlan {
  allocations: BedAllocationCandidate[];
  unallocatedGuestNights: UnallocatedGuestNight[];
  /**
   * Provisional bed-nights displaced so capacity-holding bookings could claim a
   * bed (issue #1387). Present ONLY when at least one displacement occurred, so
   * existing callers/tests that compare the whole plan are unaffected.
   */
  displacements?: BedAllocationDisplacement[];
  /**
   * Bookings for which no single room could host the whole remaining stay —
   * neither in free space nor (for capacity-holding bookings) via displacement
   * — so the plan fell back to the legacy per-night split logic (issue #1677,
   * Phase 3). Present ONLY when at least one booking fell back, mirroring
   * `displacements`.
   */
  roomContinuityFallbackBookingIds?: string[];
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

/**
 * The CAPACITY key: one physical bed on one night. Answers exactly one
 * question — "is this bed-night unavailable?" — and nothing else. A shared
 * DOUBLE (#1701) legitimately holds two occupant rows on this one key, so the
 * key can never identify WHO is there; use {@link occupantSlotKey} for that
 * (#2656).
 */
function occupiedKey(bedId: string, stayDate: string) {
  return `${bedId}:${stayDate}`;
}

/**
 * The IDENTITY key: one occupant of one bed-night (#2656). A double bed may
 * hold two occupants on the same night — possibly from two DIFFERENT bookings,
 * via a `MemberPartnerLink` — so the occupant view must not collapse them onto
 * the bed-night key; the second would silently overwrite the first, leaving one
 * map entry for two database rows.
 *
 * `bookingGuestId` is the discriminator rather than `isSecondOccupant`: it is
 * already present on every row that reaches the planner (`OccupiedBedNight`
 * carries no `isSecondOccupant`, and the seed loop skips occupant tracking
 * entirely without a booking/guest id), and `@@unique([bookingGuestId,
 * stayDate])` makes it exactly as discriminating — one guest can hold at most
 * one bed on a night, so a guest id plus a night names one slot.
 */
function occupantSlotKey(
  bedId: string,
  stayDate: string,
  bookingGuestId: string,
) {
  return `${bedId}:${stayDate}:${bookingGuestId}`;
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

// Lodge isolation, enforced at the matcher itself (defence in depth): a
// booking may only be placed in rooms at its own lodge, so cross-lodge
// allocation is impossible even when the caller pools several lodges' rooms
// (club-wide auto-allocation). Null-tolerant during the expand release — a
// booking or room with a null lodgeId is club-wide-compatible, mirroring
// lodgeNullTolerantScope. Manual allocation already enforces this server-side;
// this closes the same guarantee for the auto/first-fit path.
function roomsAtLodge(
  rooms: SortedRoomWithBeds[],
  lodgeId: string | null | undefined,
): SortedRoomWithBeds[] {
  if (lodgeId == null) return rooms;
  return rooms.filter(
    (room) => room.lodgeId == null || room.lodgeId === lodgeId,
  );
}

/**
 * Returns `rooms` lodge-scoped and reordered so the booking's requested room
 * (if active and present) is tried first. If there is no request, or the
 * requested room is not in `rooms` (inactive, deleted, or never set), the
 * lodge-scoped order is returned unchanged — the request is silently treated
 * as no preference.
 */
function roomsForBooking(
  rooms: SortedRoomWithBeds[],
  booking: BedAllocationBooking,
): SortedRoomWithBeds[] {
  return roomsAtLodge(rooms, booking.lodgeId);
}

/**
 * The nights one planner guest entry demands a bed on.
 *
 * TWO THINGS HERE ARE LOAD-BEARING AND NEITHER IS OBVIOUS FROM THE CALL SITE.
 *
 * 1. `guest.nights !== undefined` — an explicitly EMPTY list means "this entry
 *    demands nothing", not "fall back to the envelope". Both real callers build
 *    their entries from `BookingGuestNight` rows, so a guest with no rows must
 *    contribute no demand; falling back would have the planner place a guest the
 *    lifecycle then sweeps straight back off the board. That is why this is not
 *    `getGuestBedNightKeys`, whose empty-set branch is the envelope.
 *
 * 2. The envelope branch is HALF-OPEN, and must stay half-open. This function is
 *    fed ONE PSEUDO-GUEST PER NIGHT — `candidateGuestBookings` in
 *    `bed-allocation-board-records.ts` emits `stayStart = night`, `stayEnd = night + 1`
 *    for every unallocated guest-night. An inclusive envelope gives each of them
 *    a phantom second night and the planner claims the morning-after bed, which
 *    is a double booking (#2628). `expandStayEnvelopeToNightKeys` is the single
 *    definition of that expansion and says the same thing at greater length.
 */
function guestStayNights(guest: BedAllocationGuest): string[] {
  if (guest.nights !== undefined) {
    return [...new Set(guest.nights.map(normalizeStayDate))].sort();
  }
  return expandStayEnvelopeToNightKeys(guest.stayStart, guest.stayEnd);
}

export function isAdultAgeTier(ageTier?: BedAllocationAgeTier | null): boolean {
  return !ageTier || ageTier === "ADULT";
}

/** A booking guest reduced to what per-night placement needs. */
interface PartyGuest {
  id: string;
  ageTier?: BedAllocationAgeTier | null;
  familyGroupIds?: string[];
}

/** A party guest with the (sorted, date-only) nights it still needs a bed on. */
interface StayGuest extends PartyGuest {
  nights: string[];
}

/**
 * A booking's remaining whole-stay demand (issue #1677): the still-unallocated
 * guests, the union of their nights, and the demanded guests per night. Built
 * from per-night pseudo-guest entries or contiguous ranges alike — both caller
 * shapes group to the same structure.
 */
interface BookingStayDemand {
  guests: StayGuest[];
  nights: string[];
  guestsByNight: Map<string, StayGuest[]>;
}

function isAdultGuest(guest: PartyGuest): boolean {
  return isAdultAgeTier(guest.ageTier);
}

/** Stable adults-first ordering for bed assignment and displacement passes. */
function adultsFirst<T extends PartyGuest>(guests: T[]): T[] {
  return [...guests].sort(
    (a, b) => Number(isAdultGuest(b)) - Number(isAdultGuest(a)),
  );
}

/**
 * Groups a booking's guest entries by guest id into whole-stay night sets
 * (issue #1677). Both callers feed the planner per-night pseudo-guests (the
 * same guest id repeated once per missing night), so grouping restores the
 * whole-stay view; contiguous stayStart/stayEnd ranges expand to the same
 * shape. Non-contiguous #713 stays arrive naturally as gapped night sets.
 * Guest order is first-appearance input order (deterministic).
 */
function groupBookingGuests(booking: BedAllocationBooking): StayGuest[] {
  const nightSets = new Map<string, Set<string>>();
  const ageTiers = new Map<string, BedAllocationAgeTier | null | undefined>();
  const familyGroups = new Map<string, string[]>();
  const order: string[] = [];

  for (const guest of booking.guests) {
    let nights = nightSets.get(guest.id);
    if (!nights) {
      nights = new Set();
      nightSets.set(guest.id, nights);
      ageTiers.set(guest.id, guest.ageTier);
      familyGroups.set(guest.id, [...new Set(guest.familyGroupIds ?? [])].sort());
      order.push(guest.id);
    }
    for (const night of guestStayNights(guest)) {
      nights.add(night);
    }
  }

  return order.map((id) => ({
    id,
    ageTier: ageTiers.get(id),
    familyGroupIds: familyGroups.get(id) ?? [],
    nights: [...(nightSets.get(id) ?? [])].sort(),
  }));
}

function buildStayDemand(guests: StayGuest[]): BookingStayDemand {
  const withNights = guests.filter((guest) => guest.nights.length > 0);
  const nightSet = new Set<string>();
  for (const guest of withNights) {
    for (const night of guest.nights) nightSet.add(night);
  }
  const nights = [...nightSet].sort();
  const guestsByNight = new Map<string, StayGuest[]>();
  for (const night of nights) {
    guestsByNight.set(
      night,
      withNights.filter((guest) => guest.nights.includes(night)),
    );
  }
  return { guests: withNights, nights, guestsByNight };
}

/**
 * A live view of one existing allocation row (issue #1677). Displacement moves
 * whole bookings, so the planner tracks every known occupant row per booking
 * and keeps the view current as displacements relocate rows within a run.
 */
interface OccupantInfo {
  bookingId: string;
  bookingGuestId: string;
  roomId: string;
  bedId: string;
  stayDate: string;
  ageTier?: BedAllocationAgeTier | null;
  familyGroupIds: string[];
  bookingRequestedRoomId: string | null;
  bookingIsSchoolGroup: boolean;
  holdsCapacity: boolean;
  /** Admin-approved (#776 lock): pins the whole booking (issues #1387/#1677). */
  isApproved: boolean;
  /** Occupying booking's createdAt (ms) — newest-first eviction order. 0 = unknown/oldest. */
  bookingCreatedAtMs: number;
  /** Stay extends beyond the loaded window → whole-stay move impossible → pinned. */
  stayExtendsBeyondWindow: boolean;
}

interface RoomNightAgeCounts {
  adults: number;
  minors: number;
}

interface PlannerState {
  activeRooms: SortedRoomWithBeds[];
  /** Every active bed (all rooms) — the NO_ACTIVE_BEDS vs NO_BED_AVAILABLE signal. */
  allBeds: BedAllocationBed[];
  /**
   * CAPACITY, keyed `bedId:stayDate` ({@link occupiedKey}): the bed-nights that
   * are unavailable to a new placement, whoever is in them. One entry per
   * physical bed-night — a shared DOUBLE holding two occupants is ONE entry
   * here, and stays occupied until the LAST of them leaves (#2656). Never ask
   * this set who is present; that is {@link PlannerState.occupantBySlot}.
   */
  occupied: Set<string>;
  /**
   * The occupancy at plan start — the DATABASE state (never mutated). MOVE
   * destinations must have been free here (or be the moving guest's own
   * current bed): the lifecycle applies displacements one row at a time
   * against `@@unique([bedId, stayDate])`, so a MOVE onto a bed another
   * displaced row has not yet vacated would conflict mid-apply. Restricting
   * targets to plan-start-free beds makes the apply order-independent.
   */
  occupiedAtStart: Set<string>;
  /**
   * Bed-nights taken by an occupancy with NO booking behind it — a custodian
   * bed hold (#2286) or an exclusive whole-lodge hold (#2317). These keys are
   * occupied for the whole run and can never be released.
   *
   * Why a second set rather than relying on "there is no row to move": the
   * `occupied` key is `bedId:stayDate`, so a synthesised hold row and a real
   * `BedAllocation` row on the SAME bed-night collapse to ONE entry. Evicting
   * the real row (#1677 provisional displacement) used to delete that shared
   * entry and hand the held bed to the incoming booking — the hold's occupancy
   * was displaced by proxy even though it owns no row. Keeping the key here and
   * teaching `evictBooking` (and the two paths that pick eviction candidates
   * from the occupant view rather than from `occupied`) to respect it is what
   * makes "non-displaceable" true of the bed-night rather than only of the row.
   *
   * Since #2656 the SAME hazard between two REAL rows on a shared double is
   * handled structurally instead, by `occupantSlotsByBedNight`: eviction
   * releases a bed-night only once no occupant slot remains on it. This set
   * stays for the case that owns no row at all — an occupancy with no booking
   * behind it, which no slot bookkeeping can represent.
   */
  permanentlyOccupied: Set<string>;
  /**
   * IDENTITY, keyed `bedId:stayDate:bookingGuestId` ({@link occupantSlotKey}):
   * WHO is in each occupied bed-night. One entry per known occupant ROW, so a
   * shared DOUBLE (#1701) holding two occupants — possibly from two different
   * bookings — is two entries here against one `occupied` entry (#2656).
   *
   * Only rows the planner can attribute to a booking guest live here: an
   * attribution-less hold has no slot (it is pinned in `permanentlyOccupied`
   * instead), and this run's own new AUTO allocations live in `allocations`.
   * That is why the test-only recount sums all three.
   */
  occupantBySlot: Map<string, OccupantInfo>;
  /**
   * The reverse index of `occupantBySlot`: bed-night key → the occupant slots
   * currently on it (#2656). This is what makes "is anyone still in this bed?"
   * answerable after ONE occupant of a shared double is evicted, which is what
   * keeps `evictBooking` from freeing a bed-night whose other occupant's row is
   * still in the database. Deep-cloned with the state — sharing the inner Sets
   * across a discarded trial would leak occupancy between strategies.
   */
  occupantSlotsByBedNight: Map<string, Set<string>>;
  occupantsByBooking: Map<string, Map<string, OccupantInfo>>;
  allocatedGuestNights: Set<string>;
  allocations: BedAllocationCandidate[];
  unallocatedGuestNights: UnallocatedGuestNight[];
  displacementByGuestNight: Map<string, BedAllocationDisplacement>;
  /**
   * Live room-night age composition (#1768): roomId|date → bookingId →
   * {adults, minors}, maintained at every occupancy COMMIT (seeding, new
   * allocations, evictions, relocation re-adds) and never inside trial or
   * rollback paths. Backs the owner's hard invariant: a room-night holding
   * minors from booking X never also holds an adult from a different booking
   * — in either placement direction. Occupant rows without a bookingId are
   * keyed "" (unknown): they can never be evicted, and an unknown row with no
   * age tier counts as an adult (blocking minors, not adults — conservative).
   */
  roomNightAgeMix: Map<string, Map<string, RoomNightAgeCounts>>;
  /**
   * Seed-only snapshot of the unknown (no-bookingId) occupant rows, kept so
   * the test-only recount assertion can rebuild the composition index from
   * scratch. Never mutated after seeding.
   */
  unknownRoomNightRows: Array<{
    roomId: string;
    stayDate: string;
    isAdult: boolean;
  }>;
  allocationPriorityOrder: BedAllocationPriority[];
  bookingById: Map<string, BedAllocationBooking>;
}

function roomNightMixKey(roomId: string, stayDate: string) {
  return `${roomId}:${stayDate}`;
}

/**
 * Adjusts the live composition index for one occupant row (#1768). `delta`
 * is +1 on commit (seed, allocation, relocation re-add) and -1 on eviction.
 * Rows whose room cannot be resolved are skipped — they cannot collide with
 * planner placements, which only ever use active-room beds.
 */
function trackRoomNightOccupant(
  state: PlannerState,
  roomId: string,
  stayDate: string,
  bookingId: string | null,
  ageTier: BedAllocationAgeTier | null | undefined,
  delta: 1 | -1,
) {
  if (!roomId) return;
  const key = roomNightMixKey(roomId, stayDate);
  const bookingKey = bookingId ?? "";
  let byBooking = state.roomNightAgeMix.get(key);
  if (!byBooking) {
    if (delta < 0) return;
    byBooking = new Map();
    state.roomNightAgeMix.set(key, byBooking);
  }
  let counts = byBooking.get(bookingKey);
  if (!counts) {
    if (delta < 0) return;
    counts = { adults: 0, minors: 0 };
    byBooking.set(bookingKey, counts);
  }
  if (isAdultAgeTier(ageTier)) {
    counts.adults += delta;
  } else {
    counts.minors += delta;
  }
  if (counts.adults <= 0 && counts.minors <= 0) {
    byBooking.delete(bookingKey);
    if (byBooking.size === 0) state.roomNightAgeMix.delete(key);
  }
}

/**
 * Whether placing a MINOR of `bookingId` into this room-night would break the
 * cross-booking invariant (#1768): true when any OTHER booking (or an unknown
 * occupant) holds an adult there.
 */
function roomNightBlocksMinors(
  state: PlannerState,
  roomId: string,
  stayDate: string,
  bookingId: string,
): boolean {
  const byBooking = state.roomNightAgeMix.get(roomNightMixKey(roomId, stayDate));
  if (!byBooking) return false;
  for (const [key, counts] of byBooking) {
    if (key !== bookingId && counts.adults > 0) return true;
  }
  return false;
}

/**
 * Whether placing an ADULT of `bookingId` into this room-night would break the
 * cross-booking invariant (#1768): true when any OTHER booking (or an unknown
 * occupant) holds a minor there.
 */
function roomNightBlocksAdults(
  state: PlannerState,
  roomId: string,
  stayDate: string,
  bookingId: string,
): boolean {
  const byBooking = state.roomNightAgeMix.get(roomNightMixKey(roomId, stayDate));
  if (!byBooking) return false;
  for (const [key, counts] of byBooking) {
    if (key !== bookingId && counts.minors > 0) return true;
  }
  return false;
}

/**
 * The OTHER bookings (or "" for unknown occupants) contributing `tier` rows to
 * this room-night (#1768). The per-night displacement path may only evict its
 * way past a composition conflict when this list is exactly the one booking
 * being evicted.
 */
function otherRoomNightBookingsWith(
  state: PlannerState,
  roomId: string,
  stayDate: string,
  bookingId: string,
  tier: keyof RoomNightAgeCounts,
): string[] {
  const byBooking = state.roomNightAgeMix.get(roomNightMixKey(roomId, stayDate));
  if (!byBooking) return [];
  const conflicting: string[] = [];
  for (const [key, counts] of byBooking) {
    if (key !== bookingId && counts[tier] > 0) conflicting.push(key);
  }
  return conflicting;
}

/** Drops one occupant slot from the identity view. Touches no capacity state. */
function forgetOccupantSlot(
  state: PlannerState,
  bedId: string,
  stayDate: string,
  bookingGuestId: string,
) {
  const bedNight = occupiedKey(bedId, stayDate);
  const slot = occupantSlotKey(bedId, stayDate, bookingGuestId);
  state.occupantBySlot.delete(slot);
  const slots = state.occupantSlotsByBedNight.get(bedNight);
  if (!slots) return;
  slots.delete(slot);
  if (slots.size === 0) state.occupantSlotsByBedNight.delete(bedNight);
}

/** Whether any known occupant row still holds this bed-night (#2656). */
function bedNightHasOccupants(state: PlannerState, bedNight: string): boolean {
  return (state.occupantSlotsByBedNight.get(bedNight)?.size ?? 0) > 0;
}

/** The live occupant rows on one bed-night — 0, 1, or (shared double) 2. */
function occupantsOnBedNight(
  state: PlannerState,
  bedNight: string,
): OccupantInfo[] {
  const slots = state.occupantSlotsByBedNight.get(bedNight);
  if (!slots) return [];
  const occupants: OccupantInfo[] = [];
  for (const slot of slots) {
    const occupant = state.occupantBySlot.get(slot);
    if (occupant) occupants.push(occupant);
  }
  return occupants;
}

function setOccupant(state: PlannerState, info: OccupantInfo) {
  // A guest holds at most one bed per night (@@unique([bookingGuestId,
  // stayDate])). Re-seating the same guest-night on a DIFFERENT bed must not
  // leave its old slot behind, or that bed-night would never free again.
  // Defensive: today's only re-seat path (relocation) evicts the booking first.
  const previous = state.occupantsByBooking
    .get(info.bookingId)
    ?.get(guestNightKey(info.bookingGuestId, info.stayDate));
  if (previous && previous.bedId !== info.bedId) {
    forgetOccupantSlot(
      state,
      previous.bedId,
      previous.stayDate,
      previous.bookingGuestId,
    );
  }

  const bedNight = occupiedKey(info.bedId, info.stayDate);
  const slot = occupantSlotKey(info.bedId, info.stayDate, info.bookingGuestId);
  state.occupantBySlot.set(slot, info);
  let slots = state.occupantSlotsByBedNight.get(bedNight);
  if (!slots) {
    slots = new Set();
    state.occupantSlotsByBedNight.set(bedNight, slots);
  }
  slots.add(slot);

  let rows = state.occupantsByBooking.get(info.bookingId);
  if (!rows) {
    rows = new Map();
    state.occupantsByBooking.set(info.bookingId, rows);
  }
  rows.set(guestNightKey(info.bookingGuestId, info.stayDate), info);
}

/**
 * Rooms in which `bookingId` currently has an ADULT allocation on `stayDate`
 * (room-specific, from the LIVE occupancy view). A minor may only be
 * auto-placed into one of these rooms when no party adult shares the night.
 */
function liveExistingAdultRoomIds(
  state: PlannerState,
  bookingId: string,
  stayDate: string,
): Set<string> {
  const rooms = new Set<string>();
  // Read the live composition index rather than only seeded DB occupants:
  // allocations created earlier in this same plan also contribute here.
  for (const room of state.activeRooms) {
    const counts = state.roomNightAgeMix
      .get(roomNightMixKey(room.id, stayDate))
      ?.get(bookingId);
    if ((counts?.adults ?? 0) > 0) rooms.add(room.id);
  }
  return rooms;
}

/**
 * Whether the whole booking behind `bookingId` may be displaced (issue #1677):
 * every visible occupant row must be non-capacity-holding, none may be
 * admin-approved (one approved night anywhere pins the booking entirely), and
 * the stay must not extend beyond the loaded window.
 */
function isBookingWhollyDisplaceable(
  state: PlannerState,
  bookingId: string,
): boolean {
  const rows = state.occupantsByBooking.get(bookingId);
  if (!rows || rows.size === 0) return false;
  for (const row of rows.values()) {
    if (row.holdsCapacity || row.isApproved || row.stayExtendsBeyondWindow) {
      return false;
    }
  }
  return true;
}

function allocationReasonForNoBed(beds: BedAllocationBed[]) {
  return beds.length === 0 ? "NO_ACTIVE_BEDS" : "NO_BED_AVAILABLE";
}

function roomHasAvailableBeds(
  room: SortedRoomWithBeds,
  stayDate: string,
  occupied: Set<string>,
): BedAllocationBed[] {
  return room.beds.filter((bed) => !occupied.has(occupiedKey(bed.id, stayDate)));
}

function createAllocation(
  state: PlannerState,
  bookingId: string,
  guest: PartyGuest,
  bed: BedAllocationBed,
  stayDate: string,
): BedAllocationCandidate {
  state.occupied.add(occupiedKey(bed.id, stayDate));
  state.allocatedGuestNights.add(guestNightKey(guest.id, stayDate));
  trackRoomNightOccupant(state, bed.roomId, stayDate, bookingId, guest.ageTier, 1);

  return {
    bookingId,
    bookingGuestId: guest.id,
    roomId: bed.roomId,
    bedId: bed.id,
    stayDate,
    source: "AUTO",
  };
}

function allocateGuestsToBeds(
  state: PlannerState,
  bookingId: string,
  guests: PartyGuest[],
  beds: BedAllocationBed[],
  stayDate: string,
) {
  // Every caller has proven it holds at least one bed per guest: two `splice`
  // the same count off both lists, the third checks `availableBeds.length >=
  // guests.length`. A short list would mean writing a guest-night whose bed
  // the planner cannot name, so it stops rather than allocating (#2800).
  for (const [index, guest] of guests.entries()) {
    const bed = beds[index];
    if (bed === undefined) {
      throw new Error(
        `Bed allocation planner had ${beds.length} bed(s) for ${guests.length} guest(s) on ${stayDate}.`,
      );
    }
    state.allocations.push(
      createAllocation(state, bookingId, guest, bed, stayDate),
    );
  }
}

function addUnallocatedGuestNights(
  bookingId: string,
  guests: PartyGuest[],
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
  state: PlannerState,
  bookingId: string,
  guests: PartyGuest[],
  stayDate: string,
  rooms: SortedRoomWithBeds[],
  existingAdultRooms: Set<string>,
): boolean {
  const hasMinor = guests.some((guest) => !isAdultGuest(guest));
  const hasAdult = guests.some(isAdultGuest);

  // A minors-only party may take a room of its own (#1768); rooms already
  // holding this booking's adults tonight stay preferred (family cohesion).
  const orderedRooms =
    hasMinor && !hasAdult
      ? [
          ...rooms.filter((room) => existingAdultRooms.has(room.id)),
          ...rooms.filter((room) => !existingAdultRooms.has(room.id)),
        ]
      : rooms;

  for (const room of orderedRooms) {
    if (hasMinor && roomNightBlocksMinors(state, room.id, stayDate, bookingId)) {
      continue;
    }
    if (hasAdult && roomNightBlocksAdults(state, room.id, stayDate, bookingId)) {
      continue;
    }

    const availableBeds = roomHasAvailableBeds(room, stayDate, state.occupied);

    if (availableBeds.length >= guests.length) {
      allocateGuestsToBeds(state, bookingId, guests, availableBeds, stayDate);
      return true;
    }
  }

  return false;
}

interface SplitRoomAvailability {
  roomId: string;
  roomIndex: number;
  beds: BedAllocationBed[];
  /** No other booking's adult in this room-night — minors may enter (#1768). */
  allowsMinors: boolean;
  /** No other booking's minor in this room-night — adults may enter (#1768). */
  allowsAdults: boolean;
}

/**
 * First-fit guests into rooms, consuming beds from the shared per-room
 * availability view (so later steps never reuse a bed). Guests that do not
 * fit stay in `guests` for the caller to report.
 */
function fillRoomsWithGuests(
  state: PlannerState,
  bookingId: string,
  guests: PartyGuest[],
  roomsAvailability: SplitRoomAvailability[],
  stayDate: string,
) {
  for (const room of roomsAvailability) {
    if (guests.length === 0) break;
    if (room.beds.length === 0) continue;
    const take = Math.min(guests.length, room.beds.length);
    allocateGuestsToBeds(
      state,
      bookingId,
      guests.splice(0, take),
      room.beds.splice(0, take),
      stayDate,
    );
  }
}

function allocateSplitBookingNight(
  state: PlannerState,
  booking: BedAllocationBooking,
  guests: PartyGuest[],
  stayDate: string,
  rooms: SortedRoomWithBeds[],
  existingAdultRooms: Set<string>,
) {
  const bookingId = booking.id;
  const adults = guests.filter(isAdultGuest);
  const minors = guests.filter((guest) => !isAdultGuest(guest));
  const reason = allocationReasonForNoBed(state.allBeds);
  const roomAvailability: SplitRoomAvailability[] = rooms
    .map((room, roomIndex) => ({
      roomId: room.id,
      roomIndex,
      beds: roomHasAvailableBeds(room, stayDate, state.occupied),
      allowsMinors: !roomNightBlocksMinors(state, room.id, stayDate, bookingId),
      allowsAdults: !roomNightBlocksAdults(state, room.id, stayDate, bookingId),
    }))
    .filter((room) => room.beds.length > 0);
  const roomsAllowingAdults = () =>
    roomAvailability.filter((room) => room.allowsAdults);

  if (minors.length === 0) {
    const remaining = [...adults];
    fillRoomsWithGuests(state, bookingId, remaining, roomsAllowingAdults(), stayDate);
    addUnallocatedGuestNights(
      bookingId,
      remaining,
      stayDate,
      reason,
      state.unallocatedGuestNights,
    );
    return;
  }

  if (adults.length === 0 && existingAdultRooms.size === 0) {
    addUnallocatedGuestNights(
      bookingId,
      minors,
      stayDate,
      "NO_BOOKING_ADULT",
      state.unallocatedGuestNights,
    );
    return;
  }

  const remainingAdults = [...adults];
  const remainingMinors = [...minors];

  if (booking.isSchoolGroup !== true) {
    // Family preference: minors join rooms already holding this booking's
    // adults tonight first.
    const roomsWithExistingAdults = roomAvailability
      .filter((room) => existingAdultRooms.has(room.roomId) && room.allowsMinors)
      .sort((a, b) => a.roomIndex - b.roomIndex);

    for (const room of roomsWithExistingAdults) {
      if (remainingMinors.length === 0) break;

      const roomMinors = remainingMinors.splice(0, room.beds.length);
      const roomBeds = room.beds.splice(0, roomMinors.length);

      allocateGuestsToBeds(state, bookingId, roomMinors, roomBeds, stayDate);
    }

    // One adult per room with minors, while both remain (#1768: adults
    // running out no longer strands the leftover minors — they overflow into
    // minors-only rooms below).
    const pairedRooms = roomAvailability
      .filter(
        (room) =>
          room.beds.length >= 2 && room.allowsMinors && room.allowsAdults,
      )
      .sort((a, b) => {
        const capacityDiff = b.beds.length - a.beds.length;
        return capacityDiff !== 0 ? capacityDiff : a.roomIndex - b.roomIndex;
      });

    for (const room of pairedRooms) {
      if (remainingAdults.length === 0 || remainingMinors.length === 0) break;

      const adult = remainingAdults.shift();
      if (!adult) break;

      const roomMinors = remainingMinors.splice(0, room.beds.length - 1);
      const roomGuests = [adult, ...roomMinors];
      const roomBeds = room.beds.splice(0, roomGuests.length);

      allocateGuestsToBeds(state, bookingId, roomGuests, roomBeds, stayDate);
    }

    fillRoomsWithGuests(
      state,
      bookingId,
      remainingAdults,
      roomsAllowingAdults(),
      stayDate,
    );
  } else if (remainingAdults.length > 0) {
    // School/organisation grouping (#1768, owner decision): the booking's
    // adults room together — the smallest room fitting them all, else spread
    // first-fit — and the students take their own rooms below.
    const adultRoom = roomAvailability
      .filter(
        (room) =>
          room.allowsAdults && room.beds.length >= remainingAdults.length,
      )
      .sort(
        (a, b) => a.beds.length - b.beds.length || a.roomIndex - b.roomIndex,
      )[0];
    if (adultRoom) {
      const roomAdults = remainingAdults.splice(0);
      allocateGuestsToBeds(
        state,
        bookingId,
        roomAdults,
        adultRoom.beds.splice(0, roomAdults.length),
        stayDate,
      );
    } else {
      fillRoomsWithGuests(
        state,
        bookingId,
        remainingAdults,
        roomsAllowingAdults(),
        stayDate,
      );
    }
  }

  // Minors-only overflow (#1768) — the stranding fix: leftover minors fill
  // rooms of their own instead of going unallocated. Families prefer rooms
  // holding this booking's adults tonight; school groups prefer the opposite
  // (students separate from the teachers). Both orders are deterministic.
  if (remainingMinors.length > 0) {
    const adultRoomsNow = adultRoomsForBookingNight(
      booking,
      stayDate,
      existingAdultRooms,
      state.allocations,
    );
    const overflowRooms = roomAvailability
      .filter((room) => room.allowsMinors)
      .sort((a, b) => {
        const aAdult = adultRoomsNow.has(a.roomId) ? 1 : 0;
        const bAdult = adultRoomsNow.has(b.roomId) ? 1 : 0;
        const preference =
          booking.isSchoolGroup === true ? aAdult - bAdult : bAdult - aAdult;
        if (preference !== 0) return preference;
        const capacityDiff = b.beds.length - a.beds.length;
        return capacityDiff !== 0 ? capacityDiff : a.roomIndex - b.roomIndex;
      });
    fillRoomsWithGuests(state, bookingId, remainingMinors, overflowRooms, stayDate);
  }

  addUnallocatedGuestNights(
    bookingId,
    remainingAdults,
    stayDate,
    reason,
    state.unallocatedGuestNights,
  );
  addUnallocatedGuestNights(
    bookingId,
    remainingMinors,
    stayDate,
    reason,
    state.unallocatedGuestNights,
  );
}

/**
 * The rooms in which a capacity-holding booking already has (or, this run, has
 * just been given) an adult on `stayDate` (issue #1387). A displaced-in minor
 * may only take a bed in one of these rooms, preserving the adult-supervision
 * invariant the normal split path enforces.
 */
function adultRoomsForBookingNight(
  booking: BedAllocationBooking,
  stayDate: string,
  existingAdultRooms: Set<string>,
  allocations: BedAllocationCandidate[],
): Set<string> {
  const rooms = new Set(existingAdultRooms);
  const adultGuestIds = new Set(
    booking.guests.filter(isAdultGuest).map((guest) => guest.id),
  );

  for (const allocation of allocations) {
    if (
      allocation.bookingId === booking.id &&
      allocation.stayDate === stayDate &&
      adultGuestIds.has(allocation.bookingGuestId)
    ) {
      rooms.add(allocation.roomId);
    }
  }

  return rooms;
}

/**
 * Record a displacement, keyed by the provisional guest-night so a provisional
 * occupant displaced more than once in a single run collapses to ONE final
 * action (the latest destination / UNALLOCATE), keeping the lifecycle apply and
 * audit to a single update-or-delete per row while preserving the ORIGINAL
 * from-bed for the audit trail. Issue #1387.
 */
function upsertDisplacement(
  displacementByGuestNight: Map<string, BedAllocationDisplacement>,
  displacement: BedAllocationDisplacement,
) {
  const key = guestNightKey(displacement.bookingGuestId, displacement.stayDate);
  const existing = displacementByGuestNight.get(key);
  displacementByGuestNight.set(
    key,
    existing
      ? {
          ...displacement,
          fromBedId: existing.fromBedId,
          fromRoomId: existing.fromRoomId,
        }
      : displacement,
  );
}

function removeUnallocatedGuestNight(
  unallocatedGuestNights: UnallocatedGuestNight[],
  bookingGuestId: string,
  stayDate: string,
) {
  const index = unallocatedGuestNights.findIndex(
    (guestNight) =>
      guestNight.bookingGuestId === bookingGuestId &&
      guestNight.stayDate === stayDate,
  );
  if (index >= 0) {
    unallocatedGuestNights.splice(index, 1);
  }
}

/**
 * Phase 0 (issue #1677): the adult-coverage carve-out. A minor's night is
 * coverable iff a party adult also stays that night (the whole party lands in
 * one room, so the adult covers it) or the booking already has an adult
 * allocation on that night (room-specific pinning is enforced later, in the
 * room feasibility check). Uncoverable minor-nights are removed from the
 * demand and reported NO_BOOKING_ADULT — matching the legacy per-night rule.
 */
function applyAdultCoverageCarveOut(
  state: PlannerState,
  booking: BedAllocationBooking,
  guests: StayGuest[],
): StayGuest[] {
  const adultNights = new Set<string>();
  for (const guest of guests) {
    if (!isAdultGuest(guest)) continue;
    for (const night of guest.nights) adultNights.add(night);
  }

  const dropped: Array<{ guestId: string; night: string; guestIndex: number }> =
    [];
  const covered = guests
    .map((guest, guestIndex) => {
      if (isAdultGuest(guest)) return guest;
      const kept: string[] = [];
      for (const night of guest.nights) {
        if (
          adultNights.has(night) ||
          liveExistingAdultRoomIds(state, booking.id, night).size > 0
        ) {
          kept.push(night);
        } else {
          dropped.push({ guestId: guest.id, night, guestIndex });
        }
      }
      return { ...guest, nights: kept };
    })
    .filter((guest) => guest.nights.length > 0);

  dropped.sort(
    (a, b) => a.night.localeCompare(b.night) || a.guestIndex - b.guestIndex,
  );
  for (const drop of dropped) {
    state.unallocatedGuestNights.push({
      bookingId: booking.id,
      bookingGuestId: drop.guestId,
      stayDate: drop.night,
      reason: "NO_BOOKING_ADULT",
    });
  }

  return covered;
}

/**
 * Candidate room order for whole-stay placement (issue #1677):
 *   1. rooms already holding this booking's existing allocations (desc row
 *      count) so date-extensions and partial re-fills stay put;
 *   2. the booking's requested room (`roomsForBooking` reorder);
 *   3. room sort order.
 * Lodge scoping (`roomsAtLodge`, inside `roomsForBooking`) stays mandatory.
 * The count sort is stable, so ties keep the requested-first/sortOrder order.
 */
function shareDirectFamilyGroup(
  a: { familyGroupIds?: string[] },
  b: { familyGroupIds?: string[] },
): boolean {
  if (!a.familyGroupIds?.length || !b.familyGroupIds?.length) return false;
  const bGroups = new Set(b.familyGroupIds);
  return a.familyGroupIds.some((id) => bGroups.has(id));
}

function candidateRoomPriorityVector(
  state: PlannerState,
  booking: BedAllocationBooking,
  demand: BookingStayDemand,
  room: SortedRoomWithBeds,
): number[] {
  const rows = state.occupantsByBooking.get(booking.id);
  const existing = rows ? [...rows.values()] : [];
  const vector: number[] = [];

  for (const priority of state.allocationPriorityOrder) {
    if (priority === "BOOKING_COHESION") {
      let distinctRoomTotal = 0;
      for (const night of demand.nights) {
        const roomIds = new Set(
          existing
            .filter((row) => row.stayDate === night)
            .map((row) => row.roomId),
        );
        if ((demand.guestsByNight.get(night)?.length ?? 0) > 0) roomIds.add(room.id);
        distinctRoomTotal += roomIds.size;
      }
      vector.push(distinctRoomTotal);
      continue;
    }

    if (priority === "STAY_CONTINUITY") {
      let sameBedLinks = 0;
      let sameRoomLinks = 0;
      let roomSwitches = 0;
      for (const guest of demand.guests) {
        const existingForGuest = existing.filter(
          (row) => row.bookingGuestId === guest.id,
        );
        const roomByNight = new Map<string, string>();
        const bedByNight = new Map<string, string>();
        for (const row of existingForGuest) {
          roomByNight.set(row.stayDate, row.roomId);
          bedByNight.set(row.stayDate, row.bedId);
        }
        for (const night of guest.nights) roomByNight.set(night, room.id);
        // Walk the sorted nights as adjacent (previous, current) pairs. A
        // guest with no nights at all contributes no link and no switch,
        // which is what the index-based loop did by never entering (#2800).
        const [firstNight, ...laterNights] = [...roomByNight.keys()].sort();
        if (firstNight === undefined) continue;
        let previous = firstNight;
        for (const current of laterNights) {
          const sameRoom = roomByNight.get(previous) === roomByNight.get(current);
          if (sameRoom) sameRoomLinks += 1;
          else roomSwitches += 1;
          if (
            bedByNight.has(previous) &&
            bedByNight.get(previous) === bedByNight.get(current)
          ) {
            sameBedLinks += 1;
          }
          previous = current;
        }
      }
      vector.push(-sameBedLinks, -sameRoomLinks, roomSwitches);
      continue;
    }

    if (priority === "REQUESTED_ROOM") {
      const placedGuestNights = demand.guests.reduce(
        (total, guest) => total + guest.nights.length,
        0,
      );
      vector.push(room.id === booking.requestedRoomId ? -placedGuestNights : 0);
      continue;
    }

    let splitFamilyPairs = 0;
    for (const night of demand.nights) {
      const demanded = demand.guestsByNight.get(night) ?? [];
      const fixed = existing.filter((row) => row.stayDate === night);
      for (const guest of demanded) {
        for (const occupant of fixed) {
          if (
            shareDirectFamilyGroup(guest, occupant) &&
            room.id !== occupant.roomId
          ) {
            splitFamilyPairs += 1;
          }
        }
      }
    }
    vector.push(splitFamilyPairs);
  }

  return vector;
}

function compareNumberVectors(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Saved preferences order feasible rooms; canonical order breaks exact ties. */
function orderedCandidateRooms(
  state: PlannerState,
  booking: BedAllocationBooking,
  demand: BookingStayDemand,
): SortedRoomWithBeds[] {
  const base = roomsForBooking(state.activeRooms, booking);
  if (state.allocationPriorityOrder.length === 0) return base;

  return [...base].sort((a, b) =>
    compareNumberVectors(
      candidateRoomPriorityVector(state, booking, demand, a),
      candidateRoomPriorityVector(state, booking, demand, b),
    ),
  );
}

/**
 * Whether `room` can host the whole demanded stay in FREE space: for every
 * night, at least as many free beds as demanded guests, and the cross-booking
 * age-mix invariant holds (#1768) — a night bringing minors is blocked by any
 * OTHER booking's adult already in the room, and a night bringing adults is
 * blocked by any other booking's minor. A minors-only night no longer needs
 * this booking's own adult in the room (minors-only rooms are allowed; the
 * night-level adult-coverage rule stays with Phase 0).
 */
function roomHostsWholeStay(
  state: PlannerState,
  room: SortedRoomWithBeds,
  demand: BookingStayDemand,
  bookingId: string,
  bedNightUsable?: (bedId: string, night: string) => boolean,
): boolean {
  for (const night of demand.nights) {
    const guests = demand.guestsByNight.get(night) ?? [];
    if (guests.length === 0) continue;
    const hasAdult = guests.some(isAdultGuest);
    const hasMinor = guests.some((guest) => !isAdultGuest(guest));
    if (hasMinor && roomNightBlocksMinors(state, room.id, night, bookingId)) {
      return false;
    }
    if (hasAdult && roomNightBlocksAdults(state, room.id, night, bookingId)) {
      return false;
    }
    let free = 0;
    for (const bed of room.beds) {
      const usable = bedNightUsable
        ? bedNightUsable(bed.id, night)
        : !state.occupied.has(occupiedKey(bed.id, night));
      if (usable) free += 1;
    }
    if (free < guests.length) return false;
  }
  return true;
}

/**
 * Per-guest preferred beds in `roomId` from a set of existing rows: the bed a
 * guest holds on its earliest night in that room. Keeps a guest on its current
 * bed across date-extensions and whole-booking relocations back into (or
 * within) a room it already occupies.
 */
function preferredBedsInRoom(
  rows: Iterable<OccupantInfo>,
  roomId: string,
): Map<string, string> {
  const earliest = new Map<string, OccupantInfo>();
  for (const row of rows) {
    if (row.roomId !== roomId) continue;
    const current = earliest.get(row.bookingGuestId);
    if (!current || row.stayDate < current.stayDate) {
      earliest.set(row.bookingGuestId, row);
    }
  }
  const preferred = new Map<string, string>();
  for (const [guestId, row] of earliest) preferred.set(guestId, row.bedId);
  return preferred;
}

interface RoomBedAssignment {
  guest: StayGuest;
  stayDate: string;
  bed: BedAllocationBed;
}

/**
 * Assigns a whole party to beds within ONE feasible room (issue #1677). Bed
 * stability is best-effort: per guest (adults first, then input order), the
 * preferred bed (if any) then the first bed in sort order that is free on ALL
 * of the guest's nights; when no single bed spans the stay, the guest takes
 * the first free bed per night WITHIN the same room. Per-night feasibility
 * (checked by the caller) guarantees completion. Marks `state.occupied`.
 */
function assignGuestsToRoomBeds(
  state: PlannerState,
  room: SortedRoomWithBeds,
  guests: StayGuest[],
  preferredBedByGuest?: Map<string, string>,
  bedNightUsableForGuest?: (
    guest: StayGuest,
    bedId: string,
    night: string,
  ) => boolean,
): RoomBedAssignment[] {
  const assignments: RoomBedAssignment[] = [];
  const continuityEnabled = state.allocationPriorityOrder.includes(
    "STAY_CONTINUITY",
  );
  const usable = (guest: StayGuest, bedId: string, night: string) =>
    bedNightUsableForGuest
      ? bedNightUsableForGuest(guest, bedId, night)
      : !state.occupied.has(occupiedKey(bedId, night));

  for (const guest of adultsFirst(guests)) {
    const preferredBedId = continuityEnabled
      ? preferredBedByGuest?.get(guest.id)
      : undefined;
    const bedsInOrder = preferredBedId
      ? [
          ...room.beds.filter((bed) => bed.id === preferredBedId),
          ...room.beds.filter((bed) => bed.id !== preferredBedId),
        ]
      : room.beds;

    const stableBed = continuityEnabled
      ? bedsInOrder.find((bed) =>
          guest.nights.every((night) => usable(guest, bed.id, night)),
        )
      : undefined;
    if (stableBed) {
      for (const night of guest.nights) {
        state.occupied.add(occupiedKey(stableBed.id, night));
        assignments.push({ guest, stayDate: night, bed: stableBed });
      }
      continue;
    }

    for (const night of guest.nights) {
      const bed = bedsInOrder.find((candidate) =>
        usable(guest, candidate.id, night),
      );
      if (!bed) continue; // unreachable: per-night feasibility was checked
      state.occupied.add(occupiedKey(bed.id, night));
      assignments.push({ guest, stayDate: night, bed });
    }
  }

  return assignments;
}

/** Phase 1/2 placement: the whole demanded stay lands in `room`. */
function placePartyInRoom(
  state: PlannerState,
  booking: BedAllocationBooking,
  room: SortedRoomWithBeds,
  demand: BookingStayDemand,
) {
  const rows = state.occupantsByBooking.get(booking.id);
  const preferred = rows
    ? preferredBedsInRoom(rows.values(), room.id)
    : undefined;
  const assignments = assignGuestsToRoomBeds(
    state,
    room,
    demand.guests,
    preferred,
  );
  const sorted = [...assignments].sort((a, b) =>
    a.stayDate.localeCompare(b.stayDate),
  );
  for (const assignment of sorted) {
    state.allocatedGuestNights.add(
      guestNightKey(assignment.guest.id, assignment.stayDate),
    );
    trackRoomNightOccupant(
      state,
      room.id,
      assignment.stayDate,
      booking.id,
      assignment.guest.ageTier,
      1,
    );
    state.allocations.push({
      bookingId: booking.id,
      bookingGuestId: assignment.guest.id,
      roomId: room.id,
      bedId: assignment.bed.id,
      stayDate: assignment.stayDate,
      source: "AUTO",
    });
  }
}

function clonePlannerState(state: PlannerState): PlannerState {
  return {
    ...state,
    occupied: new Set(state.occupied),
    occupiedAtStart: new Set(state.occupiedAtStart),
    permanentlyOccupied: new Set(state.permanentlyOccupied),
    occupantBySlot: new Map(state.occupantBySlot),
    // DEEP clone (#2656): a shallow `new Map(...)` would share the inner Sets,
    // so a discarded trial's evictions would silently leak into the state that
    // wins — freeing bed-nights nobody actually left.
    occupantSlotsByBedNight: new Map(
      [...state.occupantSlotsByBedNight].map(([bedNight, slots]) => [
        bedNight,
        new Set(slots),
      ]),
    ),
    occupantsByBooking: new Map(
      [...state.occupantsByBooking].map(([bookingId, rows]) => [
        bookingId,
        new Map(rows),
      ]),
    ),
    allocatedGuestNights: new Set(state.allocatedGuestNights),
    allocations: [...state.allocations],
    unallocatedGuestNights: [...state.unallocatedGuestNights],
    displacementByGuestNight: new Map(state.displacementByGuestNight),
    roomNightAgeMix: new Map(
      [...state.roomNightAgeMix].map(([key, byBooking]) => [
        key,
        new Map(
          [...byBooking].map(([bookingId, counts]) => [
            bookingId,
            { ...counts },
          ]),
        ),
      ]),
    ),
    unknownRoomNightRows: [...state.unknownRoomNightRows],
  };
}

interface FreeSpaceStrategy {
  state: PlannerState;
  score: number[];
  canonicalKey: string;
  split: boolean;
  placementCount: number;
  compatibilityRank: number;
}

/** Hard bound for matching-layout candidates; other strategy families are separate. */
export const BED_ALLOCATION_MAX_MATCHING_LAYOUTS = 24;

function uniqueGuestOrders(orders: StayGuest[][]): StayGuest[][] {
  const seen = new Set<string>();
  return orders.filter((order) => {
    const key = order.map((guest) => guest.id).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Reads one slot of a dense vertex-indexed vector in the blossom search below.
 * Those vectors are all created at length `size` and only ever read at a
 * vertex the search itself produced, so a miss is a bug in the search, not a
 * domain state. Reading through this makes the value a `number` in the type
 * instead of an assertion, and names the impossible read instead of letting
 * `undefined` flow on as the *next* vector's index — which is how this class
 * of bug becomes a silent wrong pairing or a spin (#2800).
 */
function vertexSlot(
  vector: readonly number[],
  index: number,
  label: string,
): number {
  const value = vector[index];
  if (value === undefined) {
    throw new Error(
      `Bed allocation family matching read ${label}[${index}], outside 0..${vector.length - 1}.`,
    );
  }
  return value;
}

/**
 * Deterministic Edmonds matching for one direct-family component. Each guest
 * comes back joined to the guest it was matched with, or with no partner when
 * the matching left it unpaired.
 */
function maximumCardinalityFamilyPairs(
  component: StayGuest[],
): Array<{ guest: StayGuest; partner: StayGuest | undefined }> {
  const size = component.length;
  const adjacency = component.map((guest, index) =>
    component
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(
        ({ candidate, candidateIndex }) =>
          candidateIndex !== index && shareDirectFamilyGroup(guest, candidate),
      )
      .map(({ candidateIndex }) => candidateIndex),
  );
  const match = Array<number>(size).fill(-1);
  const parent = Array<number>(size).fill(-1);
  const base = Array.from({ length: size }, (_, index) => index);
  const used = Array<boolean>(size).fill(false);
  const blossom = Array<boolean>(size).fill(false);

  const neighboursOf = (vertex: number): readonly number[] => {
    const list = adjacency[vertex];
    if (list === undefined) {
      throw new Error(
        `Bed allocation family matching read adjacency[${vertex}], outside 0..${size - 1}.`,
      );
    }
    return list;
  };

  const lowestCommonAncestor = (leftStart: number, rightStart: number) => {
    const path = Array<boolean>(size).fill(false);
    let left = leftStart;
    while (true) {
      left = vertexSlot(base, left, "base");
      path[left] = true;
      const matched = vertexSlot(match, left, "match");
      if (matched === -1) break;
      left = vertexSlot(parent, matched, "parent");
    }
    let right = rightStart;
    while (true) {
      right = vertexSlot(base, right, "base");
      if (path[right]) return right;
      // The left walk marked every vertex up to the unmatched root, so the
      // right walk returns at or before that root and never reads the root's
      // absent match. Reaching `parent[-1]` would be that guarantee broken.
      right = vertexSlot(parent, vertexSlot(match, right, "match"), "parent");
    }
  };

  const markBlossomPath = (
    start: number,
    commonBase: number,
    childStart: number,
  ) => {
    let vertex = start;
    let child = childStart;
    while (vertexSlot(base, vertex, "base") !== commonBase) {
      const matched = vertexSlot(match, vertex, "match");
      blossom[vertexSlot(base, vertex, "base")] = true;
      blossom[vertexSlot(base, matched, "base")] = true;
      parent[vertex] = child;
      child = matched;
      vertex = vertexSlot(parent, matched, "parent");
    }
  };

  const augmentFrom = (root: number): boolean => {
    used.fill(false);
    parent.fill(-1);
    for (let index = 0; index < size; index += 1) base[index] = index;
    const queue = [root];
    used[root] = true;
    // The queue grows while it is walked; an array iterator re-reads `length`
    // each step, so this visits everything the head-index loop it replaces did
    // and hands out a proven vertex rather than a possibly-absent slot.
    for (const vertex of queue) {
      for (const candidate of neighboursOf(vertex)) {
        if (
          vertexSlot(base, vertex, "base") ===
            vertexSlot(base, candidate, "base") ||
          vertexSlot(match, vertex, "match") === candidate
        ) {
          continue;
        }
        // `match` is not written between here and the reads below: the blossom
        // branch leaves it alone, and the augmenting branch returns.
        const candidateMatch = vertexSlot(match, candidate, "match");
        if (
          candidate === root ||
          (candidateMatch !== -1 &&
            vertexSlot(parent, candidateMatch, "parent") !== -1)
        ) {
          const commonBase = lowestCommonAncestor(vertex, candidate);
          blossom.fill(false);
          markBlossomPath(vertex, commonBase, candidate);
          markBlossomPath(candidate, commonBase, vertex);
          for (let index = 0; index < size; index += 1) {
            if (!blossom[vertexSlot(base, index, "base")]) continue;
            base[index] = commonBase;
            if (used[index]) continue;
            used[index] = true;
            queue.push(index);
          }
          continue;
        }
        if (vertexSlot(parent, candidate, "parent") !== -1) continue;
        parent[candidate] = vertex;
        if (candidateMatch === -1) {
          let current = candidate;
          while (current !== -1) {
            const previous = vertexSlot(parent, current, "parent");
            const next =
              previous === -1 ? -1 : vertexSlot(match, previous, "match");
            match[current] = previous;
            if (previous !== -1) match[previous] = current;
            current = next;
          }
          return true;
        }
        used[candidateMatch] = true;
        queue.push(candidateMatch);
      }
    }
    return false;
  };

  for (let vertex = 0; vertex < size; vertex += 1) {
    if (match[vertex] === -1) augmentFrom(vertex);
  }
  // Hand back each guest already joined to the guest it was matched to, rather
  // than a vertex-number array the caller has to read back against the same
  // component by position. The pairing is then a fact of the value (#2800).
  return component.map((guest, index) => {
    const partnerIndex = vertexSlot(match, index, "match");
    if (partnerIndex === -1) return { guest, partner: undefined };
    const partner = component[partnerIndex];
    if (partner === undefined) {
      throw new Error(
        `Bed allocation family matching paired vertex ${index} with ${partnerIndex}, outside 0..${size - 1}.`,
      );
    }
    return { guest, partner };
  });
}

function matchedFamilyComponentOrder(components: StayGuest[][]): StayGuest[] {
  const paired: StayGuest[] = [];
  const unmatched: StayGuest[] = [];
  for (const component of components) {
    // A component holds each guest once (the walk that builds it dedupes by
    // id), so guest identity is the same dedup key the vertex index was.
    const emitted = new Set<StayGuest>();
    for (const { guest, partner } of maximumCardinalityFamilyPairs(component)) {
      if (emitted.has(guest)) continue;
      if (partner === undefined) {
        unmatched.push(guest);
        emitted.add(guest);
        continue;
      }
      paired.push(guest, partner);
      emitted.add(guest);
      emitted.add(partner);
    }
  }
  // Pair blocks from every component stay adjacent before any singleton or
  // unmatched vertex can consume half of a capacity-two room.
  return [...paired, ...unmatched];
}

const BED_ALLOCATION_MAX_FAMILY_BLOCK_SEEDS = 24;

function overlappingNightCount(left: StayGuest, right: StayGuest): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let count = 0;
  // The merge runs while both lists still have a night, and the two reads are
  // what say so — the same condition the two length comparisons expressed,
  // stated where the values are actually taken (#2800).
  while (true) {
    const leftNight = left.nights[leftIndex];
    const rightNight = right.nights[rightIndex];
    if (leftNight === undefined || rightNight === undefined) break;
    const comparison = leftNight.localeCompare(rightNight);
    if (comparison === 0) {
      count += 1;
      leftIndex += 1;
      rightIndex += 1;
    } else if (comparison < 0) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return count;
}

function sampledFamilyBlockSeeds(guests: StayGuest[]): StayGuest[] {
  if (guests.length <= BED_ALLOCATION_MAX_FAMILY_BLOCK_SEEDS) return guests;
  // Even sample across the list including both endpoints. Past the seed budget
  // the step exceeds one, so the sampled positions are strictly increasing and
  // distinct; selecting by position therefore yields the same seeds in the
  // same order, and reads nothing the list might not hold (#2800).
  const sampledPositions = new Set(
    Array.from({ length: BED_ALLOCATION_MAX_FAMILY_BLOCK_SEEDS }, (_, index) =>
      Math.floor(
        (index * (guests.length - 1)) /
          (BED_ALLOCATION_MAX_FAMILY_BLOCK_SEEDS - 1),
      ),
    ),
  );
  return guests.filter((_, index) => sampledPositions.has(index));
}

/**
 * Builds one capacity-aware family layout without enumerating room partitions.
 * For each room-sized block, try at most 24 evenly sampled seeds, greedily add
 * the guest with the largest direct-family overlapping-night gain, then retain
 * the highest scoring block (canonical input order breaks every tie). Building
 * edge weights is O(g^2 * overlapping nights); block search is O(R * 24 * C *
 * g). This adds exactly one bounded layout and can preserve useful triples or
 * larger groups that pair matching necessarily misses. It remains a
 * deterministic heuristic rather than an exact graph-partition optimizer.
 */
function capacityAwareFamilyBlockOrder(
  guests: StayGuest[],
  roomCapacities: number[],
  directFamilyWeights: Map<string, Map<string, number>>,
): StayGuest[] {
  let remaining = [...guests];
  const ordered: StayGuest[] = [];

  for (const capacity of roomCapacities) {
    if (remaining.length === 0) break;
    const blockSize = Math.min(capacity, remaining.length);
    if (blockSize <= 0) continue;

    let bestBlock: StayGuest[] | undefined;
    let bestScore = -1;
    for (const seed of sampledFamilyBlockSeeds(remaining)) {
      const block = [seed];
      let available = remaining.filter((guest) => guest !== seed);
      const marginalEdges = new Map(
        available.map((guest) => [
          guest.id,
          directFamilyWeights.get(seed.id)?.get(guest.id) ?? 0,
        ]),
      );
      let score = 0;

      while (block.length < blockSize) {
        // Carry the best guest itself rather than its position, so removing it
        // needs no index. First maximum still wins, keeping canonical input
        // order as the tie-break (#2800).
        let selected: StayGuest | undefined;
        let gain = 0;
        for (const candidate of available) {
          const candidateGain = marginalEdges.get(candidate.id) ?? 0;
          if (selected === undefined || candidateGain > gain) {
            selected = candidate;
            gain = candidateGain;
          }
        }
        // `available` holds every guest not yet in the block and the block is
        // still short of the room, so one is always left; an empty list means
        // the block cannot be filled, and a short block is the safe answer.
        if (selected === undefined) break;
        available = available.filter((guest) => guest !== selected);
        score += gain;
        block.push(selected);
        for (const candidate of available) {
          marginalEdges.set(
            candidate.id,
            (marginalEdges.get(candidate.id) ?? 0) +
              (directFamilyWeights.get(selected.id)?.get(candidate.id) ?? 0),
          );
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestBlock = block;
      }
    }

    if (!bestBlock) continue;
    ordered.push(...bestBlock);
    const selectedIds = new Set(bestBlock.map((guest) => guest.id));
    remaining = remaining.filter((guest) => !selectedIds.has(guest.id));
  }

  return [...ordered, ...remaining];
}

function splitGuestOrderVariants(
  state: PlannerState,
  booking: BedAllocationBooking,
  guests: StayGuest[],
): StayGuest[][] {
  const canonical = adultsFirst(guests);
  const existing = state.occupantsByBooking.get(booking.id);
  const returningIds = new Set(
    existing ? [...existing.values()].map((row) => row.bookingGuestId) : [],
  );
  const continuity = [...canonical].sort(
    (a, b) => Number(returningIds.has(b.id)) - Number(returningIds.has(a.id)),
  );
  const minorsFirst = [...canonical].sort(
    (a, b) => Number(isAdultGuest(a)) - Number(isAdultGuest(b)),
  );
  const foundational = uniqueGuestOrders([
    canonical,
    ...(state.allocationPriorityOrder.includes("STAY_CONTINUITY")
      ? [continuity]
      : []),
    ...(booking.isSchoolGroup ? [minorsFirst] : []),
    [...canonical].reverse(),
  ]);
  if (!state.allocationPriorityOrder.includes("FAMILY_COHESION")) {
    return foundational;
  }
  const familyVariants: StayGuest[][] = [];

  // Direct-family membership is a graph, not a single grouping key: a guest
  // may belong to several groups and a useful pair may share only a later id.
  // First cluster every connected component at once. This is the whole-family
  // candidate that can seat three or more interleaved, independent subsets
  // without spending one candidate per subset.
  const canonicalIndex = new Map(
    canonical.map((guest, index) => [guest.id, index]),
  );
  const neighbours = new Map(
    canonical.map((guest) => [guest.id, new Set<string>()]),
  );
  const directFamilyWeights = new Map(
    canonical.map((guest) => [guest.id, new Map<string, number>()]),
  );
  // Every unordered pair once, in canonical order: the outer entry hands over
  // the guest with its position and the inner walks the tail after it, so
  // neither side is read back out of the list by a computed index (#2800).
  for (const [left, a] of canonical.entries()) {
    for (const b of canonical.slice(left + 1)) {
      if (!shareDirectFamilyGroup(a, b)) continue;
      neighbours.get(a.id)?.add(b.id);
      neighbours.get(b.id)?.add(a.id);
      const weight = overlappingNightCount(a, b);
      directFamilyWeights.get(a.id)?.set(b.id, weight);
      directFamilyWeights.get(b.id)?.set(a.id, weight);
    }
  }
  const guestById = new Map(canonical.map((guest) => [guest.id, guest]));
  const visited = new Set<string>();
  const components: StayGuest[][] = [];
  for (const guest of canonical) {
    if (visited.has(guest.id)) continue;
    const pending = [guest.id];
    const component: StayGuest[] = [];
    visited.add(guest.id);
    while (pending.length > 0) {
      const guestId = pending.shift();
      if (!guestId) continue;
      const member = guestById.get(guestId);
      if (member) component.push(member);
      const nextIds = [...(neighbours.get(guestId) ?? [])].sort(
        (a, b) =>
          (canonicalIndex.get(a) ?? 9999) -
          (canonicalIndex.get(b) ?? 9999),
      );
      for (const nextId of nextIds) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        pending.push(nextId);
      }
    }
    component.sort(
      (a, b) =>
        (canonicalIndex.get(a.id) ?? 9999) -
        (canonicalIndex.get(b.id) ?? 9999),
    );
    components.push(component);
  }
  const componentCluster = components.flat();
  const capacityAwareFamilyBlocks = capacityAwareFamilyBlockOrder(
    canonical,
    roomsForBooking(state.activeRooms, booking).map((room) => room.beds.length),
    directFamilyWeights,
  );
  const requiredFamilyVariants = uniqueGuestOrders([
    componentCluster,
    components.flatMap((component) => [...component].reverse()),
    matchedFamilyComponentOrder(components),
    capacityAwareFamilyBlocks,
  ]).filter(
    (candidate) =>
      !foundational.some(
        (base) =>
          base.length === candidate.length &&
          base.every((guest, index) => guest.id === candidate[index]?.id),
      ),
  );

  // Retain direct-pair-front candidates for overlapping or impossible chains:
  // a connected component may not have any linear order that makes every
  // directly related pair share a capacity-constrained room.
  for (const [left, a] of canonical.entries()) {
    for (const b of canonical.slice(left + 1)) {
      if (!shareDirectFamilyGroup(a, b)) continue;
      const others = canonical.filter((guest) => guest !== a && guest !== b);
      familyVariants.push([a, b, ...others], [b, a, ...others]);
    }
  }

  // Finally cluster each direct group inside every component simultaneously.
  // These bounded subset variants let the scorer choose which shared-group
  // edges to preserve when an overlapping component cannot preserve them all.
  const groupIds = [
    ...new Set(canonical.flatMap((guest) => guest.familyGroupIds ?? [])),
  ].sort();
  for (const groupId of groupIds) {
    const clustered = components.flatMap((component) => [
      ...component.filter((guest) => guest.familyGroupIds?.includes(groupId)),
      ...component.filter((guest) => !guest.familyGroupIds?.includes(groupId)),
    ]);
    const members = clustered.filter((guest) =>
      guest.familyGroupIds?.includes(groupId),
    );
    if (members.length < 2) continue;
    familyVariants.push(
      clustered,
      components.flatMap((component) => [
        ...component
          .filter((guest) => guest.familyGroupIds?.includes(groupId))
          .reverse(),
        ...component.filter(
          (guest) => !guest.familyGroupIds?.includes(groupId),
        ),
      ]),
    );
  }

  const distinctFamilyVariants = uniqueGuestOrders(familyVariants).filter(
    (candidate) =>
      !foundational.some(
        (base) =>
          base.length === candidate.length &&
          base.every((guest, index) => guest.id === candidate[index]?.id),
      ) &&
      !requiredFamilyVariants.some(
        (required) =>
          required.length === candidate.length &&
          required.every(
            (guest, index) => guest.id === candidate[index]?.id,
          ),
      ),
  );
  const remaining = Math.max(
    BED_ALLOCATION_MAX_MATCHING_LAYOUTS -
      foundational.length -
      requiredFamilyVariants.length,
    0,
  );
  if (distinctFamilyVariants.length <= remaining) {
    return [
      ...foundational,
      ...requiredFamilyVariants,
      ...distinctFamilyVariants,
    ];
  }
  // Sample the full deterministic family candidate set evenly and include both
  // endpoints. In particular, the final high-sorted group candidate must not
  // disappear merely because the total matching budget is bounded.
  // This branch runs only when there are strictly more candidates than the
  // budget, so the step exceeds one and the sampled positions are distinct and
  // increasing: selecting by position keeps the same candidates in the same
  // order, and reads nothing the list might not hold (#2800).
  const sampledPositions = new Set(
    Array.from({ length: remaining }, (_, index) =>
      remaining === 1
        ? distinctFamilyVariants.length - 1
        : Math.floor(
            (index * (distinctFamilyVariants.length - 1)) / (remaining - 1),
          ),
    ),
  );
  const spreadFamilyVariants = distinctFamilyVariants.filter((_, index) =>
    sampledPositions.has(index),
  );
  return [
    ...foundational,
    ...requiredFamilyVariants,
    ...spreadFamilyVariants,
  ];
}

interface PreferredBedRow {
  bedId: string;
  stayDate: string;
  stayTimeMs: number;
}

function indexPreferredBedRows(
  state: PlannerState,
  bookingId: string,
): Map<string, PreferredBedRow[]> {
  const rowsByGuest = new Map<string, PreferredBedRow[]>();
  const add = (guestId: string, row: PreferredBedRow) => {
    const rows = rowsByGuest.get(guestId) ?? [];
    rows.push(row);
    rowsByGuest.set(guestId, rows);
  };
  for (const row of state.occupantsByBooking.get(bookingId)?.values() ?? []) {
    add(row.bookingGuestId, {
      bedId: row.bedId,
      stayDate: row.stayDate,
      stayTimeMs: parseDateOnly(row.stayDate).getTime(),
    });
  }
  // Scan the candidate rows ONCE per layout. The former per-guest/per-night
  // full-array filter made a 100-guest, 31-night plan quadratic in its 3,100
  // newly produced rows.
  for (const row of state.allocations) {
    if (row.bookingId !== bookingId) continue;
    add(row.bookingGuestId, {
      bedId: row.bedId,
      stayDate: row.stayDate,
      stayTimeMs: parseDateOnly(row.stayDate).getTime(),
    });
  }
  return rowsByGuest;
}

function preferredBedIdsForGuest(
  rowsByGuest: Map<string, PreferredBedRow[]>,
  guestId: string,
  stayDate: string,
): string[] {
  const targetTimeMs = parseDateOnly(stayDate).getTime();
  const rows = [...(rowsByGuest.get(guestId) ?? [])].sort((a, b) => {
    const aDistance = Math.abs(a.stayTimeMs - targetTimeMs);
    const bDistance = Math.abs(b.stayTimeMs - targetTimeMs);
    return aDistance - bDistance || a.stayDate.localeCompare(b.stayDate);
  });
  return [...new Set(rows.map((row) => row.bedId))];
}

/**
 * Maximum-cardinality split placement for one night. The augmenting-path
 * matcher guarantees the hard first objective (place as many guest-nights as
 * possible); deterministic guest/room variants give the lexicographic scorer
 * materially different feasible layouts to compare.
 */
function allocateMaximumSplitBookingNight(
  state: PlannerState,
  booking: BedAllocationBooking,
  guests: StayGuest[],
  stayDate: string,
  rooms: SortedRoomWithBeds[],
  preferredRowsByGuest: Map<string, PreferredBedRow[]>,
): void {
  const stayTimeMs = parseDateOnly(stayDate).getTime();
  const beds = rooms.flatMap((room) =>
    room.beds
      .filter((bed) => !state.occupied.has(occupiedKey(bed.id, stayDate)))
      .map((bed) => ({ room, bed })),
  );
  const guestById = new Map(guests.map((guest) => [guest.id, guest]));
  const candidatesByGuest = new Map<string, typeof beds>();
  for (const guest of guests) {
    const preferred = new Map(
      preferredBedIdsForGuest(preferredRowsByGuest, guest.id, stayDate).map(
        (bedId, index) => [bedId, index],
      ),
    );
    candidatesByGuest.set(
      guest.id,
      beds
        .filter(({ room }) =>
          isAdultGuest(guest)
            ? !roomNightBlocksAdults(state, room.id, stayDate, booking.id)
            : !roomNightBlocksMinors(state, room.id, stayDate, booking.id),
        )
        .sort((a, b) => {
          if (state.allocationPriorityOrder.includes("STAY_CONTINUITY")) {
            const preferredDiff =
              (preferred.get(a.bed.id) ?? 9999) -
              (preferred.get(b.bed.id) ?? 9999);
            if (preferredDiff !== 0) return preferredDiff;
          }
          return 0;
        }),
    );
  }

  const bedToGuest = new Map<string, string>();
  const greedyBedToGuest = new Map<string, string>();
  const greedyUsedBeds = new Set<string>();
  let greedyComplete = true;
  for (const guest of guests) {
    const candidate = (candidatesByGuest.get(guest.id) ?? []).find(
      ({ bed }) => !greedyUsedBeds.has(bed.id),
    );
    if (!candidate) {
      greedyComplete = false;
      break;
    }
    greedyUsedBeds.add(candidate.bed.id);
    greedyBedToGuest.set(candidate.bed.id, guest.id);
  }
  if (greedyComplete) {
    for (const [bedId, guestId] of greedyBedToGuest) {
      bedToGuest.set(bedId, guestId);
    }
  } else {
    // A failed greedy trial proves nothing about cardinality. Discard it
    // completely and run augmenting paths from an empty matching.
    const assign = (guestId: string, seenBeds: Set<string>): boolean => {
      for (const { bed } of candidatesByGuest.get(guestId) ?? []) {
        if (seenBeds.has(bed.id)) continue;
        seenBeds.add(bed.id);
        const occupyingGuestId = bedToGuest.get(bed.id);
        if (!occupyingGuestId || assign(occupyingGuestId, seenBeds)) {
          bedToGuest.set(bed.id, guestId);
          return true;
        }
      }
      return false;
    };
    for (const guest of guests) assign(guest.id, new Set());
  }

  const assignedGuestIds = new Set<string>();
  for (const { bed } of beds) {
    const guestId = bedToGuest.get(bed.id);
    if (!guestId) continue;
    const guest = guestById.get(guestId);
    if (!guest) continue;
    assignedGuestIds.add(guest.id);
    state.allocations.push(
      createAllocation(state, booking.id, guest, bed, stayDate),
    );
    const preferredRows = preferredRowsByGuest.get(guest.id) ?? [];
    preferredRows.push({ bedId: bed.id, stayDate, stayTimeMs });
    preferredRowsByGuest.set(guest.id, preferredRows);
  }
  addUnallocatedGuestNights(
    booking.id,
    guests.filter((guest) => !assignedGuestIds.has(guest.id)),
    stayDate,
    allocationReasonForNoBed(state.allBeds),
    state.unallocatedGuestNights,
  );
}

function freeSpaceStrategyScore(
  state: PlannerState,
  booking: BedAllocationBooking,
  demand: BookingStayDemand,
  allocationStart: number,
): { score: number[]; canonicalKey: string } {
  const guestById = new Map(demand.guests.map((guest) => [guest.id, guest]));
  const rows = [
    ...[...(state.occupantsByBooking.get(booking.id)?.values() ?? [])].map(
      (row) => ({
        guestId: row.bookingGuestId,
        stayDate: row.stayDate,
        roomId: row.roomId,
        bedId: row.bedId,
        ageTier: row.ageTier,
        familyGroupIds: row.familyGroupIds,
        isNew: false,
      }),
    ),
    ...state.allocations.slice(allocationStart).map((row) => ({
      guestId: row.bookingGuestId,
      stayDate: row.stayDate,
      roomId: row.roomId,
      bedId: row.bedId,
      ageTier: guestById.get(row.bookingGuestId)?.ageTier,
      familyGroupIds: guestById.get(row.bookingGuestId)?.familyGroupIds ?? [],
      isNew: true,
    })),
  ];
  const score: number[] = [];
  const rowsByNight = new Map<string, typeof rows>();
  const rowsByGuest = new Map<string, typeof rows>();
  for (const row of rows) {
    const nightRows = rowsByNight.get(row.stayDate) ?? [];
    nightRows.push(row);
    rowsByNight.set(row.stayDate, nightRows);
    const guestRows = rowsByGuest.get(row.guestId) ?? [];
    guestRows.push(row);
    rowsByGuest.set(row.guestId, guestRows);
  }

  if (booking.isSchoolGroup === true) {
    const roomNights = new Map<string, { adults: number; minors: number }>();
    for (const row of rows) {
      const key = `${row.roomId}:${row.stayDate}`;
      const counts = roomNights.get(key) ?? { adults: 0, minors: 0 };
      if (isAdultAgeTier(row.ageTier)) {
        counts.adults += 1;
      } else {
        counts.minors += 1;
      }
      roomNights.set(key, counts);
    }
    score.push(
      [...roomNights.values()].filter(
        (counts) => counts.adults > 0 && counts.minors > 0,
      ).length,
    );
    const adultRoomsByNight = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!isAdultAgeTier(row.ageTier)) continue;
      const roomIds = adultRoomsByNight.get(row.stayDate) ?? new Set<string>();
      roomIds.add(row.roomId);
      adultRoomsByNight.set(row.stayDate, roomIds);
    }
    score.push(
      [...adultRoomsByNight.values()].reduce(
        (total, roomIds) => total + roomIds.size,
        0,
      ),
    );
  }

  for (const priority of state.allocationPriorityOrder) {
    if (priority === "BOOKING_COHESION") {
      let roomCount = 0;
      for (const nightRows of rowsByNight.values()) {
        roomCount += new Set(nightRows.map((row) => row.roomId)).size;
      }
      score.push(roomCount);
      continue;
    }
    if (priority === "STAY_CONTINUITY") {
      let sameBedLinks = 0;
      let sameRoomLinks = 0;
      let roomSwitches = 0;
      for (const rowsForGuest of rowsByGuest.values()) {
        // Adjacent (previous, current) pairs down the guest's sorted nights.
        // One night, or none, contributes no link and no switch — which is
        // what the index-based loop did by never entering (#2800).
        const [firstRow, ...laterRows] = [...rowsForGuest].sort((a, b) =>
          a.stayDate.localeCompare(b.stayDate),
        );
        if (firstRow === undefined) continue;
        let previous = firstRow;
        for (const current of laterRows) {
          if (previous.roomId === current.roomId) sameRoomLinks += 1;
          else roomSwitches += 1;
          if (previous.bedId === current.bedId) sameBedLinks += 1;
          previous = current;
        }
      }
      score.push(-sameBedLinks, -sameRoomLinks, roomSwitches);
      continue;
    }
    if (priority === "REQUESTED_ROOM") {
      score.push(
        -rows.filter(
          (row) => row.isNew && row.roomId === booking.requestedRoomId,
        ).length,
      );
      continue;
    }

    let splitFamilyPairs = 0;
    for (const nightRows of rowsByNight.values()) {
      for (const [left, a] of nightRows.entries()) {
        for (const b of nightRows.slice(left + 1)) {
          if (a.roomId !== b.roomId && shareDirectFamilyGroup(a, b)) {
            splitFamilyPairs += 1;
          }
        }
      }
    }
    score.push(splitFamilyPairs);
  }

  const roomOrder = new Map(
    state.activeRooms.map((room, index) => [room.id, index]),
  );
  const bedOrder = new Map(
    state.activeRooms.flatMap((room) =>
      room.beds.map((bed, index) => [bed.id, index] as const),
    ),
  );
  const canonicalKey = state.allocations
    .slice(allocationStart)
    .map(
      (row) =>
        `${row.stayDate}:${String(roomOrder.get(row.roomId) ?? 9999).padStart(4, "0")}:${String(bedOrder.get(row.bedId) ?? 9999).padStart(4, "0")}:${row.bookingGuestId}`,
    )
    .sort()
    .join("|");
  return { score, canonicalKey };
}

/**
 * Compare bounded deterministic whole-room and split strategies. Placement
 * count is the fixed first objective; saved preferences compare the layouts
 * lexicographically. Existing whole/legacy strategies win an exact score tie
 * for default-output compatibility, then the canonical allocation key breaks
 * ties within that class.
 */
function chooseFreeSpaceStrategy(
  state: PlannerState,
  booking: BedAllocationBooking,
  demand: BookingStayDemand,
  allowDisplacement: boolean,
): FreeSpaceStrategy | null {
  const rooms = roomsForBooking(state.activeRooms, booking);
  const allocationStart = state.allocations.length;
  const strategies: FreeSpaceStrategy[] = [];
  const addStrategy = (
    trial: PlannerState,
    split: boolean,
    compatibilityRank = 0,
  ) => {
    const placedCount = trial.allocations.length - allocationStart;
    const scored = freeSpaceStrategyScore(
      trial,
      booking,
      demand,
      allocationStart,
    );
    strategies.push({
      state: trial,
      score: [-placedCount, ...scored.score],
      canonicalKey: scored.canonicalKey,
      split,
      placementCount: placedCount,
      compatibilityRank,
    });
  };

  for (const room of rooms) {
    if (!roomHostsWholeStay(state, room, demand, booking.id)) continue;
    const trial = clonePlannerState(state);
    placePartyInRoom(trial, booking, room, demand);
    addStrategy(trial, false);
  }

  // Preserve the exact pre-scoring Phase-3 layout as a tie candidate: whole
  // party per night when possible, then the legacy split allocator. The
  // maximum matcher may beat its placement count, but an exact score tie keeps
  // the established bed assignment.
  const fallbackTrial = clonePlannerState(state);
  for (const stayDate of demand.nights) {
    const guests = demand.guestsByNight.get(stayDate) ?? [];
    const existingAdultRooms = liveExistingAdultRoomIds(
      fallbackTrial,
      booking.id,
      stayDate,
    );
    const placedWhole = tryAllocateWholeBookingNight(
      fallbackTrial,
      booking.id,
      guests,
      stayDate,
      rooms,
      existingAdultRooms,
    );
    if (!placedWhole) {
      allocateSplitBookingNight(
        fallbackTrial,
        booking,
        guests,
        stayDate,
        rooms,
        existingAdultRooms,
      );
    }
  }
  addStrategy(fallbackTrial, true);

  for (let firstIndex = 0; firstIndex < Math.max(rooms.length, 1); firstIndex += 1) {
    const orderedRooms = [
      rooms[firstIndex],
      ...rooms.filter((_, index) => index !== firstIndex),
    ].filter((room): room is SortedRoomWithBeds => Boolean(room));
    const legacyTrial = clonePlannerState(state);
    for (const stayDate of demand.nights) {
      const guests = demand.guestsByNight.get(stayDate) ?? [];
      allocateSplitBookingNight(
        legacyTrial,
        booking,
        guests,
        stayDate,
        orderedRooms,
        liveExistingAdultRoomIds(legacyTrial, booking.id, stayDate),
      );
    }
    addStrategy(legacyTrial, true, 1);
  }

  const guestOrders = splitGuestOrderVariants(state, booking, demand.guests);
  const matchingLayoutCount = Math.min(
    BED_ALLOCATION_MAX_MATCHING_LAYOUTS,
    rooms.length * guestOrders.length,
  );
  for (let layoutIndex = 0; layoutIndex < matchingLayoutCount; layoutIndex += 1) {
    // Guest variants advance fastest: every priority-aware ordering receives
    // room rotation zero before a second rotation can consume the hard budget.
    const guestOrder = guestOrders[layoutIndex % guestOrders.length];
    const firstIndex =
      Math.floor(layoutIndex / guestOrders.length) % rooms.length;
    const firstRoom = rooms[firstIndex];
    // The budget is capped at rooms x orders, so both rotations land inside
    // non-empty lists; an empty one is no layout to try, not a layout with a
    // missing room, so the search moves on rather than inventing one (#2800).
    if (guestOrder === undefined || firstRoom === undefined) continue;
    const orderedRooms = [
      firstRoom,
      ...rooms.filter((_, index) => index !== firstIndex),
    ];
    const orderByGuestId = new Map(
      guestOrder.map((guest, index) => [guest.id, index]),
    );
    const trial = clonePlannerState(state);
    const preferredRowsByGuest = indexPreferredBedRows(trial, booking.id);
    for (const stayDate of demand.nights) {
      const guests = [...(demand.guestsByNight.get(stayDate) ?? [])].sort(
        (a, b) =>
          (orderByGuestId.get(a.id) ?? 9999) -
          (orderByGuestId.get(b.id) ?? 9999),
      );
      allocateMaximumSplitBookingNight(
        trial,
        booking,
        guests,
        stayDate,
        orderedRooms,
        preferredRowsByGuest,
      );
    }
    addStrategy(trial, true, 2);
  }

  if (allowDisplacement) {
    for (const room of rooms) {
      const trial = clonePlannerState(state);
      if (tryWholeStayWithDisplacement(trial, booking, demand, [room])) {
        addStrategy(trial, false);
      }
    }
  }

  return (
    strategies.sort((a, b) => {
      const preference = compareNumberVectors(a.score, b.score);
      if (preference !== 0) return preference;
      const legacyPreference = a.compatibilityRank - b.compatibilityRank;
      return legacyPreference !== 0
        ? legacyPreference
        : a.canonicalKey.localeCompare(b.canonicalKey);
    })[0] ?? null
  );
}

interface DisplacedBookingSnapshot {
  bookingId: string;
  /** The evicted rows, sorted by (stayDate, bedId) — a deterministic snapshot. */
  rows: OccupantInfo[];
}

/**
 * Frees every visible allocation row of a provisional booking (issue #1677).
 * The rows are returned as a snapshot for the subsequent whole-stay
 * MOVE-or-UNALLOCATE re-plan. The displaced guest-nights stay in
 * `allocatedGuestNights`: an UNALLOCATE returns them to the awaiting queue for
 * the NEXT run rather than re-entering this run's demand.
 */
function evictBooking(
  state: PlannerState,
  bookingId: string,
): DisplacedBookingSnapshot {
  const rowsMap = state.occupantsByBooking.get(bookingId);
  const rows = rowsMap ? [...rowsMap.values()] : [];
  rows.sort(
    (a, b) =>
      a.stayDate.localeCompare(b.stayDate) || a.bedId.localeCompare(b.bedId),
  );
  for (const row of rows) {
    const key = occupiedKey(row.bedId, row.stayDate);
    forgetOccupantSlot(state, row.bedId, row.stayDate, row.bookingGuestId);
    // Release the PHYSICAL bed-night only when nobody is left in it.
    //
    // - A bed-night this booking SHARES with an attribution-less hold
    //   (custodian #2286, whole-lodge #2317) stays occupied: the hold keeps the
    //   bed whether or not the co-located booking is displaced.
    // - A shared DOUBLE (#1701) whose OTHER occupant belongs to a different
    //   booking stays occupied too (#2656): that occupant's row is still in the
    //   database, so freeing the key here would let the planner allocate a
    //   stranger onto an occupied bed — silently skipped at write time if the
    //   survivor is the primary, or written in beside them with no
    //   `MemberPartnerLink` if the survivor is the second occupant.
    //
    // Only the booking's own claim and its composition contribution are
    // released in either case.
    if (!state.permanentlyOccupied.has(key) && !bedNightHasOccupants(state, key)) {
      state.occupied.delete(key);
    }
    trackRoomNightOccupant(
      state,
      row.roomId,
      row.stayDate,
      row.bookingId,
      row.ageTier,
      -1,
    );
  }
  state.occupantsByBooking.delete(bookingId);
  return { bookingId, rows };
}

/**
 * Re-plans an evicted provisional booking's ENTIRE stay (issue #1677): find
 * ONE room (never `excludedRoomId`, never another lodge's room) that can host
 * every night of the stay and MOVE the rows there (a row that keeps its bed
 * emits no record — nothing moved); when no single room fits, emit UNALLOCATE
 * for ALL rows. A booking is never partially relocated and never receives
 * mixed MOVE/UNALLOCATE records in one plan.
 *
 * Apply-safety: a MOVE destination must have been free in the DATABASE at
 * plan start (or be the moving guest's own current bed). Beds vacated by
 * OTHER displacements in this plan are off limits — the lifecycle applies
 * displacements row by row against `@@unique([bedId, stayDate])`, and a
 * chained MOVE onto a not-yet-vacated bed would conflict mid-apply.
 */
function relocateOrUnallocateBooking(
  state: PlannerState,
  snapshot: DisplacedBookingSnapshot,
  displacedByBookingId: string,
  excludedRoomId?: string,
) {
  const { bookingId, rows } = snapshot;
  if (rows.length === 0) return;

  const guestOrder: string[] = [];
  const nightsByGuest = new Map<string, string[]>();
  const ageTierByGuest = new Map<
    string,
    BedAllocationAgeTier | null | undefined
  >();
  const familyGroupsByGuest = new Map<string, string[]>();
  for (const row of rows) {
    let nights = nightsByGuest.get(row.bookingGuestId);
    if (!nights) {
      nights = [];
      nightsByGuest.set(row.bookingGuestId, nights);
      ageTierByGuest.set(row.bookingGuestId, row.ageTier);
      familyGroupsByGuest.set(row.bookingGuestId, row.familyGroupIds);
      guestOrder.push(row.bookingGuestId);
    }
    nights.push(row.stayDate);
  }
  const demand = buildStayDemand(
    guestOrder.map((guestId) => ({
      id: guestId,
      ageTier: ageTierByGuest.get(guestId),
      familyGroupIds: familyGroupsByGuest.get(guestId) ?? [],
      nights: [...(nightsByGuest.get(guestId) ?? [])].sort(),
    })),
  );

  const ownRowKeys = new Set(
    rows.map((row) => occupiedKey(row.bedId, row.stayDate)),
  );
  const ownKeysByGuest = new Map<string, Set<string>>();
  for (const row of rows) {
    let keys = ownKeysByGuest.get(row.bookingGuestId);
    if (!keys) {
      keys = new Set();
      ownKeysByGuest.set(row.bookingGuestId, keys);
    }
    keys.add(occupiedKey(row.bedId, row.stayDate));
  }
  const bedNightUsable = (bedId: string, night: string) => {
    const key = occupiedKey(bedId, night);
    if (state.occupied.has(key)) return false;
    return !state.occupiedAtStart.has(key) || ownRowKeys.has(key);
  };
  const bedNightUsableForGuest = (currentState: PlannerState) =>
    (guest: StayGuest, bedId: string, night: string) => {
      const key = occupiedKey(bedId, night);
      if (currentState.occupied.has(key)) return false;
      if (!currentState.occupiedAtStart.has(key)) return true;
      return ownKeysByGuest.get(guest.id)?.has(key) ?? false;
    };

  // Lodge isolation through the re-plan (defence in depth): the booking may
  // only be relocated within the lodge of the rooms it already occupies.
  const roomById = new Map(state.activeRooms.map((room) => [room.id, room]));
  let lodgeId: string | null = null;
  for (const row of rows) {
    const room = roomById.get(row.roomId);
    if (room?.lodgeId != null) {
      lodgeId = room.lodgeId;
      break;
    }
  }
  const knownBooking = state.bookingById.get(bookingId);
  const relocationBooking: BedAllocationBooking = knownBooking ?? {
    id: bookingId,
    createdAt: new Date(0),
    lodgeId,
    requestedRoomId: rows[0]?.bookingRequestedRoomId ?? null,
    isSchoolGroup: rows[0]?.bookingIsSchoolGroup === true,
    // `buildStayDemand` keeps only guests holding at least one night, so both
    // ends of the stay are present. A guest with none has no stay range to
    // state and nothing to relocate, so it contributes no synthetic guest
    // rather than a fabricated range (#2800).
    guests: demand.guests.flatMap((guest) => {
      const firstNight = guest.nights[0];
      const lastNight = guest.nights.at(-1);
      if (firstNight === undefined || lastNight === undefined) return [];
      return [
        {
          ...guest,
          bookingId,
          stayStart: parseDateOnly(firstNight),
          stayEnd: addDaysDateOnly(parseDateOnly(lastNight), 1),
        },
      ];
    }),
  };
  const ordered = orderedCandidateRooms(
    state,
    { ...relocationBooking, lodgeId },
    demand,
  );

  const unallocateAllRows = () => {
    for (const row of rows) {
      upsertDisplacement(state.displacementByGuestNight, {
        type: "UNALLOCATE",
        bookingId,
        bookingGuestId: row.bookingGuestId,
        stayDate: row.stayDate,
        fromBedId: row.bedId,
        fromRoomId: row.roomId,
        displacedByBookingId,
      });
    }
  };

  const destinations = ordered
    .filter(
      (room) =>
        room.id !== excludedRoomId &&
        roomHostsWholeStay(state, room, demand, bookingId, bedNightUsable),
    )
    .flatMap((room) => {
      const trial = clonePlannerState(state);
      const allocationStart = trial.allocations.length;
      const assignments = assignGuestsToRoomBeds(
        trial,
        room,
        demand.guests,
        preferredBedsInRoom(rows, room.id),
        bedNightUsableForGuest(trial),
      );
      if (assignments.length !== rows.length) return [];
      trial.allocations.push(
        ...assignments.map((assignment) => ({
          bookingId,
          bookingGuestId: assignment.guest.id,
          roomId: room.id,
          bedId: assignment.bed.id,
          stayDate: assignment.stayDate,
          source: "AUTO" as const,
        })),
      );
      const scored = freeSpaceStrategyScore(
        trial,
        relocationBooking,
        demand,
        allocationStart,
      );
      return [{ room, ...scored }];
    })
    .sort((a, b) => {
      const preference = compareNumberVectors(a.score, b.score);
      return preference !== 0
        ? preference
        : a.canonicalKey.localeCompare(b.canonicalKey);
    });
  const destination = destinations[0]?.room;

  if (!destination) {
    unallocateAllRows();
    return;
  }

  const preferred = preferredBedsInRoom(rows, destination.id);
  const assignments = assignGuestsToRoomBeds(
    state,
    destination,
    demand.guests,
    preferred,
    bedNightUsableForGuest(state),
  );
  if (assignments.length !== rows.length) {
    // Defensive: the per-guest availability restriction can, in pathological
    // shapes, leave a guest-night without a bed even though the per-night
    // counts passed. Never partially relocate — roll the trial marks back and
    // unallocate the whole stay instead.
    for (const assignment of assignments) {
      const key = occupiedKey(assignment.bed.id, assignment.stayDate);
      // Mirror evictBooking's guard (#2656): only ever release a bed-night that
      // nothing else holds. `assignGuestsToRoomBeds` can only have marked
      // bed-nights that were free, so both guards are defensive here — they
      // exist so this rollback can never become the one path that frees a bed
      // out from under a surviving occupant or a hold.
      if (state.permanentlyOccupied.has(key)) continue;
      if (bedNightHasOccupants(state, key)) continue;
      state.occupied.delete(key);
    }
    unallocateAllRows();
    return;
  }
  const rowByGuestNight = new Map(
    rows.map((row) => [guestNightKey(row.bookingGuestId, row.stayDate), row]),
  );
  const sorted = [...assignments].sort((a, b) =>
    a.stayDate.localeCompare(b.stayDate),
  );
  for (const assignment of sorted) {
    const original = rowByGuestNight.get(
      guestNightKey(assignment.guest.id, assignment.stayDate),
    );
    if (!original) continue; // unreachable: assignments mirror the snapshot
    setOccupant(state, {
      ...original,
      roomId: destination.id,
      bedId: assignment.bed.id,
    });
    trackRoomNightOccupant(
      state,
      destination.id,
      assignment.stayDate,
      original.bookingId,
      original.ageTier,
      1,
    );
    if (original.bedId !== assignment.bed.id) {
      upsertDisplacement(state.displacementByGuestNight, {
        type: "MOVE",
        bookingId,
        bookingGuestId: assignment.guest.id,
        stayDate: assignment.stayDate,
        fromBedId: original.bedId,
        fromRoomId: original.roomId,
        toBedId: assignment.bed.id,
        toRoomId: destination.id,
        displacedByBookingId,
      });
    }
  }
}

/**
 * Phase 2 room feasibility (issue #1677): which whole provisional bookings must
 * be evicted from `room` so the held demand fits. Returns the eviction list
 * (possibly empty), or null when the room cannot host the stay even with
 * displacement. Per night: freeBeds + beds of wholly-displaceable provisional
 * bookings must cover the demanded party, and the same adult-coverage rule as
 * Phase 1 applies. Eviction order is newest booking first (bookingCreatedAt
 * desc, then bookingId desc), stopping once every night's shortfall is covered.
 */
function planEvictionsForRoom(
  state: PlannerState,
  booking: BedAllocationBooking,
  demand: BookingStayDemand,
  room: SortedRoomWithBeds,
): string[] | null {
  // Cross-booking age-mix invariant (#1768): a booking already mixing the
  // opposite tier into a demanded night MUST be evicted for this room to be
  // feasible — or, when it cannot be (unknown occupant, held, approved,
  // window-clipped), the room is infeasible. The demand's own rows never
  // conflict with themselves, and a minors-only night no longer requires this
  // booking's own adult in the room (minors-only rooms are allowed).
  const mandatory = new Set<string>();
  for (const night of demand.nights) {
    const guests = demand.guestsByNight.get(night) ?? [];
    if (guests.length === 0) continue;
    const hasAdult = guests.some(isAdultGuest);
    const hasMinor = guests.some((guest) => !isAdultGuest(guest));
    const byBooking = state.roomNightAgeMix.get(
      roomNightMixKey(room.id, night),
    );
    if (!byBooking) continue;
    for (const [key, counts] of byBooking) {
      if (key === booking.id) continue;
      const conflicts =
        (hasMinor && counts.adults > 0) || (hasAdult && counts.minors > 0);
      if (!conflicts) continue;
      if (key === "") return null;
      mandatory.add(key);
    }
  }
  for (const id of mandatory) {
    if (!isBookingWhollyDisplaceable(state, id)) return null;
  }

  const shortfalls = new Map<string, number>();
  for (const night of demand.nights) {
    const guests = demand.guestsByNight.get(night) ?? [];
    let free = 0;
    for (const bed of room.beds) {
      if (!state.occupied.has(occupiedKey(bed.id, night))) free += 1;
    }
    if (guests.length > free) shortfalls.set(night, guests.length - free);
  }

  /**
   * The night shortfalls left over once exactly `evictionIds` are evicted.
   *
   * Credit is counted in PHYSICAL BED-NIGHTS FREED, never in rows or bookings
   * displaced (#2656, owner directive 6). A row only frees its bed-night when
   * EVERY occupant of that bed-night is going — so one occupant of a shared
   * double leaving credits nothing while the other stays (whether the survivor
   * belongs to another booking or to the same one), and a double emptied of
   * both its occupants credits exactly ONE bed, not two.
   *
   * Both halves are load-bearing, and the per-bed-night half matters most for
   * the CROSS-BOOKING double this issue is about, not only for one booking's
   * two guests (#2669 review F2). Counting a shared double once per row makes a
   * room read as feasible for two when emptying it frees one bed;
   * `placePartyInRoom` then seats one, `tryWholeStayWithDisplacement` returns
   * true regardless, and the caller has already taken those guest-nights out of
   * the unallocated list — so a held guest-night is neither placed nor
   * reported. It simply disappears.
   */
  const remainingAfter = (evictionIds: string[]): Map<string, number> => {
    const evicting = new Set(evictionIds);
    const left = new Map(shortfalls);
    const creditedBedNights = new Set<string>();
    for (const id of evictionIds) {
      const rows = state.occupantsByBooking.get(id);
      if (!rows) continue;
      for (const row of rows.values()) {
        if (row.roomId !== room.id) continue;
        const deficit = left.get(row.stayDate);
        if (deficit === undefined) continue;
        const bedNight = occupiedKey(row.bedId, row.stayDate);
        // Already counted via this bed-night's other occupant.
        if (creditedBedNights.has(bedNight)) continue;
        // A row co-located with an attribution-less hold frees no bed when it
        // is evicted (#2317 review) — the hold still has the bed-night.
        if (state.permanentlyOccupied.has(bedNight)) continue;
        // A bed-night keeping an occupant nobody is evicting frees no bed.
        const survives = occupantsOnBedNight(state, bedNight).some(
          (occupant) => !evicting.has(occupant.bookingId),
        );
        if (survives) continue;
        creditedBedNights.add(bedNight);
        left.set(row.stayDate, deficit - 1);
      }
    }
    return left;
  };
  const anyShortfall = (left: Map<string, number>) =>
    [...left.values()].some((deficit) => deficit > 0);

  let remaining = new Map(shortfalls);
  const chosen: string[] = [];
  // Composition-mandated evictions come first, in the same newest-first order
  // as optional ones (#1677 pin); their freed beds count against the night
  // shortfalls like any other eviction.
  const mandatoryOrdered = [...mandatory]
    .map((id) => {
      const rows = state.occupantsByBooking.get(id);
      const first = rows?.values().next().value as OccupantInfo | undefined;
      return { id, createdAtMs: first?.bookingCreatedAtMs ?? 0 };
    })
    .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
  const mandatoryCount = mandatoryOrdered.length;
  for (const { id } of mandatoryOrdered) {
    chosen.push(id);
  }
  remaining = remainingAfter(chosen);

  if (anyShortfall(remaining)) {
    const candidateIds = new Set<string>();
    for (const [night, deficit] of remaining) {
      if (deficit <= 0) continue;
      for (const bed of room.beds) {
        const key = occupiedKey(bed.id, night);
        // Evicting a booking off a permanently-held bed-night frees nothing.
        if (state.permanentlyOccupied.has(key)) continue;
        // EVERY occupant of the bed-night is a candidate, not just whichever
        // one a single-entry lookup happened to return (#2656): on a shared
        // double the only wholly-displaceable occupant may be either of them.
        for (const occupant of occupantsOnBedNight(state, key)) {
          if (occupant.bookingId !== booking.id) {
            candidateIds.add(occupant.bookingId);
          }
        }
      }
    }

    const evictable = [...candidateIds]
      .filter((id) => !mandatory.has(id))
      .filter((id) => isBookingWhollyDisplaceable(state, id))
      .map((id) => {
        const rows = state.occupantsByBooking.get(id);
        const first = rows?.values().next().value as OccupantInfo | undefined;
        return { id, createdAtMs: first?.bookingCreatedAtMs ?? 0 };
      })
      .sort(
        (a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id),
      );

    for (const candidate of evictable) {
      if (!anyShortfall(remaining)) break;
      const rows = state.occupantsByBooking.get(candidate.id);
      if (!rows) continue;
      let helps = false;
      for (const row of rows.values()) {
        if (row.roomId === room.id && (remaining.get(row.stayDate) ?? 0) > 0) {
          helps = true;
          break;
        }
      }
      if (!helps) continue;
      chosen.push(candidate.id);
      remaining = remainingAfter(chosen);
    }
  }
  if (anyShortfall(remaining)) return null;

  // Drop optional evictions the final set does not need (#2656). "Helps" above
  // is deliberately loose — one occupant of a shared double has to be able to
  // enter the set BEFORE the occupant that makes it pay off — so without this
  // pass a provisional booking could be displaced (and audited as displaced)
  // having freed nothing. Composition-mandated evictions are never dropped:
  // they are required for the room's age mix, not for its bed count.
  for (let index = chosen.length - 1; index >= mandatoryCount; index -= 1) {
    const trimmed = [...chosen.slice(0, index), ...chosen.slice(index + 1)];
    if (!anyShortfall(remainingAfter(trimmed))) {
      chosen.splice(index, 1);
    }
  }
  return chosen;
}

/**
 * Phase 2 (issue #1677): whole-stay placement for a capacity-holding booking by
 * displacing whole provisional stays (#1387 preserved). The first candidate
 * room that fits with displacement wins; the chosen provisional bookings are
 * evicted whole, the held party is placed (Phase-1 bed rules), and each evicted
 * booking is then relocated to ONE other room or wholly unallocated.
 */
function tryWholeStayWithDisplacement(
  state: PlannerState,
  booking: BedAllocationBooking,
  demand: BookingStayDemand,
  candidateRooms: SortedRoomWithBeds[],
): boolean {
  for (const room of candidateRooms) {
    const evictionBookingIds = planEvictionsForRoom(
      state,
      booking,
      demand,
      room,
    );
    if (!evictionBookingIds) continue;

    const snapshots = evictionBookingIds.map((id) => evictBooking(state, id));
    placePartyInRoom(state, booking, room, demand);

    // Defence in depth (#2669 review). `placePartyInRoom` seats whoever fits
    // and this function returns true either way, while the caller has ALREADY
    // removed this booking's demanded guest-nights from
    // `unallocatedGuestNights` and will `continue` on a true return. So any
    // arithmetic slip in `planEvictionsForRoom` — over-crediting a shared bed,
    // a future feasibility rule that does not match what the bed assignment can
    // actually do — turns a held guest-night into a VANISHED one rather than a
    // reported `NO_BED_AVAILABLE`. Re-report anything the room did not seat, so
    // the worst such a slip can cost is a placement, never the record of it.
    // Costs nothing when the room did seat everyone, which is every shape the
    // suite covers.
    const reported = new Set(
      state.unallocatedGuestNights.map((row) =>
        guestNightKey(row.bookingGuestId, row.stayDate),
      ),
    );
    for (const guest of demand.guests) {
      for (const night of guest.nights) {
        const key = guestNightKey(guest.id, night);
        if (state.allocatedGuestNights.has(key) || reported.has(key)) continue;
        reported.add(key);
        state.unallocatedGuestNights.push({
          bookingId: booking.id,
          bookingGuestId: guest.id,
          stayDate: night,
          reason: allocationReasonForNoBed(state.allBeds),
        });
      }
    }

    for (const snapshot of snapshots) {
      relocateOrUnallocateBooking(state, snapshot, booking.id, room.id);
    }
    return true;
  }
  return false;
}

function placeGuestNight(
  state: PlannerState,
  booking: BedAllocationBooking,
  guest: PartyGuest,
  room: SortedRoomWithBeds,
  bed: BedAllocationBed,
  stayDate: string,
) {
  state.occupied.add(occupiedKey(bed.id, stayDate));
  state.allocatedGuestNights.add(guestNightKey(guest.id, stayDate));
  trackRoomNightOccupant(state, room.id, stayDate, booking.id, guest.ageTier, 1);
  state.allocations.push({
    bookingId: booking.id,
    bookingGuestId: guest.id,
    roomId: room.id,
    bedId: bed.id,
    stayDate,
    source: "AUTO",
  });
  removeUnallocatedGuestNight(state.unallocatedGuestNights, guest.id, stayDate);
}

/**
 * Phase 3 displacement (issue #1387 × #1677): place a still-unallocated
 * capacity-holding guest-night using the whole-booking displacement primitive.
 * A genuinely-free bed (e.g. freed by an earlier whole-booking eviction this
 * night) is used first; otherwise the first bed held by a WHOLLY-displaceable
 * provisional booking is claimed — that booking's entire stay is then moved to
 * one other room or wholly unallocated. A provisional stay is never
 * night-split by any path. Cross-booking age mix (#1768): a held minor may
 * only land where no OTHER booking's adult is present that night (rooms with
 * this booking's own adults are preferred, not required), a held adult only
 * where no other booking's minor is — and the eviction path may claim an
 * occupied bed only when evicting that occupant's booking removes the
 * conflict entirely.
 */
function tryDisplaceForHeldGuestNight(
  state: PlannerState,
  booking: BedAllocationBooking,
  guest: PartyGuest,
  stayDate: string,
  candidateRooms: SortedRoomWithBeds[],
): boolean {
  const isMinor = !isAdultGuest(guest);
  let orderedRooms = candidateRooms;
  if (isMinor) {
    const adultRooms = adultRoomsForBookingNight(
      booking,
      stayDate,
      liveExistingAdultRoomIds(state, booking.id, stayDate),
      state.allocations,
    );
    orderedRooms = [
      ...candidateRooms.filter((room) => adultRooms.has(room.id)),
      ...candidateRooms.filter((room) => !adultRooms.has(room.id)),
    ];
  }
  const blocked = (roomId: string) =>
    isMinor
      ? roomNightBlocksMinors(state, roomId, stayDate, booking.id)
      : roomNightBlocksAdults(state, roomId, stayDate, booking.id);

  for (const room of orderedRooms) {
    if (blocked(room.id)) continue;
    for (const bed of room.beds) {
      if (!state.occupied.has(occupiedKey(bed.id, stayDate))) {
        placeGuestNight(state, booking, guest, room, bed, stayDate);
        return true;
      }
    }
  }

  for (const room of orderedRooms) {
    for (const bed of room.beds) {
      const key = occupiedKey(bed.id, stayDate);
      // An attribution-less hold (custodian #2286, whole-lodge #2317) shares
      // this key with any real row on the same bed-night. Evicting that row
      // would NOT free the bed, so the bed is not a displacement target — the
      // guest-night stays unallocated instead (#2317 review).
      if (state.permanentlyOccupied.has(key)) continue;
      // Claim a bed-night only when ONE booking owns every occupant of it and
      // that whole booking is displaceable (#2656). A shared DOUBLE split
      // across two bookings is never a displacement target: evicting one of
      // them frees no bed, and taking it anyway is exactly how a stranger ends
      // up written in beside someone else's second occupant.
      // An empty bed-night is not a displacement target; reading the first
      // occupant is what says the bed-night has one at all (#2800).
      const occupants = occupantsOnBedNight(state, key);
      const occupant = occupants[0];
      if (occupant === undefined) continue;
      if (occupants.some((row) => row.bookingId !== occupant.bookingId)) {
        continue;
      }
      if (occupant.bookingId === booking.id) continue;
      if (!isBookingWhollyDisplaceable(state, occupant.bookingId)) continue;
      // Evicting this occupant must clear the room-night's composition
      // conflict for the incoming guest: any conflicting row from a booking
      // OTHER than the one being evicted keeps the room off-limits.
      const conflicting = otherRoomNightBookingsWith(
        state,
        room.id,
        stayDate,
        booking.id,
        isMinor ? "adults" : "minors",
      );
      if (conflicting.some((id) => id !== occupant.bookingId)) continue;

      const snapshot = evictBooking(state, occupant.bookingId);
      placeGuestNight(state, booking, guest, room, bed, stayDate);
      relocateOrUnallocateBooking(state, snapshot, booking.id);
      return true;
    }
  }

  return false;
}

/**
 * Bookkeeping check (#1768): rebuilds the room-night age-mix index from scratch
 * (seeded unknown rows + live occupant rows + this run's new allocations) and
 * describes the disagreement when the incrementally-maintained index diverges,
 * else null. The composition guards are only as sound as the index's symmetry
 * across seed/allocate/evict/relocate/rollback, so every planner test
 * exercises this.
 *
 * The recount is PER OCCUPANT ROW, not per bed-night (#2656): a shared DOUBLE
 * holding two people contributes two occupants to the room-night composition,
 * one under each occupant's own booking key. Sharing a bed grants no
 * composition exemption, so de-duplicating per bed-night here would silently
 * under-count the room and re-open the very hole the guard exists to close.
 *
 * It reads {@link PlannerState.occupantBySlot}, and that is deliberate: it is
 * the ONLY recount of that map and of its reverse index
 * `occupantSlotsByBedNight`, the two structures every capacity decision in this
 * file now rests on. #2595 had briefly rerouted this loop through
 * `occupantsByBooking` to work around the old `occupantByKey` losing one
 * occupant of a shared double; that workaround is superseded here, because the
 * identity map is keyed per occupant slot and is no longer lossy. Rerouting it
 * again would leave the slot index and its reverse with no consistency check at
 * all.
 */
function describeRoomNightAgeMixDivergence(
  state: PlannerState,
  guestAgeTierById: Map<string, BedAllocationAgeTier | null | undefined>,
): string | null {
  const expected = new Map<string, Map<string, RoomNightAgeCounts>>();
  const add = (
    roomId: string,
    stayDate: string,
    bookingKey: string,
    isAdult: boolean,
  ) => {
    if (!roomId) return;
    const key = roomNightMixKey(roomId, stayDate);
    let byBooking = expected.get(key);
    if (!byBooking) {
      byBooking = new Map();
      expected.set(key, byBooking);
    }
    let counts = byBooking.get(bookingKey);
    if (!counts) {
      counts = { adults: 0, minors: 0 };
      byBooking.set(bookingKey, counts);
    }
    if (isAdult) counts.adults += 1;
    else counts.minors += 1;
  };

  for (const row of state.unknownRoomNightRows) {
    add(row.roomId, row.stayDate, "", row.isAdult);
  }
  for (const row of state.occupantBySlot.values()) {
    add(row.roomId, row.stayDate, row.bookingId, isAdultAgeTier(row.ageTier));
  }
  for (const allocation of state.allocations) {
    add(
      allocation.roomId,
      allocation.stayDate,
      allocation.bookingId,
      isAdultAgeTier(guestAgeTierById.get(allocation.bookingGuestId)),
    );
  }

  const describe = (map: Map<string, Map<string, RoomNightAgeCounts>>) =>
    [...map.entries()]
      .map(
        ([key, byBooking]) =>
          `${key}=[${[...byBooking.entries()]
            .map(([id, counts]) => `${id || '""'}:a${counts.adults}m${counts.minors}`)
            .sort()
            .join(",")}]`,
      )
      .sort()
      .join(" ");
  const actualText = describe(state.roomNightAgeMix);
  const expectedText = describe(expected);
  if (actualText === expectedText) return null;
  return `bed-allocation roomNightAgeMix out of sync\n expected: ${expectedText}\n actual:   ${actualText}`;
}

/**
 * Booking-first, whole-stay-first bed allocation (issue #1677). Per booking
 * (held-first under `prioritizeCapacityHolding`, then createdAt/id):
 *
 *   Phase 0 — adult-coverage carve-out: uncoverable minor-nights leave the
 *   demand as NO_BOOKING_ADULT.
 *   Phase 1 — whole-stay placement in free space: the first candidate room
 *   (existing-allocation rooms, then the requested room, then sort order) that
 *   can host the party on EVERY night takes the whole stay, with best-effort
 *   per-guest bed stability.
 *   Phase 2 — held bookings only: whole-stay placement by displacing whole
 *   provisional stays (newest first); each displaced booking is relocated to
 *   ONE other room or wholly unallocated — never night-split, never mixed.
 *   Phase 3 — last resort: the legacy per-night whole-night/split logic, with
 *   held-booking displacement still using the whole-booking primitive. The
 *   booking id is reported in `roomContinuityFallbackBookingIds`.
 *
 * Pure and deterministic: stable sorts only, no clock or randomness — the
 * admin dashboard re-renders the same plan for the same input. It imports no
 * logger and no Sentry; a detected bookkeeping divergence is handed to the
 * caller's `onInvariantViolation` instead (#2656).
 *
 * Two distinct questions, two distinct keys (#2656). "Is this bed-night
 * unavailable?" is CAPACITY, keyed `bedId:stayDate` — one entry per physical
 * bed-night, released only when its LAST occupant leaves. "Who is in this
 * bed-night?" is IDENTITY, keyed `bedId:stayDate:bookingGuestId` — one entry
 * per occupant row, because a DOUBLE (#1701) may legitimately hold two people,
 * from two different bookings, on one night. Answering the capacity question
 * from the identity view is what let a partial eviction free a bed somebody
 * else's row was still sitting in.
 */
export function buildFirstFitBedAllocationPlan({
  enabled,
  rooms,
  bookings,
  occupiedBedNights = [],
  allocationPriorityOrder = [...BED_ALLOCATION_PRIORITY_VOCABULARY],
  prioritizeCapacityHolding = false,
  onInvariantViolation,
}: BuildBedAllocationPlanInput): BedAllocationPlan {
  if (!enabled) {
    return { allocations: [], unallocatedGuestNights: [] };
  }

  const activeRooms = sortedActiveRoomsWithBeds(rooms);
  const allBeds = activeRooms.flatMap((room) => room.beds);
  const bedRoomIds = new Map(allBeds.map((bed) => [bed.id, bed.roomId]));

  let state: PlannerState = {
    activeRooms,
    allBeds,
    occupied: new Set(),
    occupiedAtStart: new Set(),
    permanentlyOccupied: new Set(),
    occupantBySlot: new Map(),
    occupantSlotsByBedNight: new Map(),
    occupantsByBooking: new Map(),
    allocatedGuestNights: new Set(),
    allocations: [],
    unallocatedGuestNights: [],
    displacementByGuestNight: new Map(),
    roomNightAgeMix: new Map(),
    unknownRoomNightRows: [],
    allocationPriorityOrder: parseBedAllocationPriorityOrder(
      allocationPriorityOrder,
      "allocationPriorityOrder",
    ),
    bookingById: new Map(bookings.map((booking) => [booking.id, booking])),
  };

  // Age-tier fallback for occupant rows that do not carry their own tier:
  // the planner input's guest entries know it.
  const guestAgeTierById = new Map<
    string,
    BedAllocationAgeTier | null | undefined
  >();
  for (const booking of bookings) {
    for (const guest of booking.guests) {
      if (!guestAgeTierById.has(guest.id)) {
        guestAgeTierById.set(guest.id, guest.ageTier);
      }
    }
  }

  for (const night of occupiedBedNights) {
    const stayDate = normalizeStayDate(night.stayDate);
    state.occupied.add(occupiedKey(night.bedId, stayDate));
    if (night.bookingGuestId) {
      state.allocatedGuestNights.add(
        guestNightKey(night.bookingGuestId, stayDate),
      );
    }
    if (!night.bookingId || !night.bookingGuestId) {
      // Unknown occupant (#1768): tracked under the "" booking key so the
      // composition guards stay conservative — a tierless row counts as an
      // adult (blocks minors, never evictable).
      //
      // The bed-night is also pinned as permanently occupied (#2317 review):
      // a real allocation row may sit on the SAME bed-night, and evicting THAT
      // booking must not release the hold's claim on the bed along with it.
      state.permanentlyOccupied.add(occupiedKey(night.bedId, stayDate));
      const roomId = night.roomId ?? bedRoomIds.get(night.bedId) ?? "";
      trackRoomNightOccupant(state, roomId, stayDate, null, night.ageTier, 1);
      if (roomId) {
        state.unknownRoomNightRows.push({
          roomId,
          stayDate,
          isAdult: isAdultAgeTier(night.ageTier),
        });
      }
      continue;
    }
    const roomId = night.roomId ?? bedRoomIds.get(night.bedId) ?? "";
    const ageTier =
      night.ageTier ?? guestAgeTierById.get(night.bookingGuestId) ?? null;
    trackRoomNightOccupant(state, roomId, stayDate, night.bookingId, ageTier, 1);
    setOccupant(state, {
      bookingId: night.bookingId,
      bookingGuestId: night.bookingGuestId,
      roomId,
      bedId: night.bedId,
      stayDate,
      ageTier,
      familyGroupIds: [...new Set(night.familyGroupIds ?? [])].sort(),
      bookingRequestedRoomId: night.bookingRequestedRoomId ?? null,
      bookingIsSchoolGroup: night.bookingIsSchoolGroup === true,
      holdsCapacity: night.holdsCapacity === true,
      isApproved: Boolean(night.approvedAt),
      bookingCreatedAtMs: night.bookingCreatedAt
        ? new Date(night.bookingCreatedAt).getTime()
        : 0,
      stayExtendsBeyondWindow: night.stayExtendsBeyondWindow === true,
    });
  }
  // Snapshot the DATABASE occupancy before any planning: MOVE destinations are
  // restricted to beds free here, keeping the lifecycle apply order-safe.
  state.occupiedAtStart = new Set(state.occupied);

  const sortedBookings = [...bookings].sort((a, b) => {
    if (prioritizeCapacityHolding) {
      // Capacity-holding bookings claim genuinely-free beds first (issue #1387),
      // before provisional bookings consume them in the same run. Ties fall back
      // to the stable created-then-id order used everywhere else.
      const holdDiff =
        Number(b.holdsCapacity ?? false) - Number(a.holdsCapacity ?? false);
      if (holdDiff !== 0) return holdDiff;
    }
    const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
    return createdDiff !== 0 ? createdDiff : a.id.localeCompare(b.id);
  });

  const fallbackBookingIds: string[] = [];

  for (const booking of sortedBookings) {
    const bookingAllocationStart = state.allocations.length;
    const displacementKeysBefore = new Set(
      state.displacementByGuestNight.keys(),
    );
    let adoptedPartialFreeSpace = false;
    const restoreBookingOutputOrder = () => {
      if (!adoptedPartialFreeSpace) return;
      const prefix = state.allocations.slice(0, bookingAllocationStart);
      const additions = state.allocations
        .slice(bookingAllocationStart)
        .map((allocation, index) => ({ allocation, index }))
        .sort(
          (a, b) =>
            a.allocation.stayDate.localeCompare(b.allocation.stayDate) ||
            a.index - b.index,
        )
        .map(({ allocation }) => allocation);
      state.allocations = [...prefix, ...additions];
      const priorDisplacements = [
        ...state.displacementByGuestNight.entries(),
      ].filter(([key]) => displacementKeysBefore.has(key));
      const newDisplacements = [
        ...state.displacementByGuestNight.entries(),
      ]
        .filter(([key]) => !displacementKeysBefore.has(key))
        .sort(([, a], [, b]) => {
          const date = a.stayDate.localeCompare(b.stayDate);
          if (date !== 0) return date;
          const room = a.fromRoomId.localeCompare(b.fromRoomId);
          if (room !== 0) return room;
          return a.fromBedId.localeCompare(b.fromBedId);
        });
      state.displacementByGuestNight = new Map([
        ...priorDisplacements,
        ...newDisplacements,
      ]);
    };
    // Only the missing guest-nights are planned; existing rows are never
    // rewritten (only provisional displacement moves rows).
    const demanded = groupBookingGuests(booking)
      .map((guest) => ({
        ...guest,
        nights: guest.nights.filter(
          (night) =>
            !state.allocatedGuestNights.has(guestNightKey(guest.id, night)),
        ),
      }))
      .filter((guest) => guest.nights.length > 0);
    if (demanded.length === 0) continue;

    const covered = applyAdultCoverageCarveOut(state, booking, demanded);
    const demand = buildStayDemand(covered);
    if (demand.guests.length === 0) continue;

    let remainingDemand = demand;
    let candidateRooms = orderedCandidateRooms(
      state,
      booking,
      remainingDemand,
    );

    // Phase 1 — whole-stay placement in free space.
    const freeSpaceStrategy = chooseFreeSpaceStrategy(
      state,
      booking,
      demand,
      prioritizeCapacityHolding && booking.holdsCapacity === true,
    );
    const expectedPlacements = demand.guests.reduce(
      (total, guest) => total + guest.nights.length,
      0,
    );
    if (freeSpaceStrategy) {
      const isComplete =
        freeSpaceStrategy.placementCount === expectedPlacements;
      const isCapacityHolding =
        prioritizeCapacityHolding && booking.holdsCapacity === true;
      if (isComplete || !isCapacityHolding) {
        state = freeSpaceStrategy.state;
        if (freeSpaceStrategy.split) fallbackBookingIds.push(booking.id);
        continue;
      }

      // Preserve the maximum-cardinality free-space result before a held
      // booking asks displacement to fill ONLY its remaining guest-nights.
      // Throwing this state away lets the older greedy fallback place fewer
      // rows than the matcher already proved feasible.
      state = freeSpaceStrategy.state;
      adoptedPartialFreeSpace = true;
      if (
        freeSpaceStrategy.split &&
        !fallbackBookingIds.includes(booking.id)
      ) {
        fallbackBookingIds.push(booking.id);
      }
      const demandedKeys = new Set(
        demand.guests.flatMap((guest) =>
          guest.nights.map((night) => guestNightKey(guest.id, night)),
        ),
      );
      state.unallocatedGuestNights = state.unallocatedGuestNights.filter(
        (row) =>
          row.bookingId !== booking.id ||
          !demandedKeys.has(guestNightKey(row.bookingGuestId, row.stayDate)),
      );
      remainingDemand = buildStayDemand(
        demand.guests
          .map((guest) => ({
            ...guest,
            nights: guest.nights.filter(
              (night) =>
                !state.allocatedGuestNights.has(guestNightKey(guest.id, night)),
            ),
          }))
          .filter((guest) => guest.nights.length > 0),
      );
      if (remainingDemand.guests.length === 0) continue;
      candidateRooms = orderedCandidateRooms(
        state,
        booking,
        remainingDemand,
      );
    }

    // Phase 2 — held-only whole-stay via whole-booking displacement.
    if (
      prioritizeCapacityHolding &&
      booking.holdsCapacity &&
      tryWholeStayWithDisplacement(
        state,
        booking,
        remainingDemand,
        candidateRooms,
      )
    ) {
      restoreBookingOutputOrder();
      continue;
    }

    // Phase 3 — per-night split fallback (last resort).
    if (!fallbackBookingIds.includes(booking.id)) {
      fallbackBookingIds.push(booking.id);
    }
    for (const stayDate of remainingDemand.nights) {
      const guests = (remainingDemand.guestsByNight.get(stayDate) ?? []).filter(
        (guest) =>
          !state.allocatedGuestNights.has(guestNightKey(guest.id, stayDate)),
      );
      if (guests.length === 0) continue;

      const existingAdultRooms = liveExistingAdultRoomIds(
        state,
        booking.id,
        stayDate,
      );
      const placedWhole = tryAllocateWholeBookingNight(
        state,
        booking.id,
        guests,
        stayDate,
        candidateRooms,
        existingAdultRooms,
      );
      if (!placedWhole) {
        allocateSplitBookingNight(
          state,
          booking,
          guests,
          stayDate,
          candidateRooms,
          existingAdultRooms,
        );
      }

      // Held-booking displacement (issue #1387) still runs in the fallback,
      // but the displacement unit is the whole provisional booking (issue
      // #1677). Adults first, so a minor whose only adult also needs
      // displacing still finds a same-booking adult room.
      if (prioritizeCapacityHolding && booking.holdsCapacity) {
        const stillUnallocated = adultsFirst(
          guests.filter(
            (guest) =>
              !state.allocatedGuestNights.has(
                guestNightKey(guest.id, stayDate),
              ),
          ),
        );
        for (const guest of stillUnallocated) {
          tryDisplaceForHeldGuestNight(
            state,
            booking,
            guest,
            stayDate,
            candidateRooms,
          );
        }
      }
    }
    restoreBookingOutputOrder();
  }

  // A guest-night displaced more than once can collapse to its original bed —
  // nothing actually moved, so no record (and no DB write) is emitted.
  const displacements = [...state.displacementByGuestNight.values()].filter(
    (displacement) =>
      !(
        displacement.type === "MOVE" &&
        displacement.fromBedId === displacement.toBedId
      ),
  );

  // The index must stay derivable from the committed state — cheap enough to
  // verify on every test run, where any evict/relocate/rollback asymmetry
  // would otherwise ship a silent composition-guard hole. In production the
  // recount runs only when the caller asked to hear about a divergence
  // (#2656): it reports, it never throws, and it never changes the plan.
  if (process.env.NODE_ENV === "test" || onInvariantViolation) {
    const divergence = describeRoomNightAgeMixDivergence(
      state,
      guestAgeTierById,
    );
    if (divergence) {
      onInvariantViolation?.(divergence);
      if (process.env.NODE_ENV === "test") throw new Error(divergence);
    }
  }

  const plan: BedAllocationPlan = {
    allocations: state.allocations,
    unallocatedGuestNights: state.unallocatedGuestNights,
  };
  if (displacements.length > 0) {
    plan.displacements = displacements;
  }
  if (fallbackBookingIds.length > 0) {
    plan.roomContinuityFallbackBookingIds = fallbackBookingIds;
  }
  return plan;
}

// test seam
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
