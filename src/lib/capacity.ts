import { prisma } from "./prisma";
import {
  ACTIVE_BOOKING_STATUSES,
  capacityHoldingBookingFilter,
} from "@/lib/booking-status";
import {
  getLodgeCapacity,
  getLodgePartnerSharedCapacityStatus,
} from "@/lib/lodge-capacity";
import { mayShareDoubleBed } from "@/lib/double-bed-sharing";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import {
  countActiveGuestsForNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { buildLodgeCustodianNightCounter } from "@/lib/custodian-occupancy";
import { buildLodgePolicyExceptionReservationCounter } from "@/lib/booking-exception-reservations";

import { acquireLodgeCapacityLock as acquireLodgeCapacityLockKey } from "@/lib/lodge-capacity-lock";

type PrismaClient = typeof prisma;
type TransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export { getLodgeCapacity } from "@/lib/lodge-capacity";

export interface NightAvailability {
  date: Date;
  occupiedBeds: number;
  availableBeds: number;
  // True when a capacity-holding booking overlapping this night holds the
  // whole lodge exclusively (ADR-001, issue #118). A held night is hard-blocked:
  // availableBeds is pinned to 0 (never negative, so it stays OUT of the
  // over-capacity confirm set) and `available` is forced false. To members it is
  // indistinguishable from a genuinely full lodge (decision 6); an admin
  // over-capacity override cannot punch into it (decision 5).
  wholeLodgeHeld?: boolean;
}

// The admin-override over-capacity error/helpers (issue #1668) live in
// @/lib/over-capacity-confirmation, NOT here: many test files blanket-mock
// this module, and the routes' instanceof checks need the real class.

// Capacity queries scope to one lodge with a plain `lodgeId` field alongside
// the capacity-holding filter: Booking.lodgeId is NOT NULL (no null-lodge rows
// to tolerate), so the per-lodge match is exact.

/**
 * Serialize capacity-mutating booking transactions for one lodge. Replaces
 * the historical club-wide pg_advisory_xact_lock(1): bookings at different
 * lodges no longer contend. hashtextextended gives a stable per-lodge bigint
 * key; a cross-lodge hash collision only causes unnecessary serialization,
 * never a correctness problem. The lock releases at transaction end.
 *
 * $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which the
 * driver adapter cannot deserialize as a result row — $queryRaw here fails
 * at runtime on every booking transaction (found in browser verification;
 * every other advisory lock in the codebase already uses $executeRaw).
 */
export async function acquireLodgeCapacityLock(
  tx: Pick<TransactionClient, "$executeRaw">,
  lodgeId: string,
): Promise<void> {
  await acquireLodgeCapacityLockKey(tx, lodgeId);
}

function getMonthStartDateOnly(year: number, month: number): Date {
  const date = parseDateOnly(
    `${year}-${String(month + 1).padStart(2, "0")}-01`
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid month for availability: ${year}-${month + 1}`);
  }

  return date;
}

function getNextMonthStartDateOnly(year: number, month: number): Date {
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextMonthYear = month === 11 ? year + 1 : year;
  return getMonthStartDateOnly(nextMonthYear, nextMonth);
}

type OccupancyBooking = {
  checkIn?: Date | null;
  checkOut?: Date | null;
  guests?: GuestStayRange[] | null;
};

type OccupancyIndexEntry = {
  booking: OccupancyBooking;
  checkIn: Date;
  checkOut: Date;
  checkInKey: string;
  checkOutKey: string;
};

/**
 * Precompute each booking's date-only keys once (#1146). The occupancy loops
 * evaluate every (night, booking) pair, so formatting the booking range per
 * pair made month availability and capacity checks O(nights x bookings)
 * timezone conversions; the index makes each pair a string comparison.
 */
function buildOccupancyIndex(bookings: OccupancyBooking[]): OccupancyIndexEntry[] {
  const index: OccupancyIndexEntry[] = [];
  for (const booking of bookings) {
    if (!booking.checkIn || !booking.checkOut) {
      continue;
    }
    index.push({
      booking,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      // #3107: the SAME zone-free decode as the night key these are compared
      // against. Built with `formatDateOnlyForTimeZone` they were a day apart
      // from it behind Greenwich, so the occupancy window was off by one
      // (INV-DATE-013).
      checkInKey: formatDateOnly(booking.checkIn),
      checkOutKey: formatDateOnly(booking.checkOut),
    });
  }
  return index;
}

function getOccupiedBedsForNightFromIndex(
  night: Date,
  index: OccupancyIndexEntry[]
): number {
  const nightKey = formatDateOnly(night);
  let occupiedBeds = 0;

  for (const entry of index) {
    if (nightKey >= entry.checkInKey && nightKey < entry.checkOutKey) {
      occupiedBeds += countActiveGuestsForNight(entry.booking.guests, night, {
        checkIn: entry.checkIn,
        checkOut: entry.checkOut,
      });
    }
  }

  return occupiedBeds;
}

export function getOccupiedBedsForNight(
  night: Date,
  bookings: OccupancyBooking[]
): number {
  return getOccupiedBedsForNightFromIndex(night, buildOccupancyIndex(bookings));
}

type WholeLodgeHoldBooking = {
  checkIn?: Date | null;
  checkOut?: Date | null;
  wholeLodgeHold?: boolean | null;
};

type WholeLodgeHoldEntry = { checkInKey: string; checkOutKey: string };

/**
 * Precompute the date-only spans of the overlapping bookings that hold the
 * whole lodge exclusively (ADR-001, issue #118). A booking holds a night when
 * `checkIn <= night < checkOut` — the [checkIn, checkOut) half-open span, so a
 * held booking departing on day D does NOT block another booking arriving that
 * night (back-to-back handovers stay correct).
 */
function buildWholeLodgeHoldIndex(
  bookings: WholeLodgeHoldBooking[]
): WholeLodgeHoldEntry[] {
  const index: WholeLodgeHoldEntry[] = [];
  for (const booking of bookings) {
    if (!booking.wholeLodgeHold || !booking.checkIn || !booking.checkOut) {
      continue;
    }
    index.push({
      checkInKey: formatDateOnly(booking.checkIn),
      checkOutKey: formatDateOnly(booking.checkOut),
    });
  }
  return index;
}

function isNightWholeLodgeHeld(
  night: Date,
  index: WholeLodgeHoldEntry[]
): boolean {
  if (index.length === 0) return false;
  const nightKey = formatDateOnly(night);
  return index.some(
    (entry) => nightKey >= entry.checkInKey && nightKey < entry.checkOutKey
  );
}

/**
 * Two bookings overlap on at least one night when their [checkIn, checkOut)
 * half-open spans intersect. A booking departing on day D and one arriving that
 * night do NOT overlap (back-to-back handovers) — the same half-open rule the
 * hold-night span uses. Pure; admin conflict surfacing (issue #119) shares it.
 */
export function bookingsOverlap(
  a: { checkIn: Date; checkOut: Date },
  b: { checkIn: Date; checkOut: Date }
): boolean {
  return (
    a.checkIn.getTime() < b.checkOut.getTime() &&
    a.checkOut.getTime() > b.checkIn.getTime()
  );
}

/**
 * Lodge equality tolerant of the expand-release null lodgeId (a null on either
 * side matches, mirroring lodgeNullTolerantScope). Used by admin conflict
 * surfacing (issue #119) when matching a hold to an overlapping booking
 * in-memory.
 */
export function sameLodgeNullTolerant(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return a == null || b == null || a === b;
}

export interface HoldConflictBooking {
  id: string;
  memberName: string;
  /** YYYY-MM-DD (date-only lodge nights). */
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
  /**
   * True for the override-settle blind-spot surfacing (ADR-001 decision 1,
   * issue #177): this overlapping booking is NOT capacity-holding yet, but it
   * carries a persisted `capacityOverriddenAt` marker, so a payment-time /
   * settlement re-check will admit it onto the held nights unchecked (the
   * documented decision-1 carve-out — settlement is deliberately unchanged).
   * The officer sees it flagged distinctly ("overridden, not yet holding") so
   * the future settle is not a silent surprise. Absent/false on the ordinary
   * capacity-holding conflicts from `findOverlappingCapacityHoldingBookings`.
   */
  overridden?: boolean;
}

/**
 * Admin conflict surfacing (ADR-001 decision 1, issue #119): the existing
 * capacity-holding bookings that overlap [checkIn, checkOut) at `lodgeId`,
 * excluding `excludeBookingId` (the booking receiving the hold). Reuses the
 * capacity-holding population filter (`capacityHoldingBookingFilter`) and the
 * same overlap window as the capacity engine, rather than inventing a new one.
 *
 * Read-only and purely INFORMATIONAL: setting/approving a hold never refuses,
 * blocks, or displaces (decision 1) — this only makes the clash obvious to the
 * booking officer, who resolves it manually. It is called ONLY from admin paths;
 * members are never told a lodge is exclusively held (decision 6).
 */
export async function findOverlappingCapacityHoldingBookings(
  db: Pick<TransactionClient, "booking">,
  input: {
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
    excludeBookingId?: string;
  }
): Promise<HoldConflictBooking[]> {
  const start = storedDateOnly(input.checkIn);
  const end = storedDateOnly(input.checkOut);
  const rows = await db.booking.findMany({
    where: {
      checkIn: { lt: end },
      checkOut: { gt: start },
      deletedAt: null,
      // Capacity-holding population (issue #1254) spread at top level; the
      // exact per-lodge scope + date/exclusion clauses compose under it.
      ...capacityHoldingBookingFilter(),
      lodgeId: input.lodgeId,
      ...(input.excludeBookingId ? { id: { not: input.excludeBookingId } } : {}),
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      status: true,
      member: { select: { firstName: true, lastName: true, email: true } },
      _count: { select: { guests: true } },
    },
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    memberName:
      [row.member?.firstName, row.member?.lastName].filter(Boolean).join(" ") ||
      row.member?.email ||
      "Unknown member",
    checkIn: formatDateOnly(row.checkIn),
    checkOut: formatDateOnly(row.checkOut),
    guestCount: row._count.guests,
    status: row.status,
  }));
}

/**
 * Companion to `findOverlappingCapacityHoldingBookings` for the override-settle
 * blind spot (ADR-001 decision 1, issue #177): the ACTIVE, NOT-yet-capacity-
 * holding bookings that overlap [checkIn, checkOut) at `lodgeId` AND carry a
 * persisted `capacityOverriddenAt` marker (excluding `excludeBookingId`).
 *
 * Why a SEPARATE query rather than widening the sibling: the capacity-holding
 * conflict list is reused by the booking detail page and the school approval,
 * and its contract is exactly "the capacity-holding overlaps". An overridden
 * PAYMENT_PENDING booking is not capacity-holding (a PAYMENT_PENDING booking
 * holds only under an admin capacity hold, #1764), so
 * `capacityHoldingBookingFilter()` — and therefore the sibling — never sees it.
 * Yet the settlement carve-out (`payment-reconciliation.ts`, #1771) will admit
 * that override onto the held nights unchecked, so at hold-set the officer must
 * be told it exists. This surfaces it, marked `overridden: true`, WITHOUT
 * changing the sibling's semantics for its other callers.
 *
 * Scope: `NOT capacityHoldingBookingFilter()` excludes anything already listed
 * by the sibling (no double-count); `status in ACTIVE_BOOKING_STATUSES` excludes
 * cancelled/bumped/draft rows that can never settle onto the nights, leaving the
 * live blind-spot population (chiefly overridden PAYMENT_PENDING). Read-only and
 * INFORMATIONAL, admin-only — it never refuses, blocks, or displaces (decision
 * 1), and it does NOT change settlement behaviour (the carve-out stays as
 * documented; this only makes the future settle visible up front).
 */
export async function findOverlappingOverriddenNonHoldingBookings(
  db: Pick<TransactionClient, "booking">,
  input: {
    lodgeId: string;
    checkIn: Date;
    checkOut: Date;
    excludeBookingId?: string;
  }
): Promise<HoldConflictBooking[]> {
  const start = storedDateOnly(input.checkIn);
  const end = storedDateOnly(input.checkOut);
  const rows = await db.booking.findMany({
    where: {
      checkIn: { lt: end },
      checkOut: { gt: start },
      deletedAt: null,
      lodgeId: input.lodgeId,
      // Persisted admin override (#1771) but NOT yet in the capacity-holding
      // population — the exact settle-time blind spot (#177).
      capacityOverriddenAt: { not: null },
      status: { in: [...ACTIVE_BOOKING_STATUSES] },
      NOT: capacityHoldingBookingFilter(),
      ...(input.excludeBookingId ? { id: { not: input.excludeBookingId } } : {}),
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      status: true,
      member: { select: { firstName: true, lastName: true, email: true } },
      _count: { select: { guests: true } },
    },
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    memberName:
      [row.member?.firstName, row.member?.lastName].filter(Boolean).join(" ") ||
      row.member?.email ||
      "Unknown member",
    checkIn: formatDateOnly(row.checkIn),
    checkOut: formatDateOnly(row.checkOut),
    guestCount: row._count.guests,
    status: row.status,
    overridden: true,
  }));
}

/**
 * Admin capacity-reporting companion to `getLodgeCapacityStatus`
 * (src/lib/lodge-capacity.ts, issue #119): which nights in [checkIn, checkOut)
 * at `lodgeId` are whole-lodge-held by a capacity-holding booking (ADR-001).
 * Lives here — not in lodge-capacity.ts — so it reuses the capacity engine's
 * own hold-night span logic (`buildWholeLodgeHoldIndex` / `isNightWholeLodgeHeld`)
 * rather than duplicating it; getLodgeCapacityStatus takes no date range, so a
 * companion is the additive, backward-compatible way to report held nights.
 *
 * Admin-only reporting: members never see held nights (decision 6 — to them a
 * held night is an ordinary full lodge).
 */
export async function getLodgeHeldNights(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  tx?: TransactionClient
): Promise<string[]> {
  const db = tx ?? prisma;
  const start = storedDateOnly(checkIn);
  const end = storedDateOnly(checkOut);
  const nights = eachDateOnlyInRange(start, end);
  if (nights.length === 0) return [];

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: end },
      checkOut: { gt: start },
      wholeLodgeHold: true,
      // Only a capacity-holding hold blocks (a cancelled/expired hold does not),
      // matching the capacity engine's overlap population exactly.
      ...capacityHoldingBookingFilter(),
      lodgeId,
    },
    select: { checkIn: true, checkOut: true, wholeLodgeHold: true },
  });

  const holdIndex = buildWholeLodgeHoldIndex(overlappingBookings);
  return nights
    .filter((night) => isNightWholeLodgeHeld(night, holdIndex))
    .map(formatDateOnly);
}

/** One night's occupancy, as {@link computeNightOccupancy} reports it. */
export interface NightOccupancy {
  /**
   * Beds occupied on this night by every counted term, with NO whole-lodge pin
   * applied. Callers that present a held night as a full lodge apply that
   * themselves — see {@link wholeLodgeHeld}.
   */
  occupiedBeds: number;
  /**
   * A capacity-holding booking holds the whole lodge exclusively this night
   * (ADR-001, issue #118). Reported as a flag rather than folded into
   * `occupiedBeds` because what a held night should LOOK like is the one thing
   * the callers genuinely disagree about.
   */
  wholeLodgeHeld: boolean;
}

/**
 * THE occupancy calculation (#2681). "How many beds are occupied at this lodge
 * on this night" is computed here and nowhere else.
 *
 * It used to be written out SIX times — four near-identical copies in this
 * file, one in `cron-capacity-warnings.ts`, and one in `validateCustodianBedHold`
 * (`custodian-assignment.ts`). The cron copy had silently drifted **three
 * terms** behind the others (#713 explicit guest nights, #2525 policy-exception
 * reservations, and the ADR-001 whole-lodge hold) and the custodian copy one
 * (#2525). Two of the cron's three misses made it under-report and stay silent
 * about a lodge that was genuinely full; the #713 miss went the other way and
 * made it over-report on a sparse stay's gap nights. Every term now lives here
 * exactly once, and `src/lib/__tests__/night-occupancy-census.test.ts` fails the
 * build if a seventh copy appears or if any term is dropped from this function.
 *
 * ## The terms, and the issue that added each
 *
 * 1. **Booked guest nights (#713)** — the capacity-holding bookings
 *    (`capacityHoldingBookingFilter()`, issue #1254) overlapping the window at
 *    this lodge, counted per night through each guest's EXPLICIT night set. The
 *    query loads `guests: { include: { nights: true } }` and not `guests: true`
 *    for exactly that reason: with no night rows loaded,
 *    `isGuestActiveOnNight` falls back to the `stayStart`/`stayEnd` envelope
 *    and a sparse, non-contiguous stay is counted on its gap nights.
 * 2. **Custodian bed holds (#2286)** — a bed held for a season by a hut-leader
 *    assignment has no booking and no guest row, so it is invisible to the
 *    occupancy index. Counted as an OCCUPANT, not as a smaller ceiling, so
 *    `occupiedBeds + availableBeds === lodgeCapacity` still holds on every
 *    night (the #155 payload contract).
 * 3. **Policy-exception reservations (#2525)** — a HELD exception request's
 *    provisionally reserved beds are unavailable until the request is
 *    rejected/cancelled/superseded or approved. Read under the same per-lodge
 *    capacity lock the claim is written under, so a held request never oversells.
 * 4. **Whole-lodge holds (ADR-001, #118)** — reported as a per-night flag.
 *
 * ## Lock topology is unchanged
 *
 * No read moved OUT of a lock, which is the direction that could oversell.
 * Every read happens on the caller's `db`, which is the caller's transaction
 * client whenever it has one, so the four engines make byte-for-byte the same
 * reads on the same client inside the same `acquireLodgeCapacityLock` as
 * before this was extracted. Two surfaces gain a read, both deliberately:
 * `validateCustodianBedHold` gains the #2525 reservation read it was missing,
 * INSIDE the same per-lodge lock it already held; the capacity-warnings cron
 * gains the reservation read and the guest-night rows, unlocked on `prisma` as
 * that cron has always run. `getMonthAvailability` is unchanged and has never
 * held a lock.
 *
 * `db` is optional and falls back to `prisma`, so a transactional caller that
 * FORGOT to pass it would read outside its lock. That is the one way to
 * reintroduce the hazard, so `night-occupancy-census.test.ts` asserts that
 * every caller which has a transaction client passes it.
 */
export async function computeNightOccupancy(input: {
  lodgeId: string;
  /** Inclusive first night, a UTC date-only value. */
  from: Date;
  /** Exclusive end, a UTC date-only value. */
  toExclusive: Date;
  /** Nights to report on — normally `eachDateOnlyInRange(from, toExclusive)`. */
  nights: readonly Date[];
  /** Drop one booking from the population (the booking being edited). */
  excludeBookingId?: string;
  /**
   * Drop one hut-leader assignment's own custodian hold. Used only by the
   * custodian write path, which is asking what occupancy would be with the
   * assignment it is about to write counted exactly once, by itself.
   */
  excludeCustodianAssignmentId?: string;
  db?: TransactionClient;
}): Promise<(night: Date) => NightOccupancy> {
  const db = input.db ?? prisma;

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: input.toExclusive },
      checkOut: { gt: input.from },
      // Capacity-holding population (issue #1254) spread at top level; the
      // per-lodge scope (also an OR fragment) goes under AND so the two OR
      // conditions compose — a second top-level OR would clobber the first.
      // `Booking.lodgeId` is NOT NULL, so the plain field match is exact.
      ...capacityHoldingBookingFilter(),
      lodgeId: input.lodgeId,
      ...(input.excludeBookingId ? { id: { not: input.excludeBookingId } } : {}),
    },
    include: {
      // Term 1: each guest's explicit night set (issue #713), so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests with
      // no night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const occupancyIndex = buildOccupancyIndex(overlappingBookings);
  // Term 4.
  const holdIndex = buildWholeLodgeHoldIndex(overlappingBookings);
  // Term 2.
  const custodianCount = await buildLodgeCustodianNightCounter({
    lodgeId: input.lodgeId,
    from: input.from,
    toExclusive: input.toExclusive,
    nights: input.nights,
    excludeAssignmentId: input.excludeCustodianAssignmentId,
    db,
  });
  // Term 3.
  const reservationCount = await buildLodgePolicyExceptionReservationCounter({
    lodgeId: input.lodgeId,
    from: input.from,
    toExclusive: input.toExclusive,
    nights: input.nights,
    db,
  });

  return (night: Date) => ({
    occupiedBeds:
      getOccupiedBedsForNightFromIndex(night, occupancyIndex) +
      custodianCount(night) +
      reservationCount(night),
    wholeLodgeHeld: isNightWholeLodgeHeld(night, holdIndex),
  });
}

/**
 * Check if there's enough capacity for a given number of guests across all nights.
 */
export async function checkCapacity(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<{ available: boolean; minAvailable: number; nightDetails: NightAvailability[] }> {
  const db = tx ?? prisma;
  const lodgeCapacity = await getLodgeCapacity(lodgeId, db);
  const start = storedDateOnly(checkIn);
  const exclusiveEnd = storedDateOnly(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  const occupancy = await computeNightOccupancy({
    lodgeId,
    from: start,
    toExclusive: exclusiveEnd,
    nights,
    excludeBookingId,
    db,
  });

  const nightDetails: NightAvailability[] = nights.map((night) => {
    const { occupiedBeds, wholeLodgeHeld } = occupancy(night);

    return {
      date: night,
      // A held night's occupiedBeds is pinned to lodgeCapacity, mirroring
      // getMonthAvailability's pinning (ADR-001 decision 6, issue #118): to a
      // member reading this result (e.g. the raw availability/check payload,
      // issue #155) a held-but-not-full night must be indistinguishable from
      // a genuinely full lodge, and occupiedBeds + availableBeds must equal
      // lodgeCapacity on every night, not just full ones.
      occupiedBeds: wholeLodgeHeld ? lodgeCapacity : occupiedBeds,
      // A held night is hard-blocked at 0 — never negative, so it stays out of
      // the over-capacity confirm set and cannot be bypassed by an admin
      // override (ADR-001 decision 5, issue #118).
      availableBeds: wholeLodgeHeld ? 0 : lodgeCapacity - occupiedBeds,
      wholeLodgeHeld,
    };
  });

  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));
  const hasHeld = nightDetails.some((n) => n.wholeLodgeHeld);

  return {
    // A held night presents exactly as a full lodge (decision 6): unavailable
    // regardless of the numeric bed count.
    available: minAvailable >= guestCount && !hasHeld,
    minAvailable,
    nightDetails,
  };
}

// The two REAL differences between checkCapacity and checkCapacityForGuestRanges
// (#2681). Every other line the two used to share now lives in
// computeNightOccupancy, so these are the only things left to disagree about:
//
// 1. What `occupiedBeds` MEANS. checkCapacity reports existing occupancy and
//    pins a held night to lodgeCapacity, because a member reading that payload
//    (issue #155) must not be able to tell a held night from a genuinely full
//    one (ADR-001 decision 6). checkCapacityForGuestRanges reports existing
//    occupancy PLUS the proposal being tested, which is a different quantity —
//    pinning it to lodgeCapacity would discard the proposal, so it does not pin.
//    Its `availableBeds` is still hard-pinned to 0 on a held night, which is
//    what every consumer actually reads.
// 2. The sufficiency test. checkCapacity is asked "do `guestCount` beds fit?",
//    so it needs `minAvailable >= guestCount`; checkCapacityForGuestRanges has
//    already subtracted the proposal, so it needs `minAvailable >= 0`.
//
// This supersedes the pre-#2681 note here, which explained why the two were NOT
// unified: "re-verifying every consumer each time a new one is added is a bigger
// surface than this fix needs." That reasoning is what let the #2525 term reach
// four surfaces and miss the fifth. The shared arithmetic is now unified in one
// place regardless of consumer count, and the census test keeps it that way.

export async function checkCapacityForGuestRanges(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  guests: GuestStayRange[],
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<{ available: boolean; minAvailable: number; nightDetails: NightAvailability[] }> {
  const db = tx ?? prisma;
  const lodgeCapacity = await getLodgeCapacity(lodgeId, db);
  const start = storedDateOnly(checkIn);
  const exclusiveEnd = storedDateOnly(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  if (nights.length === 0) {
    return { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
  }

  // Every occupancy term (bookings with explicit nights, custodian holds,
  // policy-exception reservations, whole-lodge holds) comes from the one
  // implementation, so this engine cannot drift from the others.
  const occupancy = await computeNightOccupancy({
    lodgeId,
    from: start,
    toExclusive: exclusiveEnd,
    nights,
    excludeBookingId,
    db,
  });

  const nightDetails: NightAvailability[] = nights.map((night) => {
    const { occupiedBeds, wholeLodgeHeld } = occupancy(night);
    const proposedBeds = countActiveGuestsForNight(guests, night, {
      checkIn: start,
      checkOut: exclusiveEnd,
    });

    return {
      date: night,
      occupiedBeds: occupiedBeds + proposedBeds,
      // A held night is hard-blocked at 0 — never negative, so it stays out of
      // the over-capacity confirm set (overCapacityNights) and cannot be
      // bypassed by an admin override (ADR-001 decision 5, issue #118).
      availableBeds: wholeLodgeHeld ? 0 : lodgeCapacity - occupiedBeds - proposedBeds,
      wholeLodgeHeld,
    };
  });

  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));
  const hasHeld = nightDetails.some((n) => n.wholeLodgeHeld);

  return {
    // A held night presents exactly as a full lodge (decision 6): unavailable
    // even when the numeric bed arithmetic would fit.
    available: minAvailable >= 0 && !hasHeld,
    minAvailable,
    nightDetails,
  };
}

// A proposed non-sharing guest. `memberId` (when the guest is a member) lets
// a sharer's partner coverage be anchored to a guest in this same proposal —
// the sharer-joins-the-partner's-own-booking case, where excludeBookingId
// removes the partner's existing row from the occupancy query.
export interface PartnerSharedProposedGuest extends GuestStayRange {
  memberId?: string | null;
}

export interface PartnerSharedAdmissionSharer {
  range: GuestStayRange;
  memberId: string;
  partnerMemberId: string;
}

export interface PartnerSharedNightDetail extends NightAvailability {
  sharedSlotsUsed: number;
  sharedSlotsNeeded: number;
}

export interface PartnerSharedAdmissionResult {
  available: boolean;
  reason: string | null;
  minAvailable: number;
  partnerSharedHeadroom: number;
  nightDetails: PartnerSharedNightDetail[];
}

/**
 * Admission check for admin-initiated partner-shared bookings (#1745).
 *
 * The base lodge ceiling (`getLodgeCapacity`) is untouched — public booking
 * paths keep calling checkCapacityForGuestRanges and never see the extra
 * slots. This variant admits `sharers` beyond that ceiling, one per active
 * DOUBLE bed (the partner-shared headroom, see docs/CAPACITY_MODEL.md),
 * under the owner-decided rule (#1745): a guest is admitted if a base slot
 * is free, OR they hold a CONFIRMED partner link with a member staying on
 * every night they stay AND a shared slot is free that night.
 * `ordinaryGuests` can never consume a shared slot — the headroom is
 * reserved, not a blanket bump.
 *
 * Placeability: each shared admission maps to a distinct double ONLY when
 * the sharer's partner holds an ordinary (base-backed) place. The guards
 * below enforce the structural half of that — a sharer can never anchor
 * another sharer, and same-proposal coverage must come from a non-sharing
 * proposed guest — but a partner admitted above base through the #1668
 * over-capacity override can still anchor a sharer; both are explicit admin
 * overrides and the combination can exceed pairing feasibility (see
 * docs/CAPACITY_MODEL.md). Placement itself stays the allocation board's
 * job and may require moving unlocked allocations.
 *
 * Callers run inside the lodge capacity lock like every other admission
 * path (acquireLodgeCapacityLock) so shared slots cannot be double-admitted
 * concurrently.
 */
export async function checkCapacityForPartnerSharedAdmission(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  ordinaryGuests: PartnerSharedProposedGuest[],
  sharers: PartnerSharedAdmissionSharer[],
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<PartnerSharedAdmissionResult> {
  const db = tx ?? prisma;
  const status = await getLodgePartnerSharedCapacityStatus(lodgeId, db);
  const baseCapacity = status.capacity;
  const headroom = status.partnerSharedHeadroom;

  const start = storedDateOnly(checkIn);
  const exclusiveEnd = storedDateOnly(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);
  const envelope = { checkIn: start, checkOut: exclusiveEnd };

  if (nights.length === 0) {
    return {
      available: true,
      reason: null,
      minAvailable: Number.POSITIVE_INFINITY,
      partnerSharedHeadroom: headroom,
      nightDetails: [],
    };
  }

  function rejected(reason: string): PartnerSharedAdmissionResult {
    return {
      available: false,
      reason,
      minAvailable: 0,
      partnerSharedHeadroom: headroom,
      nightDetails: [],
    };
  }

  // Structural placeability guards: a shared slot pairs the sharer with a
  // base-backed partner, so a sharer can never anchor another sharer — a
  // couple must be encoded as one ordinary guest (or existing booking) plus
  // one sharer, never as two sharers. Duplicates would let one person
  // consume two slots.
  const sharerIds = new Set<string>();
  for (const sharer of sharers) {
    if (sharerIds.has(sharer.memberId)) {
      return rejected(
        "The same guest was proposed as a partner-sharer more than once."
      );
    }
    sharerIds.add(sharer.memberId);
  }
  for (const sharer of sharers) {
    if (sharerIds.has(sharer.partnerMemberId)) {
      return rejected(
        "Both members of a couple were proposed as partner-sharers. The partner must hold an ordinary place; only the second occupant is a sharer."
      );
    }
  }

  // Every sharer pair must be eligible outright — an ineligible "sharer" must
  // not silently fall back to an ordinary slot the admin did not intend.
  for (const sharer of sharers) {
    const eligible = await mayShareDoubleBed(
      sharer.memberId,
      sharer.partnerMemberId,
      db
    );
    if (!eligible) {
      return rejected(
        "The guest and their partner do not hold a confirmed partner relationship (or are not both active adults)."
      );
    }
  }

  // Partner night coverage: a shared slot exists only on nights the partner
  // is themselves staying. Coverage comes from a non-sharing guest in this
  // same proposal carrying the partner's memberId (the sharer-joins-the-
  // partner's-own-booking case, where excludeBookingId removes the partner's
  // existing row from occupancy), or from the partner's other capacity-
  // holding bookings at this lodge. Never from an unverified caller claim.
  const coverageBySharer: Array<Set<string>> = [];
  for (const sharer of sharers) {
    const covered = new Set<string>();
    const proposedPartnerRows = ordinaryGuests.filter(
      (guest) => guest.memberId === sharer.partnerMemberId
    );
    for (const night of nights) {
      if (
        proposedPartnerRows.length > 0 &&
        countActiveGuestsForNight(proposedPartnerRows, night, envelope) > 0
      ) {
        covered.add(formatDateOnly(night));
      }
    }

    // Only hit the database for nights the proposal itself does not cover.
    const sharerNightsUncovered = nights.some(
      (night) =>
        countActiveGuestsForNight([sharer.range], night, envelope) > 0 &&
        !covered.has(formatDateOnly(night))
    );
    if (sharerNightsUncovered) {
      const partnerGuests = await db.bookingGuest.findMany({
        where: {
          memberId: sharer.partnerMemberId,
          booking: {
            lodgeId,
            checkIn: { lt: exclusiveEnd },
            checkOut: { gt: start },
            // Nested under AND so the holding filter's top-level OR composes
            // with the scope fields (same pitfall as the occupancy queries).
            AND: [capacityHoldingBookingFilter()],
            ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
          },
        },
        include: {
          nights: true,
          booking: { select: { checkIn: true, checkOut: true } },
        },
      });
      const guestEnvelopes = partnerGuests.map((guest) => ({
        guest,
        checkInKey: formatDateOnly(guest.booking.checkIn),
        checkOutKey: formatDateOnly(guest.booking.checkOut),
      }));
      for (const night of nights) {
        const nightKey = formatDateOnly(night);
        if (covered.has(nightKey)) continue;
        // Gate on the booking envelope exactly like the occupancy index does,
        // so a stray night row outside its booking window can never grant
        // coverage occupancy would not count.
        const present = guestEnvelopes.some(
          (entry) =>
            nightKey >= entry.checkInKey &&
            nightKey < entry.checkOutKey &&
            countActiveGuestsForNight([entry.guest], night, {
              checkIn: entry.guest.booking.checkIn,
              checkOut: entry.guest.booking.checkOut,
            }) > 0
        );
        if (present) covered.add(nightKey);
      }
    }
    coverageBySharer.push(covered);
  }

  // Base occupancy from the one implementation. The custodian term carries an
  // ACCEPTED OVERSHOOT on this path, documented in docs/CAPACITY_MODEL.md and
  // pinned by a test: `headroom` comes from getLodgePartnerSharedCapacityStatus,
  // which is undated and still counts a custodian-held DOUBLE toward
  // partnerSharedHeadroom — so an admin can be admitted a sharer when zero
  // physically shareable doubles remain. At PLACEMENT level nothing can go
  // wrong (a custodian bed has no primary allocation row to share, and the
  // allocation guard sits in front), and the overshoot is admin-only and
  // analogous to the accepted #1668 over-capacity override.
  const occupancy = await computeNightOccupancy({
    lodgeId,
    from: start,
    toExclusive: exclusiveEnd,
    nights,
    excludeBookingId,
    db,
  });

  let reason: string | null = null;
  const nightDetails: PartnerSharedNightDetail[] = nights.map((night) => {
    const nightKey = formatDateOnly(night);
    const { occupiedBeds: occupied, wholeLodgeHeld } = occupancy(night);
    const ordinary = countActiveGuestsForNight(ordinaryGuests, night, envelope);
    if (wholeLodgeHeld) {
      // A whole-lodge hold (ADR-001, issue #118) hard-blocks this night even for
      // the admin-initiated partner-shared admission path — decision 5: a hold is
      // not bypassable by any admin override. Pinned to availableBeds 0 (never
      // negative) and surfaced via `reason`.
      reason ??=
        "The lodge is exclusively held for another booking for part of the requested stay.";
    }

    let sharersPresent = 0;
    for (const [index, sharer] of sharers.entries()) {
      if (countActiveGuestsForNight([sharer.range], night, envelope) === 0) {
        continue;
      }
      if (!coverageBySharer[index].has(nightKey)) {
        // A shared slot exists only on nights the partner also stays.
        reason ??=
          "The partner is not staying on every night requested for the shared guest.";
        continue;
      }
      sharersPresent += 1;
    }

    // Any existing occupancy above the base ceiling counts as consumed shared
    // slots. Usually that IS prior shared admissions, but a #1668 forced
    // overbook also lands here — deliberately conservative: forced overage
    // shrinks what sharers may add (it can only mislabel the reason, never
    // overbook further).
    const baseUsed = Math.min(occupied, baseCapacity);
    const sharedUsed = occupied - baseUsed;

    // Ordinary guests fit under the base ceiling only — the shared slots are
    // reserved for partner-sharers.
    const baseFreeAfterOrdinary = baseCapacity - baseUsed - ordinary;
    if (baseFreeAfterOrdinary < 0) {
      reason ??= "The lodge is fully booked for part of the requested stay.";
    }

    // Sharers take a free base slot first (anyone may, below the ceiling);
    // the remainder need shared slots.
    const sharedNeeded = Math.max(
      0,
      sharersPresent - Math.max(0, baseFreeAfterOrdinary)
    );
    if (sharedUsed + sharedNeeded > headroom) {
      reason ??=
        headroom === 0
          ? "This lodge has no shareable double beds (or its capacity setting leaves no partner headroom)."
          : "All partner-shared double-bed slots are taken for part of the requested stay.";
    }

    const totalProposed = ordinary + sharersPresent;
    return {
      date: night,
      occupiedBeds: occupied + totalProposed,
      availableBeds: wholeLodgeHeld
        ? 0
        : baseCapacity + headroom - occupied - totalProposed,
      sharedSlotsUsed: sharedUsed,
      sharedSlotsNeeded: sharedNeeded,
      wholeLodgeHeld,
    };
  });

  // A sharer whose range covers a night the partner does not was counted out
  // of sharersPresent above; surface it as unavailable even if the arithmetic
  // happened to pass.
  const available = reason === null;
  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));

  return {
    available,
    reason,
    minAvailable,
    partnerSharedHeadroom: headroom,
    nightDetails,
  };
}

/**
 * Get a monthly availability summary for calendar display at one lodge.
 */
export async function getMonthAvailability(
  lodgeId: string,
  year: number,
  month: number
): Promise<Map<string, number>> {
  const startDate = getMonthStartDateOnly(year, month);
  const endDate = getNextMonthStartDateOnly(year, month);
  const lodgeCapacity = await getLodgeCapacity(lodgeId);

  const availability = new Map<string, number>();
  const nights = eachDateOnlyInRange(startDate, endDate);
  // Both calendars (member `api/availability/route.ts`, admin
  // `api/admin/bookings/route.ts`) compute `available = capacity - occupied`
  // from this map themselves, so counting every occupancy term here makes both
  // correct with zero consumer changes. Owner decision (29 Jul): NO
  // custodian-specific label on the member-facing calendar — the lodge simply
  // shows one fewer bed, indistinguishable from any occupied bed, so nothing
  // about who is in the building leaks to a member. The same is true of a held
  // policy-exception request's reserved beds.
  const occupancy = await computeNightOccupancy({
    lodgeId,
    from: startDate,
    toExclusive: endDate,
    nights,
  });

  for (const night of nights) {
    const { occupiedBeds, wholeLodgeHeld } = occupancy(night);
    const key = formatDateOnly(night);
    // A whole-lodge-held night (ADR-001, issue #118) must be indistinguishable
    // from a genuinely full lodge on the public calendar (decision 6): report
    // full occupancy so no free beds are ever shown, regardless of the real
    // headcount on that night. Otherwise a held-but-not-full night would leak
    // the hold — a member could tell it apart from a full lodge.
    availability.set(key, wholeLodgeHeld ? lodgeCapacity : occupiedBeds);
  }

  return availability;
}
