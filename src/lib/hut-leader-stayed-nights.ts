import type { Prisma } from "@prisma/client";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { getGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  requireCalendarDate,
} from "@/lib/club-time";

/**
 * Which lodge nights a member is STAYING, for the hut-leader writers (#3817).
 *
 * A hut-leader assignment claims lodge nights (`INV-DATE-002`), and the owner
 * decided (2 Oct 2026, #3789/#3820, "Block it outright") that an officer cannot
 * assign a night the member is not staying. "Staying" here is exactly what the
 * eligible-members suggestion path already used, so the list an officer picks
 * from and the rule that judges the pick cannot disagree:
 *
 * - a booking at THIS lodge, not soft-deleted, whose status is an operational
 *   stay (PAID or COMPLETED — a cancelled stay is not a stay), and
 * - either a guest row for the member whose own consent does not leave them
 *   operationally absent (owner decision D-12, #2307), or the member OWNS the
 *   booking (their own guest row's nights when they have one, else the
 *   booking's nights);
 * - nights come from the night model (`getGuestBedNightKeys`, `INV-DATE-020`),
 *   so a split stay's gap nights are absences and a check-out morning is never
 *   a night.
 */

/** A stay as the night model reads it: booking envelope plus the guest's own. */
export type HutLeaderMemberStay = {
  checkIn: Date;
  checkOut: Date;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  nights?: Array<{ stayDate: Date }> | null;
};

/**
 * The bookings whose nights count as a member's stay at `lodgeId` overlapping a
 * range — THE one definition of "a booking that is a stay" for hut leaders
 * (`INV-SSOT`). The manual create/edit stay check, the eligible-members
 * suggestions and the presence-aware coverage reader all route here, so they
 * cannot disagree about which bookings count. A soft-deleted booking is not a
 * stay, whatever its status.
 */
export function hutLeaderStayBookingWhere(input: {
  lodgeId: string;
  rangeStart: Date;
  rangeEnd: Date;
}): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    lodgeId: input.lodgeId,
    status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
    checkIn: { lte: input.rangeEnd },
    checkOut: { gt: input.rangeStart },
  };
}

