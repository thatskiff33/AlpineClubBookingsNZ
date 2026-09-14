import "server-only";

import type { DisplayNameGranularity, Prisma } from "@prisma/client";

import { isGuestActiveOnNight } from "./booking-guest-stay-ranges";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "./booking-status";
import { addCalendarDays } from "./club-time/calendar-date";
import type { CalendarDate } from "./club-time/types";
import { dateOnlyInstantOf } from "./club-time/instant";
import { clubTime } from "./club-time/server";
import {
  bookingLabel,
  isMinorAgeTier,
  namesAllowedForBooking,
  reduceName,
  WHOLE_LODGE_MIN_GUESTS,
} from "./display-name-granularity";
import { getEligibleLodgeIdsForMember } from "./lodge-access";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "./member-guest-consent";
import { prisma } from "./prisma";

// The member lodge roster's ONE query and ONE projection (#2942).
//
// ENFORCES INV-PRIV-017. A signed-in member may learn who else is staying at a
// lodge they can already book, over a bounded forward window, as names and
// nights and nothing else.
//
// THE DISCLOSURE RULE IS ENFORCED BY WHAT THIS FILE BUILDS, NOT BY WHAT A
// COMPONENT RENDERS. This is a Next.js application: anything reachable from a
// client component's props or an RSC flight payload is readable in the browser
// whether it is rendered or not. So a field a member may not see is an ABSENT
// KEY here — not a null, not an empty string, not a flag saying it was
// withheld — and the row types below carry no key for one. That is the same
// rule, and the same reasoning, as INV-PRIV-016 on the kiosk.
//
// WHAT IS DELIBERATELY NEVER SELECTED: member or guest ids, email, phone, date
// of birth, address, membership type or status, any monetary field, booking
// ids, booking notes, arrival times, bed or room assignments, consent state,
// dietary or allergy information (#3021 - the roster must never receive it),
// group-booking identity of any kind, and whether a night is under a
// whole-lodge or custodian hold. The selects below name none of them, so there
// is nothing to strip later and nothing for a future edit to forget to strip.

/**
 * The roster's own default name detail, deliberately NOT the lobby display's
 * (`DEFAULT_DISPLAY_NAME_GRANULARITY`, which is `FIRST_NAME_SURNAME_INITIAL`).
 *
 * Owner decision D2, amended at plan review on 14 Sep 2026: a club that turns
 * the roster on gets full names unless it chooses otherwise, and the admin may
 * set any of the four levels per lodge. The two surfaces default differently on
 * purpose and a reader of either should not assume the other matches.
 */
export const DEFAULT_ROSTER_NAME_GRANULARITY: DisplayNameGranularity =
  "FULL_NAME";

/**
 * How many nights forward the roster looks, counted from the club's today.
 *
 * A bounded window is part of the privacy contract rather than a performance
 * choice: there is no history, and no parameter that lets a caller widen it.
 */
export const ROSTER_WINDOW_DAYS = 30;

/**
 * The booking columns the roster reads. `satisfies` rather than a bare object
 * so a typo is a type error, and exported so the privacy test can assert on
 * the select itself rather than only on its output — a field that is never
 * selected cannot leak through a later refactor of the builder.
 *
 * `member` is the booking owner, needed for the booking-level label; only the
 * three fields the label rules consume are read.
 */
export const MEMBER_ROSTER_BOOKING_SELECT = {
  lodgeId: true,
  checkIn: true,
  checkOut: true,
  member: {
    select: { firstName: true, lastName: true, ageTier: true },
  },
  guests: {
    where: OPERATIONALLY_PRESENT_GUEST_WHERE,
    select: {
      firstName: true,
      lastName: true,
      ageTier: true,
      stayStart: true,
      stayEnd: true,
      nights: { select: { stayDate: true } },
    },
  },
} satisfies Prisma.BookingSelect;

type RosterBookingRow = Prisma.BookingGetPayload<{
  select: typeof MEMBER_ROSTER_BOOKING_SELECT;
}>;

/** One person on one lodge's roster, with the nights they are here. */
export interface RosterPerson {
  /** Already reduced to the lodge's granularity. Never a raw stored name. */
  name: string;
  /** Lodge nights within the window, ascending `YYYY-MM-DD`. */
  nights: string[];
}

