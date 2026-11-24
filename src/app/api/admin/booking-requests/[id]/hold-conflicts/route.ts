import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  checkCapacity,
  findOverlappingCapacityHoldingBookings,
  findOverlappingOverriddenNonHoldingBookings,
  getLodgeHeldNights,
} from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { formatDateOnly } from "@/lib/date-only";
import {
  ADMIN_BOOKING_REQUEST_HOLD_CONFLICTS_CONNECTION_SHAPE,
  type AdminBookingRequestHoldConflictsAnswer,
} from "@/lib/connection-shapes/bookings-requests";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * Advisory, ADMIN-ONLY pre-approval availability + conflict preview for a
 * whole-lodge booking request (#2263), mirroring the existing `link-conflicts`
 * advisory route pattern.
 *
 * What it answers, for the officer only: how full each requested night already
 * is, which nights are already exclusively held, which capacity-holding bookings
 * overlap the request, and which overridden-but-not-yet-holding bookings will
 * settle onto those nights later (#177).
 *
 * It NEVER blocks: ADR-001 decision 1 says an exclusive hold is granted
 * regardless of existing overlaps, and the officer resolves them by hand. This
 * only makes the clash visible before they press Approve.
 *
 * This is the single largest concentration of occupancy data in the whole
 * #2263 feature, and it is why the route lives under /api/admin/ behind
 * requireAdmin: a member must never learn that a night is held or full for a
 * reason other than their own booking (ADR-001 decision 6). No member surface
 * calls it and the route-boundary matrix asserts the admin guard.
 *
 * Also the AI app action `get_booking_request_hold_conflicts` (ALP-719): an
 * officer's connection only, through the same `requireAdmin`.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;

  const request = await prisma.bookingRequest.findUnique({
    where: { id },
    select: { id: true, checkIn: true, checkOut: true, lodgeId: true },
  });
  if (!request) {
    return NextResponse.json(
      { error: "Booking request not found" },
      { status: 404 }
    );
  }

  // A null request lodge means the club's default lodge (BookingRequest.lodgeId
  // null semantics) — resolve it the same way every other reader does.
  const lodgeId = request.lodgeId ?? (await getDefaultLodgeId(prisma));

  const [lodgeCapacity, availability, heldNights, conflicts, overriddenConflicts] =
    await Promise.all([
      getLodgeCapacity(lodgeId),
      // Per-night occupancy summary for the strip. guestCount 0 means "tell me
      // what is already there", not "can N more fit".
      checkCapacity(lodgeId, request.checkIn, request.checkOut, 0),
      getLodgeHeldNights(lodgeId, request.checkIn, request.checkOut),
      findOverlappingCapacityHoldingBookings(prisma, {
        lodgeId,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
      }),
      findOverlappingOverriddenNonHoldingBookings(prisma, {
        lodgeId,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
      }),
    ]);

  const heldNightSet = new Set(heldNights);

  const answer: AdminBookingRequestHoldConflictsAnswer = {
    lodgeId,
    lodgeCapacity,
    nights: availability.nightDetails.map((night) => {
      const date = formatDateOnly(night.date);
      return {
        date,
        // Beds still free that night, floored at zero: an over-capacity
        // override can push the raw number negative, which reads as nonsense on
        // a strip.
        availableBeds: Math.max(0, night.availableBeds),
        occupiedBeds: Math.max(0, lodgeCapacity - night.availableBeds),
        wholeLodgeHeld: heldNightSet.has(date),
      };
    }),
    // Informational only — see the module comment. Never a refusal.
    conflicts: [...conflicts, ...overriddenConflicts],
  };
  return connectionJson(req, answer, ADMIN_BOOKING_REQUEST_HOLD_CONFLICTS_CONNECTION_SHAPE);
}