/** Every night key the stays cover, de-duplicated and sorted. */
export function hutLeaderStayNightKeys(
  stays: readonly HutLeaderMemberStay[],
): string[] {
  const keys = new Set<string>();
  for (const stay of stays) {
    for (const key of getGuestBedNightKeys(stay, stay)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * The run of consecutive stayed nights containing `nightKey`, or null when
 * `nightKey` is not stayed. One run is one assignment's worth of nights: a
 * split stay has one run per segment.
 */
export function stayedNightRunContaining(
  stayedNightKeys: readonly string[],
  nightKey: string,
): { first: string; last: string } | null {
  const stayed = new Set(stayedNightKeys);
  if (!stayed.has(nightKey)) return null;
  let first = requireCalendarDate(nightKey);
  for (;;) {
    const previous = addCalendarDays(first, -1);
    if (!stayed.has(previous)) break;
    first = previous;
  }
  let last = requireCalendarDate(nightKey);
  for (;;) {
    const next = addCalendarDays(last, 1);
    if (!stayed.has(next)) break;
    last = next;
  }
  return { first, last };
}

type StayDb = Pick<Prisma.TransactionClient, "bookingGuest" | "booking">;

/**
 * The member's stayed nights at `lodgeId` that fall inside
 * `[rangeStart, rangeEnd]` (both nights, inclusive), sorted. Reads on the
 * client it is given, so a caller holding the lodge capacity key reads under
 * it.
 */
export async function loadHutLeaderStayedNightKeys(
  db: StayDb,
  input: { memberId: string; lodgeId: string; rangeStart: Date; rangeEnd: Date },
): Promise<string[]> {
  const bookingWhere = hutLeaderStayBookingWhere(input);
  const [guestRows, ownedBookings] = await Promise.all([
    db.bookingGuest.findMany({
      where: {
        memberId: input.memberId,
        ...OPERATIONALLY_PRESENT_GUEST_WHERE,
        booking: bookingWhere,
      },
      select: {
        stayStart: true,
        stayEnd: true,
        nights: { select: { stayDate: true } },
        booking: { select: { checkIn: true, checkOut: true } },
      },
    }),
    db.booking.findMany({
      where: { ...bookingWhere, memberId: input.memberId },
      select: {
        checkIn: true,
        checkOut: true,
        guests: {
          where: { memberId: input.memberId },
          select: {
            stayStart: true,
            stayEnd: true,
            nights: { select: { stayDate: true } },
          },
        },
      },
    }),
  ]);

  const stays: HutLeaderMemberStay[] = [
    ...guestRows.map((guest) => ({
      checkIn: guest.booking.checkIn,
      checkOut: guest.booking.checkOut,
      stayStart: guest.stayStart,
      stayEnd: guest.stayEnd,
      nights: guest.nights,
    })),
    ...ownedBookings.map((booking) => {
      const ownGuest = booking.guests[0];
      return {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        stayStart: ownGuest?.stayStart,
        stayEnd: ownGuest?.stayEnd,
        nights: ownGuest?.nights,
      };
    }),
  ];

  const from = calendarDateOfDateOnlyInstant(input.rangeStart);
  const to = calendarDateOfDateOnlyInstant(input.rangeEnd);
  return hutLeaderStayNightKeys(stays).filter((key) => from <= key && key <= to);
}

export const HUT_LEADER_NIGHTS_NOT_STAYED = "HUT_LEADER_NIGHTS_NOT_STAYED";

export type HutLeaderStayRefusal = {
  code: typeof HUT_LEADER_NIGHTS_NOT_STAYED;
  error: string;
  /** The first assigned night the member is not staying. */
  firstNightNotStayed: string;
  /**
   * The last night of the stayed run that begins on the start date, or null
   * when the start night itself is not stayed. It is also the corrected end
   * the officer is offered ("Change last night to …").
   */
  lastNightStayed: string | null;
};

/**
 * Is this assignment exempt from the stay check? A bed-holding assignment is a
 * custodian occupancy whose held bed is the stay (`INV-LIFE-062`), and an
 * assignment ticked "Custodian (lives on site)" counts as present on every
 * night it covers (owner decision on #3820, 3 Oct 2026). Everything else —
 * a role-only, non-custodian assignment — must be stayed.
 */
export function isHutLeaderStayCheckExempt(assignment: {
  bedId: string | null | undefined;
  isCustodian: boolean | null | undefined;
}): boolean {
  return Boolean(assignment.bedId) || assignment.isCustodian === true;
}

/**
 * Refuse an assignment that claims a night the member is not staying at the
 * lodge (#3817, owner decision "Block it outright" — there is no override).
 * Returns null when every night in `[startDate, endDate]` is stayed.
 */
export async function findHutLeaderStayRefusal(
  db: StayDb,
  input: { memberId: string; lodgeId: string; startDate: Date; endDate: Date },
): Promise<HutLeaderStayRefusal | null> {
  const stayed = await loadHutLeaderStayedNightKeys(db, {
    memberId: input.memberId,
    lodgeId: input.lodgeId,
    rangeStart: input.startDate,
    rangeEnd: input.endDate,
  });
  const stayedSet = new Set(stayed);
  const startKey = calendarDateOfDateOnlyInstant(input.startDate);
  const endKey = calendarDateOfDateOnlyInstant(input.endDate);
  let firstNightNotStayed: string | null = null;
  for (let key = startKey; key <= endKey; key = addCalendarDays(key, 1)) {
    if (!stayedSet.has(key)) {
      firstNightNotStayed = key;
      break;
    }
  }
  if (firstNightNotStayed === null) return null;

  const run = stayedNightRunContaining(stayed, startKey);
  const lastNightStayed = run?.last ?? null;
  const error = lastNightStayed
    ? `The member is not staying at this lodge on the night of ${firstNightNotStayed}, so they cannot be hut leader for it. Their last night stayed from the start date is ${lastNightStayed}.`
    : `The member is not staying at this lodge on the night of ${firstNightNotStayed}, so they cannot be hut leader for it. A hut leader must be staying every night they cover.`;
  return {
    code: HUT_LEADER_NIGHTS_NOT_STAYED,
    error,
    firstNightNotStayed,
    lastNightStayed,
  };
}

/** The JSON body a route answers a stay refusal with (status 409). */
export function hutLeaderStayRefusalBody(refusal: HutLeaderStayRefusal): {
  error: string;
  code: typeof HUT_LEADER_NIGHTS_NOT_STAYED;
  firstNightNotStayed: string;
  lastNightStayed: string | null;
} {
  return {
    error: refusal.error,
    code: refusal.code,
    firstNightNotStayed: refusal.firstNightNotStayed,
    lastNightStayed: refusal.lastNightStayed,
  };
}

/** Thrown inside a transaction so it rolls back; carries the refusal to render. */
export class HutLeaderNightsNotStayedError extends Error {
  constructor(readonly refusal: HutLeaderStayRefusal) {
    super(refusal.error);
    this.name = "HutLeaderNightsNotStayedError";
  }
}

/**
 * {@link findHutLeaderStayRefusal} for a caller inside a transaction: throws
 * {@link HutLeaderNightsNotStayedError} so nothing it has written survives.
 */
export async function assertHutLeaderNightsStayed(
  db: StayDb,
  input: { memberId: string; lodgeId: string; startDate: Date; endDate: Date },
): Promise<void> {
  const refusal = await findHutLeaderStayRefusal(db, input);
  if (refusal) throw new HutLeaderNightsNotStayedError(refusal);
}