/**
 * One booking that could not be named individually — a family, a school, a
 * group with the lodge to itself — reduced to a label and a head count.
 */
export interface RosterGroup {
  label: string;
  /** How many people the booking has here, across the window. */
  count: number;
  nights: string[];
}

export interface LodgeRoster {
  lodgeId: string;
  lodgeName: string;
  granularity: DisplayNameGranularity;
  people: RosterPerson[];
  groups: RosterGroup[];
  /** Total people present per night, keyed `YYYY-MM-DD`. */
  countsByNight: Record<string, number>;
}

export interface MemberLodgeRoster {
  from: string;
  to: string;
  lodges: LodgeRoster[];
}

function nightsForGuest(
  guest: RosterBookingRow["guests"][number],
  booking: RosterBookingRow,
  windowNights: readonly CalendarDate[]
): string[] {
  // `isGuestActiveOnNight` is the canonical presence rule (INV-DATE-005) and
  // is pinned byte-for-byte by its own contract test. It is asked per night
  // rather than re-derived here, because a second expression of "is this guest
  // here on this night" is exactly the drift INV-SSOT exists to prevent.
  const out: string[] = [];
  for (const night of windowNights) {
    if (isGuestActiveOnNight(guest, dateOnlyInstantOf(night), booking)) {
      out.push(night);
    }
  }
  return out;
}

/**
 * Build the roster for one member.
 *
 * Authorization happens BEFORE anything is selected: the lodge set is resolved
 * from the member's own booking eligibility first, and the booking query is
 * filtered to it. A member who may book nothing reads nothing, and there is no
 * code path that selects a booking row for a lodge the caller cannot reach.
 *
 * A listing OMITS what the member may not see rather than refusing the whole
 * request, which is what the lodge-scoping contract requires of a cross-lodge
 * read.
 */
export async function buildMemberLodgeRoster(
  memberId: string
): Promise<MemberLodgeRoster> {
  const club = await clubTime();
  const from = club.today();
  const to = addCalendarDays(from, ROSTER_WINDOW_DAYS);

  const windowNights: CalendarDate[] = [];
  for (let i = 0; i < ROSTER_WINDOW_DAYS; i += 1) {
    windowNights.push(addCalendarDays(from, i));
  }

  const eligible = await getEligibleLodgeIdsForMember(prisma, memberId);

  const lodges = await prisma.lodge.findMany({
    where: {
      active: true,
      ...(eligible.allLodges ? {} : { id: { in: eligible.lodgeIds } }),
    },
    select: { id: true, name: true, rosterNameGranularity: true },
    orderBy: { name: "asc" },
  });

  if (lodges.length === 0) {
    return { from, to, lodges: [] };
  }

  const lodgeIds = lodges.map((lodge) => lodge.id);

  // Only bookings that actually overlap the window, and only the two statuses
  // that mean somebody is really staying. A waitlisted, cancelled, pending or
  // unpaid booking is not a stay, and a soft-deleted one is not a booking.
  //
  // Holds are absent by construction rather than by exclusion: a whole-lodge
  // hold and a custodian bed hold are not guests on a PAID booking, so nothing
  // below can reach one. Members already never see a held night - to them it
  // is an ordinary full lodge - and the roster does not change that.
  const bookings = await prisma.booking.findMany({
    where: {
      lodgeId: { in: lodgeIds },
      deletedAt: null,
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lt: dateOnlyInstantOf(to) },
      checkOut: { gt: dateOnlyInstantOf(from) },
    },
    select: MEMBER_ROSTER_BOOKING_SELECT,
  });

  const byLodge = new Map<string, RosterBookingRow[]>();
  for (const booking of bookings) {
    const list = byLodge.get(booking.lodgeId);
    if (list) list.push(booking);
    else byLodge.set(booking.lodgeId, [booking]);
  }

  return {
    from,
    to,
    lodges: lodges.map((lodge) =>
      buildOneLodgeRoster(
        lodge,
        byLodge.get(lodge.id) ?? [],
        windowNights
      )
    ),
  };
}

