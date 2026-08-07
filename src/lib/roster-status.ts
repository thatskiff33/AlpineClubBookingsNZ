import { parseOccupancyMonth } from "@/lib/admin-occupancy";
import {
  getOperationallyPresentGuestsForDay,
  type BookingStayRange,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";

/**
 * Per-date colour status for the roster calendar overlay. Precedence, first
 * match wins: no-guests → needs-roster → suggested → needs-attention →
 * confirmed. See `computeRosterDayStatuses` for the exact algorithm.
 */
export type RosterDayStatus =
  | "no-guests"
  | "needs-roster"
  | "suggested"
  | "needs-attention"
  | "confirmed";

/**
 * A guest as far as roster-status cares: the stay-range fields the presence
 * primitive needs, plus an optional age tier for the adult/youth attention knob.
 *
 * `nights` (inherited from `GuestStayRange`) is not optional in practice: every
 * caller loads the explicit night rows, because without them a sparse stay's
 * internal gap day falls back to the envelope and paints a colour on a day
 * nobody is in the lodge.
 */
export type RosterStatusGuest = GuestStayRange & { ageTier?: string | null };

/**
 * A staying booking. Structurally compatible with the stay-range helpers (it
 * extends `BookingStayRange`), so a Prisma booking row selecting
 * checkIn/checkOut plus its guests can be passed straight through.
 */
export type RosterStatusBooking = BookingStayRange & {
  id: string;
  guests: RosterStatusGuest[];
};

/**
 * A chore assignment row projected to what roster-status needs. `bookingId` is
 * NON-NULL on the schema and is the sole coverage key: a row with a NULL
 * `bookingGuestId` still covers its booking, so we never track the guest here.
 */
export type RosterStatusAssignment = {
  date: Date;
  status: "SUGGESTED" | "CONFIRMED" | "COMPLETED";
  bookingId: string;
};

export type RosterDayStatusResult = {
  date: string;
  status: RosterDayStatus;
  stayingBookingCount: number;
  uncoveredBookingCount: number;
};

const ATTENTION_AGE_TIERS = new Set(["ADULT", "YOUTH"]);

/**
 * One booking that has somebody in the lodge on the day, and exactly who.
 * Generic in both types so a caller keeps its own concrete guest rows (the
 * kiosk week endpoint reads `nights` and `ageTier` back off them).
 */
export type RosterStatusStayingBooking<
  Guest extends RosterStatusGuest,
  Booking extends BookingStayRange & { id: string; guests: Guest[] },
> = {
  booking: Booking;
  presentGuests: Guest[];
};

/**
 * THE ONE CANDIDATE SET every roster read surface counts (#2631).
 *
 * Presence is the OPERATIONAL DAY, not the night: a guest is in the lodge on
 * NZ day D if D−1 or D is one of their booked nights (see
 * `booking-guest-stay-ranges.ts`). The roster calendar used to ask
 * `getActiveGuestsForNight` instead, so a checkout morning — four people
 * eating breakfast and stripping beds — painted as `no-guests`, and the kiosk
 * week strip could report four guests and "no guests to roster" in the same
 * response because its count and its colour came from different rules.
 *
 * Callers derive their guest counts, their departing counts AND their day
 * status from this single list, so those numbers cannot contradict each other.
 */
export function getRosterStatusStayingBookings<
  Guest extends RosterStatusGuest,
  Booking extends BookingStayRange & { id: string; guests: Guest[] },
>(bookings: Booking[], day: Date): Array<RosterStatusStayingBooking<Guest, Booking>> {
  const staying: Array<RosterStatusStayingBooking<Guest, Booking>> = [];
  for (const booking of bookings) {
    const presentGuests = getOperationallyPresentGuestsForDay(
      booking.guests,
      day,
      booking,
    );
    if (presentGuests.length > 0) {
      staying.push({ booking, presentGuests });
    }
  }
  return staying;
}

/**
 * The colour for one date, given the day's candidate set. Coverage is diffed at
 * BOOKING granularity (owner decision): a booking is "covered" for a date iff
 * at least one confirmed/completed chore assignment row carries its booking id
 * for that date.
 *
 *   1. no staying booking → `no-guests`.
 *   2. dateAssignments = assignments whose `formatDateOnly(date)` matches.
 *      none → `needs-roster`.
 *   3. any SUGGESTED assignment → `suggested`.
 *   4. otherwise (all CONFIRMED/COMPLETED): uncovered = staying bookings whose
 *      id is not in the covered set. With `requireAdultOrYouthForAttention`,
 *      only bookings with ≥1 present ADULT/YOUTH guest count as relevant.
 *      any uncovered → `needs-attention`; else → `confirmed`.
 */
export function computeRosterDayStatusForStayingBookings<
  Guest extends RosterStatusGuest,
  Booking extends BookingStayRange & { id: string; guests: Guest[] },
>(
  dateString: string,
  stayingBookings: Array<RosterStatusStayingBooking<Guest, Booking>>,
  assignments: RosterStatusAssignment[],
  options?: { requireAdultOrYouthForAttention?: boolean },
): RosterDayStatusResult {
  const requireAdultOrYouth = options?.requireAdultOrYouthForAttention ?? false;

  if (stayingBookings.length === 0) {
    return {
      date: dateString,
      status: "no-guests",
      stayingBookingCount: 0,
      uncoveredBookingCount: 0,
    };
  }

  const dateAssignments = assignments.filter(
    (assignment) => formatDateOnly(assignment.date) === dateString,
  );

  if (dateAssignments.length === 0) {
    return {
      date: dateString,
      status: "needs-roster",
      stayingBookingCount: stayingBookings.length,
      uncoveredBookingCount: 0,
    };
  }

  if (dateAssignments.some((assignment) => assignment.status === "SUGGESTED")) {
    return {
      date: dateString,
      status: "suggested",
      stayingBookingCount: stayingBookings.length,
      uncoveredBookingCount: 0,
    };
  }

  const coveredBookingIds = new Set(
    dateAssignments.map((assignment) => assignment.bookingId),
  );

  const relevantBookings = requireAdultOrYouth
    ? stayingBookings.filter(({ presentGuests }) =>
        presentGuests.some(
          (guest) => guest.ageTier != null && ATTENTION_AGE_TIERS.has(guest.ageTier),
        ),
      )
    : stayingBookings;

  const uncovered = relevantBookings.filter(
    ({ booking }) => !coveredBookingIds.has(booking.id),
  );

  if (uncovered.length > 0) {
    return {
      date: dateString,
      status: "needs-attention",
      stayingBookingCount: stayingBookings.length,
      uncoveredBookingCount: uncovered.length,
    };
  }

  return {
    date: dateString,
    status: "confirmed",
    stayingBookingCount: stayingBookings.length,
    uncoveredBookingCount: 0,
  };
}

/**
 * Pure roster-day status computation over a list of dates. No prisma import —
 * shared with the kiosk week endpoint. Each date is the candidate set from
 * `getRosterStatusStayingBookings` fed to
 * `computeRosterDayStatusForStayingBookings`; see both for the rules.
 *
 * NOTE FOR CALLERS THAT LOAD THE BOOKINGS (#2631): presence on the FIRST date
 * of the window can depend on the night before it, which belongs to a booking
 * whose `checkOut` equals that date. A window predicate of `checkOut: { gt:
 * windowStart }` drops exactly those bookings, so the departure would vanish
 * from the calendar's first day. Both DB entry points below use `gte`.
 */
export function computeRosterDayStatuses(
  dates: string[],
  bookings: RosterStatusBooking[],
  assignments: RosterStatusAssignment[],
  options?: { requireAdultOrYouthForAttention?: boolean },
): RosterDayStatusResult[] {
  return dates.map((dateString) =>
    computeRosterDayStatusForStayingBookings(
      dateString,
      getRosterStatusStayingBookings(bookings, parseDateOnly(dateString)),
      assignments,
      options,
    ),
  );
}

/**
 * DB-touching entry point. Loads operational bookings and chore assignments for
 * a calendar month, then delegates to the pure `computeRosterDayStatuses`. It
 * additionally selects each guest's `ageTier` so the adult/youth attention knob
 * is available to callers that want it.
 *
 * TWO THINGS THIS QUERY IS NOT (#2631). It is no longer the same window as
 * `getAdminOccupancyMonth`: the overlap bounds are checkout-INCLUSIVE (`gte`),
 * because the roster covers the morning after the last night and a booking
 * whose only relevant night is the 30th of last month still puts people in the
 * lodge on the 1st. And it is no longer a different population from the roster
 * it colours: it now applies BOTH of the roster's own exclusions, exactly as
 * `roster-eligibility.ts` applies them —
 * `OPERATIONALLY_PRESENT_GUEST_WHERE` (owner decision D-12, #2307) for member
 * guests whose consent is still pending, and
 * `checkinNotBlockedByPendingReviewFilter()` (#1372 / #1422) for a booking held
 * by a pending admin review, which cannot be rostered because it cannot check
 * in. Each was independently capable of the same symptom: a day painted "needs
 * roster" that opened with nobody to roster.
 *
 * THE ONE EXCLUSION THAT IS DELIBERATELY NOT SHARED, so nobody "fixes" it: the
 * kiosk's guest LIST keeps #1422's flag-don't-hide rule and still shows a
 * review-blocked booking, marked `blockedFromCheckin`, because staff standing
 * at the door need to see who has been turned away. That list answers "who is
 * in the building"; this query answers "who can be given a chore", and on a day
 * whose only booking is review-blocked the two correctly disagree.
 *
 * `lodgeId` scopes the aggregate to a single lodge so the roster calendar
 * overlay matches the lodge-filtered roster list (#1587 item 3). Bookings scope
 * directly via `lodgeNullTolerantScope`; chore assignments scope through their
 * (required) booking relation. Omitting `lodgeId` keeps the club-wide query
 * byte-identical to before multi-lodge — the single-active-lodge default.
 */
export async function getRosterMonthStatus(input: {
  month: string;
  lodgeId?: string;
}): Promise<RosterDayStatusResult[]> {
  const parsedMonth = parseOccupancyMonth(input.month);
  if (!parsedMonth.ok) {
    throw new Error(parsedMonth.error);
  }
  const { startDate, endDate } = parsedMonth;

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      deletedAt: null,
      checkIn: { lt: endDate },
      // Checkout-INCLUSIVE (#2631): a booking that checks out on the first day
      // of the window had someone here that morning.
      checkOut: { gte: startDate },
      ...(input.lodgeId ? lodgeNullTolerantScope(input.lodgeId) : {}),
      guests: {
        some: {
          stayStart: { lt: endDate },
          stayEnd: { gte: startDate },
          ...OPERATIONALLY_PRESENT_GUEST_WHERE,
        },
      },
      // #1372 / #1422: a booking held by a pending admin review cannot check
      // in, so `roster-eligibility.ts` never offers it a chore. Colouring its
      // day "needs roster" would send an admin to a page with nobody on it.
      ...checkinNotBlockedByPendingReviewFilter(),
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      guests: {
        // D-12 (#2307), the other half of the pair: an unconsented member guest
        // is not on the roster, so they are not in the colour that says a
        // roster is needed either.
        where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
        select: {
          stayStart: true,
          stayEnd: true,
          ageTier: true,
          // Required, not optional: without the explicit night rows a sparse
          // stay's internal gap day would paint as presence.
          nights: {
            select: {
              stayDate: true,
            },
          },
        },
      },
    },
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
  });

  const assignments = await prisma.choreAssignment.findMany({
    where: {
      date: { gte: startDate, lt: endDate },
      ...(input.lodgeId
        ? {
            booking: lodgeNullTolerantScope(input.lodgeId),
            choreTemplate: lodgeNullTolerantScope(input.lodgeId),
          }
        : {}),
    },
    select: {
      date: true,
      status: true,
      bookingId: true,
    },
  });

  const dates = eachDateOnlyInRange(startDate, endDate).map(formatDateOnly);

  return computeRosterDayStatuses(dates, bookings, assignments);
}

