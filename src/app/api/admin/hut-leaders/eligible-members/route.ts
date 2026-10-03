import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { addDaysDateOnly, formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { getGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";
import { loadHutLeaderNightCover } from "@/lib/hut-leader-night-cover";
import {
  hutLeaderStayBookingWhere,
  hutLeaderStayNightKeys,
  type HutLeaderMemberStay as MemberStay,
} from "@/lib/hut-leader-stayed-nights";

/**
 * GET /api/admin/hut-leaders/eligible-members?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&lodgeId=...
 * Returns adult members who are guests on paid/operational bookings overlapping the date range,
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
      // row does not make them a hut-leader candidate. An owner's own guest row
      // carries no consent (a booker is never a consent subject on their own
      // booking), so it passes.
      ...OPERATIONALLY_PRESENT_GUEST_WHERE,
      // The same bookings the manual create/edit stay check reads (#3817), so
      // a member offered here is a member the create accepts.
      booking: hutLeaderStayBookingWhere({ lodgeId, rangeStart, rangeEnd }),
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

  // Booking OWNERS are not collected separately: a member counts as staying
  // only on nights they are a guest, and owning a booking they are not on does
  // not count (owner decision on #3820, 3 Oct 2026). An owner who is on their
  // own booking is found above, through their guest row.

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

  // Which nights in the widened window already have a leader, read through the
  // ONE coverage helper the amber "Upcoming nights with no … staying" panel
  // uses (#3818, `INV-DATE-030`): a night is covered when an assignment claims it AND its
  // leader is staying that night. Suggestions therefore never point at a night
  // that already has a leader on site. A night whose assignment's leader is not
  // there (a row stamped through its leader's checkout day) reads as uncovered,
  // so a suggestion may start on it. For that common shape the overlap is the
  // one handover day the POST route allows; a longer stale row is still refused
  // by the POST route's overlap check, which stays the authority.
  const coverage = await loadHutLeaderNightCover(prisma, {
    scope: { kind: "lodge", lodgeId },
    from: coverageWindowStart,
    to: coverageWindowEnd,
  });
  const isNightCovered = (d: Date) => coverage.isCovered(lodgeId, d);

  const members = Array.from(memberBookings.values())
    .map((m) => {
      // Find earliest checkIn and latest checkOut (the member's overall booking
      // span, shown as the booking dates — never offered as an assignment end).
      const earliestCheckIn = m.bookings.reduce((min, b) => b.checkIn < min ? b.checkIn : min, m.bookings[0].checkIn);
      const latestCheckOut = m.bookings.reduce((max, b) => b.checkOut > max ? b.checkOut : max, m.bookings[0].checkOut);

      // Build the set of the member's actual stay nights: the union of the
      // half-open [checkIn, checkOut) day range of each booking. checkOut is the
      // departure morning, NOT an occupied night — this matches every occupancy
      // computation in the repo (getBookingStatsByLodge / getUnassignedHutLeaderDates,
      // which feed the amber "Upcoming nights with no … staying" panel on this
      // same page).
      // Only real stay nights count — gap nights between two disjoint bookings do not.
      const stayNights = hutLeaderStayNightKeys(m.bookings).map(parseDateOnly);

      // The first uncovered night, read once, with the rest of the run behind
      // it. Its absence IS "fully covered" — the same one condition the count
      // expressed, now in a form the compiler can follow (#2801).
      const uncoveredNights = stayNights.filter((d) => !isNightCovered(d));
      const [firstUncoveredNight, ...laterUncoveredNights] = uncoveredNights;
      const uncoveredNightCount = uncoveredNights.length;
      const fullyCovered = firstUncoveredNight === undefined;

      // Suggested range = the first contiguous run of uncovered nights. If the
      // member is fully covered, fall back to their first and LAST NIGHT STAYED
      // (fields stay present; the UI disables Confirm for fully-covered
      // members). Never the check-out day, which is a morning, not a night the
      // create would accept (#3817).
      let suggestedStart = stayNights[0] ?? earliestCheckIn;
      let suggestedEnd = stayNights[stayNights.length - 1] ?? suggestedStart;
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
