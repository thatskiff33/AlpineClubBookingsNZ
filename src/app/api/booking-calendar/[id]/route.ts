import { NextRequest, NextResponse } from "next/server";
import type { BookingStatus } from "@prisma/client";
import {
  buildBookingIcs,
  verifyBookingCalendarToken,
} from "@/lib/calendar-links";
import { formatDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

// Whether each booking state still describes a stay that stands. Total over
// BookingStatus BY CONSTRUCTION (`satisfies Record<...>`), so adding an enum
// member without deciding its row here is a compile error rather than a
// silently-servable default. The confirmation email is only sent past the
// false states, so a valid emailed link only meets one after the booking was
// later cancelled or bumped — serving those would put a stay that no longer
// exists into someone's calendar.
const SERVABLE_BOOKING_STATUS = {
  DRAFT: false,
  PENDING: true,
  PAYMENT_PENDING: true,
  CONFIRMED: true,
  PAID: true,
  BUMPED: false,
  CANCELLED: false,
  COMPLETED: true,
  WAITLISTED: false,
  WAITLIST_OFFERED: false,
  AWAITING_REVIEW: true,
} satisfies Record<BookingStatus, boolean>;

/**
 * Sessionless .ics download for one booking's stay (fork issue #35).
 *
 * Deliberately at /api/booking-calendar, NOT /api/calendar: the /api/calendar
 * prefix is module-gated behind the eventsCalendar flag (feature-routes.ts),
 * and this download belongs to bookings, which every deployment runs — a club
 * with the events calendar off must not have its confirmation-email links
 * 404 (review finding I).
 *
 * Linked from the booking-confirmed email's `{{ical}}` block, so it must work
 * without a signed-in session: the `token` query parameter is an HMAC over
 * the `exp` expiry and the booking id under the app auth secret (see
 * calendar-links.ts — the expiry is inside the signed message, so it cannot
 * be extended). A live token reads exactly one booking's stay dates and lodge
 * name; an expired token, a tampered expiry, a wrong-booking token, and a
 * gone booking are all one indistinguishable 404.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = await applyRateLimit(
    rateLimiters.bookingCalendarDownload,
    request,
  );
  if (rateLimited) {
    return rateLimited;
  }

  const { id } = await params;
  const token = request.nextUrl.searchParams.get("token");
  const expiresAtSeconds = Number(request.nextUrl.searchParams.get("exp"));
  if (
    !id ||
    !token ||
    !verifyBookingCalendarToken({
      bookingId: id,
      expiresAtSeconds,
      token,
      now: new Date(),
    })
  ) {
    return new NextResponse(null, { status: 404 });
  }

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: {
      checkIn: true,
      checkOut: true,
      status: true,
      deletedAt: true,
      updatedAt: true,
      lodge: { select: { name: true } },
    },
  });
  if (
    !booking ||
    booking.deletedAt ||
    !SERVABLE_BOOKING_STATUS[booking.status]
  ) {
    return new NextResponse(null, { status: 404 });
  }

  const ics = buildBookingIcs({
    stay: { bookingId: id, checkIn: booking.checkIn, checkOut: booking.checkOut },
    lodgeName: booking.lodge.name,
    // Rises with every booking update, so a re-downloaded file REPLACES the
    // event revision a calendar already holds (RFC 5545 SEQUENCE).
    sequence: Math.floor(booking.updatedAt.getTime() / 1000),
    generatedAt: new Date(),
  });

  // The check-in date in the filename keeps a member's second stay from
  // downloading as "lodge-stay(1).ics" (review finding F). checkIn is a
  // date-only value, so formatDateOnly is its canonical encoder (INV-DATE-019).
  const filenameDate = formatDateOnly(booking.checkIn).replaceAll("-", "");
  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="lodge-stay-${filenameDate}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