/**
 * Count the DAYS in a bounded window that still need a chore roster — the
 * "work to do" headline for the admin dashboard's Roster Assignment officer
 * card (#2091). This mirrors the DB-touching `getRosterMonthStatus` above but
 * scoped to a caller-supplied window instead of a whole calendar month (the
 * dashboard passes today..+7, so the query stays cheap), then delegates to the
 * SAME pure `computeRosterDayStatuses` source of truth and counts its
 * `needs-roster` days: days with ≥1 guest in the lodge (so guestless bookings
 * don't inflate the count) and no chore assignment at all.
 *
 * DAYS, not nights (#2631). The unit was renamed with the rule: a changeover
 * morning whose occupants all leave before midday is a real day of chores —
 * beds stripped, kitchen shut down — and it now counts here exactly as the
 * roster calendar paints it. A stay rostered on some of its days still
 * contributes its un-rostered days instead of dropping out the moment one is
 * covered. A day with guests but an existing assignment counts as covered (or
 * needs-attention on the calendar), never as needs-roster, so this headline can
 * never read 0 while the roster surface shows needs-roster days in the same
 * window.
 *
 * The exclusions are the month query's, for the same reason: consent-pending
 * member guests and review-blocked bookings are not people the roster will
 * offer, so counting them here would send the officer to an empty page.
 */
