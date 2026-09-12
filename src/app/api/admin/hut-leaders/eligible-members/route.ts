import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { addDaysDateOnly, formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { getGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";

type MemberStay = {
  checkIn: Date;
  checkOut: Date;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  nights?: Array<{ stayDate: Date }> | null;
};

/**
 * GET /api/admin/hut-leaders/eligible-members?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&lodgeId=...
 * Returns adult members who have paid/operational bookings overlapping the given date range,
 * at the required lodge, along with their booking dates and suggested assignment dates.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const requestedLodgeId = searchParams.get("lodgeId");
  const lodgeId = requestedLodgeId
    ? await resolveOptionalActiveLodgeId(prisma, requestedLodgeId)
    : null;
  if (!lodgeId) {
    return NextResponse.json({ error: "A valid lodgeId is required." }, { status: 400 });
  }

  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json({ error: "startDate and endDate are required (YYYY-MM-DD)" }, { status: 400 });
  }

  if (startDate > endDate) {
    return NextResponse.json({ error: "startDate must be before or equal to endDate" }, { status: 400 });
  }
  if (!isDateOnlyString(startDate) || !isDateOnlyString(endDate)) {
    return NextResponse.json({ error: "Invalid startDate or endDate" }, { status: 400 });
  }

  const rangeStart = parseDateOnly(startDate);
  const rangeEnd = parseDateOnly(endDate);

  // Find adult booking guests whose booking overlaps the date range
  const guests = await prisma.bookingGuest.findMany({
    where: {
      ageTier: "ADULT",
      memberId: { not: null },
      stayStart: { lte: rangeEnd },
      stayEnd: { gt: rangeStart },
      // Owner decision D-12 (#2307): the picker offers the officer members who
      // will actually be at the lodge. A member whose consent to being added as
      // a guest is still PENDING is not operationally present, so their guest
      // row does not make them a hut-leader candidate. Booking OWNERS are
      // collected separately below and are not guest rows, so they are
      // unaffected — a booker is never a consent subject on their own booking.
      ...OPERATIONALLY_PRESENT_GUEST_WHERE,
      booking: {
        lodgeId,
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        checkIn: { lte: rangeEnd },
        checkOut: { gt: rangeStart },
      },
      member: {
        active: true,
        accessRoles: { some: { role: "USER" } },
      },
    },
    select: {
      memberId: true,
      stayStart: true,
      stayEnd: true,
      nights: { select: { stayDate: true } },
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          active: true,
          hutLeaderEligible: true,
          hutLeaderEligibleAt: true,
        },
      },
      booking: {
        select: { checkIn: true, checkOut: true },
      },
    },
  });

  // Group by memberId, collecting booking dates
  const memberBookings = new Map<string, {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    hutLeaderEligible: boolean;
    hutLeaderEligibleAt: Date | null;
    /**
     * Non-empty by construction, and typed so: every entry in this map is
     * created with the stay that discovered the member and only ever grows by
     * `push`. Saying that in the type is what lets the span reduce below read
     * `bookings[0]` as its seed without an assertion or a refusal for a state
     * that cannot occur (#2801).
     */
    bookings: [MemberStay, ...MemberStay[]];
  }>();

  for (const g of guests) {
    if (!g.memberId || !g.member || !g.member.active) continue;
    const guestStay: MemberStay = {
      checkIn: g.booking.checkIn,
      checkOut: g.booking.checkOut,
      stayStart: g.stayStart,
      stayEnd: g.stayEnd,
      nights: g.nights,
    };
    const guestNightKey = getGuestBedNightKeys(guestStay, guestStay).join(",");
    const existing = memberBookings.get(g.memberId);
    if (existing) {
      // Avoid duplicate booking entries
      if (
        !existing.bookings.some(
          (booking) =>
            getGuestBedNightKeys(booking, booking).join(",") === guestNightKey,
        )
      ) {
        existing.bookings.push(guestStay);
      }
    } else {
      memberBookings.set(g.memberId, {
        id: g.member.id,
        firstName: g.member.firstName,
        lastName: g.member.lastName,
        email: g.member.email,
        hutLeaderEligible: Boolean(g.member.hutLeaderEligible),
        hutLeaderEligibleAt: g.member.hutLeaderEligibleAt ?? null,
        bookings: [guestStay],
      });
    }
  }

  // Also include booking owners who are adults
  const bookings = await prisma.booking.findMany({
    where: {
      lodgeId,
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lte: rangeEnd },
      checkOut: { gt: rangeStart },
      member: {
        active: true,
        ageTier: "ADULT",
        accessRoles: { some: { role: "USER" } },
      },
    },
    select: {
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          memberId: true,
          stayStart: true,
          stayEnd: true,
          nights: { select: { stayDate: true } },
        },
      },
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          active: true,
          ageTier: true,
          hutLeaderEligible: true,
          hutLeaderEligibleAt: true,
        },
      },
    },
  });

  for (const b of bookings) {
    if (!b.member.active || b.member.ageTier !== "ADULT") continue;
    const ownerGuest = b.guests.find((guest) => guest.memberId === b.member.id);
    const ownerStay: MemberStay = {
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      stayStart: ownerGuest?.stayStart,
      stayEnd: ownerGuest?.stayEnd,
      nights: ownerGuest?.nights,
    };
    const ownerNightKey = getGuestBedNightKeys(ownerStay, ownerStay).join(",");
    const existing = memberBookings.get(b.member.id);
    if (existing) {
      if (
        !existing.bookings.some(
          (booking) =>
            getGuestBedNightKeys(booking, booking).join(",") === ownerNightKey,
        )
      ) {
        existing.bookings.push(ownerStay);
      }
    } else {
      memberBookings.set(b.member.id, {
        id: b.member.id,
        firstName: b.member.firstName,
        lastName: b.member.lastName,
        email: b.member.email,
        hutLeaderEligible: Boolean(b.member.hutLeaderEligible),
        hutLeaderEligibleAt: b.member.hutLeaderEligibleAt ?? null,
        bookings: [ownerStay],
      });
    }
  }

  // Widen the coverage query window to span every member's actual stay, so an
  // assignment that starts before rangeStart (or ends after rangeEnd) is still
  // considered when deciding which stay nights already have a leader.
  let earliestStayStart = rangeStart;
  let latestStayEnd = rangeEnd;
  let hasAnyBooking = false;
  for (const m of memberBookings.values()) {
    for (const b of m.bookings) {
      if (!hasAnyBooking) {
        earliestStayStart = b.checkIn;
        latestStayEnd = b.checkOut;
        hasAnyBooking = true;
        continue;
      }
      if (b.checkIn.getTime() < earliestStayStart.getTime()) earliestStayStart = b.checkIn;
      if (b.checkOut.getTime() > latestStayEnd.getTime()) latestStayEnd = b.checkOut;
    }
  }

  const coverageWindowStart =
    earliestStayStart.getTime() < rangeStart.getTime() ? earliestStayStart : rangeStart;
  const coverageWindowEnd =
    latestStayEnd.getTime() > rangeEnd.getTime() ? latestStayEnd : rangeEnd;

  // Existing hut-leader assignments overlapping the widened window. We reuse the
  // inclusive covered model from getUnassignedHutLeaderDates (the amber "Upcoming
  // Dates Without…" panel) so suggestions never point at a night that already has
  // a leader. Suggested ranges therefore abut existing assignments (never overlap
  // by more than the 1-day handover boundary the POST route already allows), so
  // they are always safely POST-able.
  const coverageAssignments = await prisma.hutLeaderAssignment.findMany({
    where: { lodgeId, startDate: { lte: coverageWindowEnd }, endDate: { gte: coverageWindowStart } },
    select: { startDate: true, endDate: true },
  });

  // Inclusive covered-night predicate — matches isDateCovered in
  // src/lib/hut-leader-coverage.ts.
  const isNightCovered = (d: Date) =>
    coverageAssignments.some(
      (a) => a.startDate.getTime() <= d.getTime() && a.endDate.getTime() >= d.getTime(),
    );

  const members = Array.from(memberBookings.values())
    .map((m) => {
      // Find earliest checkIn and latest checkOut (the member's overall stay span).
      const earliestCheckIn = m.bookings.reduce((min, b) => b.checkIn < min ? b.checkIn : min, m.bookings[0].checkIn);
      const latestCheckOut = m.bookings.reduce((max, b) => b.checkOut > max ? b.checkOut : max, m.bookings[0].checkOut);

      // Build the set of the member's actual stay nights: the union of the
      // half-open [checkIn, checkOut) day range of each booking. checkOut is the
      // departure morning, NOT an occupied night — this matches every occupancy
      // computation in the repo (getBookingStatsByLodge / getUnassignedHutLeaderDates,
      // which feed the amber "Upcoming Dates Without…" panel on this same page).
      // Only real stay nights count — gap nights between two disjoint bookings do not.
      const stayNightsByTime = new Map<number, Date>();
      for (const b of m.bookings) {
        for (const key of getGuestBedNightKeys(b, b)) {
          const d = parseDateOnly(key);
          stayNightsByTime.set(d.getTime(), d);
        }
      }
      const stayNights = Array.from(stayNightsByTime.values()).sort(
        (a, b) => a.getTime() - b.getTime(),
      );

      // The first uncovered night, read once, with the rest of the run behind
      // it. Its absence IS "fully covered" — the same one condition the count
      // expressed, now in a form the compiler can follow (#2801).
      const uncoveredNights = stayNights.filter((d) => !isNightCovered(d));
      const [firstUncoveredNight, ...laterUncoveredNights] = uncoveredNights;
      const uncoveredNightCount = uncoveredNights.length;
      const fullyCovered = firstUncoveredNight === undefined;

      // Suggested range = the first contiguous run of uncovered nights. If the
      // member is fully covered, fall back to their overall stay span (fields
      // stay present; the UI disables Confirm for fully-covered members).
      let suggestedStart = earliestCheckIn;
      let suggestedEnd = latestCheckOut;
      if (firstUncoveredNight !== undefined) {
        suggestedStart = firstUncoveredNight;
        suggestedEnd = firstUncoveredNight;
        for (const night of laterUncoveredNights) {
          if (night.getTime() !== addDaysDateOnly(suggestedEnd, 1).getTime()) {
            break;
          }
          suggestedEnd = night;
        }
      }

      return {
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
        hutLeaderEligible: m.hutLeaderEligible,
        hutLeaderEligibleAt: m.hutLeaderEligibleAt
          ? m.hutLeaderEligibleAt.toISOString()
          : null,
        bookingCheckIn: formatDateOnly(earliestCheckIn),
        bookingCheckOut: formatDateOnly(latestCheckOut),
        suggestedStartDate: formatDateOnly(suggestedStart),
        suggestedEndDate: formatDateOnly(suggestedEnd),
        uncoveredNightCount,
        fullyCovered,
      };
    })
    .sort(
      (a, b) =>
        Number(a.fullyCovered) - Number(b.fullyCovered) ||
        Number(b.hutLeaderEligible) - Number(a.hutLeaderEligible) ||
        `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`),
    );

  return NextResponse.json({ members });
}
