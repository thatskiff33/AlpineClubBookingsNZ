import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { bookingOwner } from "@/lib/booking-owner";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { hasAdminAccess } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { isMemberCancellableBookingStatus } from "@/lib/booking-cancel-eligibility";
import { bookingNotesUpdateSchema } from "@/lib/booking-detail-edit-schemas";
import { BOOKING_NOTE_CONNECTION_SHAPE } from "@/lib/connection-shapes-bookings";
import { connectionJson, memberOnlySessionUser } from "@/lib/mcp-connection-request";

/**
 * The note on a booking. Also the AI app action `set_my_booking_note`
 * (ALP-794), which acts as the member only: an officer's reach to another
 * member's booking reads the member-only user.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const user = memberOnlySessionUser(req, session.user);
  const isAdmin = hasAdminAccess(user);

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { memberId: true, status: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer
  // (bookings:edit) may edit the admin notes on any booking.
  if (
    bookingOwner(booking).memberId !== user.id &&
    !isAdmin &&
    !hasAdminAreaAccess(user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // #3497: the notes editor on the booking page is drawn by `canCancel`, so the
  // statuses it saves for are the member-door cancel set — derived from the one
  // home rather than a third list (which used to omit PAID, so a paid member saw
  // the editor and was refused on save).
  if (!isMemberCancellableBookingStatus(booking.status)) {
    return NextResponse.json(
      { error: "Notes can only be edited on active bookings" },
      { status: 400 }
    );
  }

  const jsonBody = await parseJsonRequestBody(req, { error: "Invalid JSON" });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = bookingNotesUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { notes: parsed.data.notes || null },
    select: { id: true, notes: true },
  });

  return connectionJson(req, updated, BOOKING_NOTE_CONNECTION_SHAPE);
}