export async function countRosterDaysNeedingChores(input: {
  from: Date;
  to: Date;
  lodgeId?: string;
}): Promise<number> {
  const { from, to } = input;

  const [bookings, assignments] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        deletedAt: null,
        checkIn: { lt: to },
        // Checkout-INCLUSIVE (#2631), same reason as the month query: a stay
        // that checks out on `from` still needs that morning's chores done.
        checkOut: { gte: from },
        ...(input.lodgeId ? lodgeNullTolerantScope(input.lodgeId) : {}),
        guests: {
          some: {
            stayStart: { lt: to },
            stayEnd: { gte: from },
            ...OPERATIONALLY_PRESENT_GUEST_WHERE,
          },
        },
        // #1372 / #1422, same reason as the month query: the headline is "work
        // to do", and a review-blocked booking is work the roster will not let
        // anyone do.
        ...checkinNotBlockedByPendingReviewFilter(),
      },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        guests: {
          // D-12 (#2307): the headline counts the people the roster will
          // actually offer, so an unconsented member guest is not one of them.
          where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
          select: {
            stayStart: true,
            stayEnd: true,
            ageTier: true,
            // Required, not optional: sparse stays would otherwise show
            // phantom presence on their internal gap days.
            nights: { select: { stayDate: true } },
          },
        },
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
    }),
    prisma.choreAssignment.findMany({
      where: {
        date: { gte: from, lt: to },
        ...(input.lodgeId
          ? {
              booking: lodgeNullTolerantScope(input.lodgeId),
              choreTemplate: lodgeNullTolerantScope(input.lodgeId),
            }
          : {}),
      },
      select: {
        date: true,
        status: true,
        bookingId: true,
      },
    }),
  ]);

  const dates = eachDateOnlyInRange(from, to).map(formatDateOnly);

  return computeRosterDayStatuses(dates, bookings, assignments).filter(
    (day) => day.status === "needs-roster",
  ).length;
}
