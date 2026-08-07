import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests";
import { parseDateOnly } from "@/lib/date-only";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { formatXeroPhone } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { isCheckinBlockedByPendingReview } from "@/lib/booking-review";
import {
  getGuestOperationalDayPresence,
  getOperationallyPresentGuestsForDay,
} from "@/lib/booking-guest-stay-ranges";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/lodge/guests/[date]
 * Returns the lodge list for a date: all confirmed guests grouped by booking,
 * with arriving/departing indicators and expected arrival times.
 *
 * ONE SCOPE, THE OPERATIONAL DAY (#2631). This route used to answer two
 * different questions depending on a `?scope=` parameter: the night model by
 * default, and a checkout-inclusive "lodge list" for the kiosk. The two
 * disagreed about what "Departing" meant — the default scope flagged a guest
 * who leaves TOMORROW, the lodge-list scope one who leaves TODAY — and the two
 * screens reading them showed opposite badges for the same guest. There is now
 * one answer, the named operational-day rule in `booking-guest-stay-ranges.ts`:
 * a guest is here on day D if D−1 or D is one of their booked nights, and
 * `isDeparting` means "leaves today" here exactly as it does on the kiosk, in
 * the roster wizard and in chore generation.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, {
    request: req,
    allowPreview: true,
  });
  const { error, status, tier } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const canViewGuestContactDetails = tier !== "staying-guest";
  let lodgeId: string;
  try {
    lodgeId = await resolveKioskLodgeId(authResult, prisma);
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    throw err;
  }

  // #125 / #37: the kiosk is the authenticated staff check-in surface, so the
  // member phone-display OPT-IN gate does NOT apply here — leaders keep the
  // contact use case (owner decision on #37 AC5; the opt-in gate governs the
  // PUBLIC lobby wall in lodge-display-state.ts instead). Adults-only and the
  // staying-guest redaction below still hold.

  // The operational day is checkout-INCLUSIVE, so both coarse envelope bounds
  // are `gte`. They are a superset only — a booking that merely touches this
  // date — and `getOperationallyPresentGuestsForDay` below makes the
  // authoritative call in memory, where the explicit night rows are visible.
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lte: date },
      checkOut: { gte: date },
      ...lodgeNullTolerantScope(lodgeId),
      guests: {
        some: {
          stayStart: { lte: date },
          stayEnd: { gte: date },
          // Owner decision D-12 (#2307): a member guest whose consent is still
          // PENDING (or was DECLINED / EXPIRED and survived its removal) holds
          // a bed under D-4 but is NOT operationally present, so they never
          // appear on the kiosk arrivals list. This `some` and the
          // `include.guests.where` below must BOTH carry the predicate: filter
          // only the include and a booking whose sole overlapping guest is
          // pending still matches here, then renders as an empty card.
          ...OPERATIONALLY_PRESENT_GUEST_WHERE,
        },
      },
      // #1422: the guest list (the check-in roster staff read) INCLUDES a
      // booking blocked by a pending admin review so staff can see who is
      // blocked. It is flagged per-booking below via `blockedFromCheckin` and
      // its arrival toggle is disabled in the kiosk. The mutation/enforcement
      // paths (arrive/depart/roster-confirm in lodge-date-scoping.ts) keep
      // excluding it, so a blocked guest still cannot be marked arrived
      // server-side (defense in depth).
    },
    include: {
      guests: {
        where: {
          stayStart: { lte: date },
          stayEnd: { gte: date },
          // D-12 (#2307), the other half of the pair: keep the unconsented
          // guest out of the rendered card as well as out of the booking match.
          ...OPERATIONALLY_PRESENT_GUEST_WHERE,
        },
        include: {
          member: {
            select: {
              ageTier: true,
              phoneCountryCode: true,
              phoneAreaCode: true,
              phoneNumber: true,
            },
          },
          // REQUIRED, not optional (#2631). Without the explicit night rows a
          // sparse stay's internal gap day falls back to the stayStart/stayEnd
          // envelope and reads as presence — a phantom guest on the kiosk, on a
          // day nobody is in the building. The boundary change and this load go
          // together.
          nights: { select: { stayDate: true } },
        },
      },
      member: { select: { firstName: true, lastName: true } },
    },
    orderBy: { checkIn: "asc" },
  });

  const result = bookings
    .map((b) => {
      const presentGuests = getOperationallyPresentGuestsForDay(
        b.guests,
        date,
        b
      );

      return {
        bookingId: b.id,
        memberName: `${b.member.firstName} ${b.member.lastName}`,
        // #1422: flag (don't hide) a booking blocked by a pending admin review.
        // The kiosk shows a "see Booking Officer" note and disables its arrival
        // toggle; the arrive/depart endpoints still reject it server-side.
        blockedFromCheckin: isCheckinBlockedByPendingReview(b),
        guests: presentGuests.map((g) => {
          const ageTier = getBookingGuestDisplayAgeTier(g);
          // The two badges are nothing but which half of the day this guest
          // occupies: evening only = arrives today, morning only = LEAVES
          // TODAY. They are never independent data, so a guest present in the
          // middle of their stay is neither, and no guest can be both.
          const presence = getGuestOperationalDayPresence(g, date, b);

          return {
            id: g.id,
            firstName: g.firstName,
            lastName: g.lastName,
            ageTier,
            isMember: g.isMember,
            isArriving: presence.isArriving,
            isDeparting: presence.isDeparting,
            arrivedAt: g.arrivedAt?.toISOString() ?? null,
            departedAt: g.departedAt?.toISOString() ?? null,
            phone:
              canViewGuestContactDetails && ageTier === "ADULT" && g.member
                ? formatXeroPhone(g.member)
                : null,
          };
        }),
      };
    })
    .filter((booking) => booking.guests.length > 0);

  return NextResponse.json({
    date: dateStr,
    tier,
    bookings: result,
    totalGuests: result.reduce((sum, b) => sum + b.guests.length, 0),
  });
}
