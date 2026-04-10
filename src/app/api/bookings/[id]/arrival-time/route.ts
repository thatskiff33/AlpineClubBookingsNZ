import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";

// Matches HH:mm with 30-min increments (00 or 30)
const arrivalTimeSchema = z.object({
  expectedArrivalTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]0$/, "Must be HH:mm with 30-minute increments"),
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
    select: { memberId: true, checkIn: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Only booking owner or admin can update
  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Cannot update after check-in date has passed
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (new Date(booking.checkIn) < today) {
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

  return NextResponse.json(updated);
}

/**
 * DELETE /api/bookings/[id]/arrival-time
 * Clear the expected arrival time.
 */
export async function DELETE(
  _req: NextRequest,
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
    select: { memberId: true, checkIn: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (new Date(booking.checkIn) < today) {
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

  return NextResponse.json(updated);
}
