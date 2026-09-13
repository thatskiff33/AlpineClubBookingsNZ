/**
 * Who is in the lodge on one NZ operational day, for chore purposes (#2622).
 *
 * THIS IS THE ONLY CHORE-ELIGIBILITY QUERY. It used to exist twice — once in
 * `admin-roster-service.ts` and once, copied, in the kiosk generate route — and
 * the two could disagree about who was present. They are now one function, so
 * the admin roster, the hut-leader wizard and chore cleanup cannot diverge.
 *
 * Eligibility is the operational day, not the night (see
 * `booking-guest-stay-ranges.ts`): a guest is here from midday NZ on the day
 * they arrive until midday NZ on the day they leave, so someone whose last
 * night was yesterday is still here this morning and is exactly the person to
 * strip a bed before they drive home. The SQL predicates below are only a
 * coarse superset of that rule — deliberately inclusive of the checkout day —
 * and `getOperationallyPresentGuestsForDay` makes the authoritative decision in
 * memory, where the explicit per-night rows are visible and a sparse stay's
 * internal gap days are correctly excluded.
 */
import type { Prisma } from "@prisma/client";

import {
  getGuestOperationalDayPresence,
  getOperationallyPresentGuestsForDay,
} from "@/lib/booking-guest-stay-ranges";
import { bookingOwner } from "@/lib/booking-owner";
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import type { GuestInput } from "@/lib/chore-allocator";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { prisma } from "@/lib/prisma";

/** An allocator guest input plus the booking/family label the editors group by. */
export type OperationalRosterGuest = GuestInput & { bookingGroupLabel: string };

export async function getOperationalRosterGuestsForDate(
  date: Date,
  lodgeId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<OperationalRosterGuest[]> {
  const bookings = await db.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      deletedAt: null,
      // The operational day is checkout-INCLUSIVE, so both coarse envelope
      // bounds are `gte`. They are a superset only: a booking that merely
      // touches this date still has every guest re-tested against the
      // authoritative per-night rule below.
      checkIn: { lte: date },
      checkOut: { gte: date },
      ...lodgeNullTolerantScope(lodgeId),
      guests: {
        some: {
          stayStart: { lte: date },
          stayEnd: { gte: date },
          ...OPERATIONALLY_PRESENT_GUEST_WHERE,
        },
      },
      // Don't roster a booking blocked by a pending admin review (#1372 /
      // #1422); it can't check in until an admin clears the review, so it
      // shouldn't get chore assignments.
      ...checkinNotBlockedByPendingReviewFilter(),
    },
    include: {
      member: { select: { firstName: true, lastName: true } },
      guests: {
        where: {
          stayStart: { lte: date },
          stayEnd: { gte: date },
          // Owner decision D-12 (#2307): this one query is the choke point for
          // every chore surface — admin allocation, the hut-leader wizard, the
          // roster email fan-out, and GuestChoreToken minting all read the list
          // it returns. A guest whose member consent is still PENDING holds a
          // bed (D-4) but is not operationally present, so they are never given
          // a chore, never emailed a roster, and never issued a chore token.
          ...OPERATIONALLY_PRESENT_GUEST_WHERE,
        },
        include: {
          member: {
            select: { ageTier: true, dateOfBirth: true },
          },
          // Required, not optional: without the explicit night rows a sparse
          // stay's internal gap days would look like presence.
          nights: { select: { stayDate: true } },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  return bookings.flatMap((booking, bookingIndex) => {
    const ownerName = [bookingOwner(booking).member?.firstName, bookingOwner(booking).member?.lastName]
      .filter(Boolean)
      .join(" ");
    const bookingGroupLabel = ownerName
      ? `Booking for ${ownerName}`
      : `Booking group ${bookingIndex + 1}`;
    const presentGuests = getOperationallyPresentGuestsForDay(
      booking.guests,
      date,
      booking,
    ).sort((a, b) => {
      const aDob = a.member?.dateOfBirth?.getTime();
      const bDob = b.member?.dateOfBirth?.getTime();
      const byName = () => `${a.firstName}\u0000${a.lastName}\u0000${a.id}`.localeCompare(
        `${b.firstName}\u0000${b.lastName}\u0000${b.id}`,
      );
      if (aDob !== undefined && bDob !== undefined) {
        return aDob === bDob ? byName() : aDob - bDob;
      }
      if (aDob !== undefined) return -1;
      if (bDob !== undefined) return 1;
      return byName();
    });

    return presentGuests.map((guest) => {
      // The two labels the allocator routes on are nothing but which half of
      // the day this guest occupies. "Departing" means LEAVES TODAY — they are
      // here this morning — not "leaves tomorrow", which is what the roster
      // used to compute and why checkout-day guests were invisible to it.
      const presence = getGuestOperationalDayPresence(guest, date, booking);
      return {
        id: guest.id,
        bookingId: booking.id,
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: getBookingGuestDisplayAgeTier(guest),
        isArriving: presence.isArriving,
        isDeparting: presence.isDeparting,
        bookingGroupLabel,
      };
    });
  });
}
