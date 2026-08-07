import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { getTodayDateOnly, normalizeDateOnlyForTimeZone } from "@/lib/date-only";
import { hasAdminAccess } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { expectedArrivalTimeSchema } from "@/lib/arrival-time";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";

// HH:mm on the hour or half hour. The rule itself lives in `@/lib/arrival-time`
// (#2621) because it used to be written out here, in the booking-create route and
// a third time in a test — all three as `[0-5]0`, which also accepted :10, :20,
// :40 and :50 while claiming otherwise.
const arrivalTimeSchema = z.object({
  expectedArrivalTime: expectedArrivalTimeSchema,
});

/**
 * PUT /api/bookings/[id]/arrival-time
 * Set or update the expected arrival time on a booking.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { memberId: true, checkIn: true, status: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Only booking owner or admin can update
  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer
  // (bookings:edit) may set/clear the expected arrival time on any booking.
  if (
    booking.memberId !== session.user.id &&
    !hasAdminAccess(session.user) &&
    !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update arrival time for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  // Cannot update after check-in date has passed
  const today = getTodayDateOnly();
  if (normalizeDateOnlyForTimeZone(booking.checkIn) < today) {
    return NextResponse.json(
      { error: "Cannot update arrival time after check-in date has passed" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = arrivalTimeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { expectedArrivalTime: parsed.data.expectedArrivalTime },
    select: { id: true, expectedArrivalTime: true },
  });

  // #2621: this writer recorded nothing. A booking officer may set the time on
  // ANY member's booking (#1313 option A2), so without a row there was no way to
  // tell an owner's own edit from an officer's, or to answer "who changed this"
  // at all. Categorised `booking` like every other booking write beside it, and
  // written after the update so a failed write records nothing.
  logAudit({
    action: "booking.expected_arrival_time.set",
    memberId: session.user.id,
    targetId: id,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary: "Expected arrival time set on a booking",
    metadata: {
      expectedArrivalTime: updated.expectedArrivalTime,
      // Names the authority used, because owner and officer are different facts
      // about the same row and the ids alone do not distinguish them.
      onBehalf: booking.memberId !== session.user.id,
    },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/bookings/[id]/arrival-time
 * Clear the expected arrival time.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    // `expectedArrivalTime` is selected for the audit row below: the clear
    // destroys it, so this read is the only chance to record what was there.
    select: {
      memberId: true,
      checkIn: true,
      status: true,
      expectedArrivalTime: true,
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  const previousExpectedArrivalTime = booking.expectedArrivalTime;

  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer
  // (bookings:edit) may set/clear the expected arrival time on any booking.
  if (
    booking.memberId !== session.user.id &&
    !hasAdminAccess(session.user) &&
    !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update arrival time for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  const today = getTodayDateOnly();
  if (normalizeDateOnlyForTimeZone(booking.checkIn) < today) {
    return NextResponse.json(
      { error: "Cannot update arrival time after check-in date has passed" },
      { status: 400 }
    );
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { expectedArrivalTime: null },
    select: { id: true, expectedArrivalTime: true },
  });

  // #2621: the clear recorded nothing either — and it is the more consequential
  // of the two, because it destroys the previous value. The row below is the only
  // record that a time was ever set, so it carries what was cleared.
  logAudit({
    action: "booking.expected_arrival_time.cleared",
    memberId: session.user.id,
    targetId: id,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary: "Expected arrival time cleared on a booking",
    metadata: {
      clearedExpectedArrivalTime: previousExpectedArrivalTime,
      onBehalf: booking.memberId !== session.user.id,
    },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json(updated);
}
