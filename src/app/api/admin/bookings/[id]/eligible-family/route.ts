import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveMemberFamily } from "@/lib/resolve-member-family";
import { listBookingPartnerSharingCandidates } from "@/lib/double-bed-sharing";
import {
  ADMIN_BOOKING_ELIGIBLE_FAMILY_CONNECTION_SHAPE,
  type AdminBookingEligibleFamilyAnswer,
} from "@/lib/connection-shapes/bookings-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * GET /api/admin/bookings/[id]/eligible-family
 *
 * On-behalf family picker for the EDIT-booking flow. Gated on `bookings:edit`
 * (NOT membership:view), so a Booking Officer whose customised role has had
 * membership:view removed can still attach the correct member identity to a
 * guest and get correct member pricing — instead of the picker silently
 * emptying and the member being re-added as a mispriced non-member
 * (issue #1376, owner-approved option A).
 *
 * The booking owner's memberId is read SERVER-SIDE from the booking; the client
 * never supplies a member id here. It returns exactly one member's family group
 * (via the shared resolveMemberFamily helper), never a directory enumeration.
 * Also the AI app action `get_booking_owner_family` (ALP-719).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id: bookingId } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { memberId: true },
  });
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // #3369: the family-quick-add panel offers the BOOKER's own family group. A
  // school booking has no booker and therefore no family to offer, which is the
  // same empty answer the invented school member gave — it belonged to no
  // group. The 404 is the existing "no member" path, unchanged.
  const familyOwnerMemberId = bookingOwner(booking).memberId;
  const family = familyOwnerMemberId
    ? await resolveMemberFamily(familyOwnerMemberId)
    : null;
  if (!family) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  // #1746: confirmed partners of the booking's member guests, offered by the
  // edit panel as partner-sharer quick-adds (a confirmed partner is usually
  // NOT a family-group member, so the family list alone cannot carry them).
  const partnerSharingCandidates =
    await listBookingPartnerSharingCandidates(bookingId);

  const answer: AdminBookingEligibleFamilyAnswer = { ...family, partnerSharingCandidates };
  return connectionJson(request, answer, ADMIN_BOOKING_ELIGIBLE_FAMILY_CONNECTION_SHAPE);
}