function buildOneLodgeRoster(
  lodge: { id: string; name: string; rosterNameGranularity: DisplayNameGranularity | null },
  bookings: readonly RosterBookingRow[],
  windowNights: readonly CalendarDate[]
): LodgeRoster {
  const granularity = lodge.rosterNameGranularity ?? DEFAULT_ROSTER_NAME_GRANULARITY;

  const people: RosterPerson[] = [];
  const groups: RosterGroup[] = [];
  const countsByNight: Record<string, number> = {};

  // PASS ONE: who is present, on which nights, and how many people the lodge
  // holds each night. Sole occupancy cannot be decided until every booking has
  // been counted, so nothing is reduced or labelled in this pass.
  const attending = bookings.map((booking) => {
    const present = booking.guests
      .map((guest) => ({
        guest,
        nights: nightsForGuest(guest, booking, windowNights),
      }))
      .filter((entry) => entry.nights.length > 0);

    const nightCounts = new Map<string, number>();
    for (const entry of present) {
      for (const night of entry.nights) {
        nightCounts.set(night, (nightCounts.get(night) ?? 0) + 1);
        countsByNight[night] = (countsByNight[night] ?? 0) + 1;
      }
    }
    return { booking, present, nightCounts };
  });

  for (const { booking, present, nightCounts } of attending) {
    if (present.length === 0) continue;

    // SOLE OCCUPANCY, the same question the lobby display asks and answered the
    // same way — deliberately, because `namesAllowedForBooking` is shared and a
    // second reading of its argument would be a second rule wearing one name.
    //
    // Two conditions, both required. The booking must be a GROUP — an
    // organisation, or at least WHOLE_LODGE_MIN_GUESTS people — because a
    // couple alone mid-week is a small party, not a take-over, and reducing
    // them to a group label would withhold names nobody asked to withhold. And
    // it must have been alone on EVERY night it holds here: naming the fourteen
    // people who had the building to themselves is exactly the disclosure
    // design.md §10 refuses.
    //
    // "How many bookings are in the window" is NOT this question, and an
    // earlier draft of this file used it. It fails in both directions: it
    // suppressed a lone couple who should be named, and — the defect that
    // matters — it NAMED two fourteen-person school groups that never
    // overlapped, because the window held two bookings, even though each had
    // the lodge entirely to itself for its whole stay.
    const isGroup =
      booking.member.ageTier === "NOT_APPLICABLE" ||
      booking.guests.length >= WHOLE_LODGE_MIN_GUESTS;
    const soleOccupancy =
      isGroup &&
      nightCounts.size > 0 &&
      [...nightCounts.entries()].every(
        ([night, count]) => countsByNight[night] === count
      );

    const containsMinors = present.some((entry) =>
      isMinorAgeTier(entry.guest.ageTier)
    );

    const namesAllowed = namesAllowedForBooking({
      soleOccupancy,
      containsMinors,
      organiserAgeTier: booking.member.ageTier,
      granularity,
    });

    if (!namesAllowed) {
      // The whole booking collapses to one label. A booking containing a child
      // names NOBODY in it, not merely not the child: naming the adults beside
      // a "Family of 4" label identifies the child by association, which is
      // the thing the rule exists to prevent (owner decision D1).
      const nights = new Set<string>();
      for (const entry of present) for (const n of entry.nights) nights.add(n);
      groups.push({
        label: bookingLabel(booking.member, {
          granularity,
          containsMinors,
          guestCount: present.length,
        }),
        count: present.length,
        nights: [...nights].sort(),
      });
      continue;
    }

    for (const entry of present) {
      const name = reduceName(
        entry.guest.firstName,
        entry.guest.lastName,
        granularity
      );
      // `reduceName` returns null only at COUNTS_ONLY, which
      // `namesAllowedForBooking` has already refused above; the guard is here
      // so a future granularity that also reduces to nothing cannot fall
      // through into an empty name.
      if (!name) continue;
      people.push({ name, nights: entry.nights });
    }
  }

  people.sort((a, b) => a.name.localeCompare(b.name));
  groups.sort((a, b) => a.label.localeCompare(b.label));

  return {
    lodgeId: lodge.id,
    lodgeName: lodge.name,
    granularity,
    people,
    groups,
    countsByNight,
  };
}
