import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { sendAdminRefundRequestAlert } from "@/lib/email";

const createSchema = z.object({
  reason: z.string().min(10).max(2000),
  requestedAmountCents: z.number().int().min(1).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const { id: bookingId } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Only cancelled bookings with partial or zero refund are eligible
  if (booking.status !== "CANCELLED") {
    return NextResponse.json(
      { error: "Refund appeals are only available for cancelled bookings" },
      { status: 400 }
    );
  }

  if (!booking.payment || booking.payment.status === "REFUNDED") {
    return NextResponse.json(
      { error: "This booking already received a full refund" },
      { status: 400 }
    );
  }

  // Check for existing pending request
  const existingRequest = await prisma.refundRequest.findFirst({
    where: { bookingId, status: "PENDING" },
  });

  if (existingRequest) {
    return NextResponse.json(
      { error: "A refund appeal is already pending for this booking" },
      { status: 400 }
    );
  }

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { reason, requestedAmountCents } = parsed.data;

  // Validate requested amount doesn't exceed what was paid minus already refunded
  const maxRefundable =
    booking.payment.amountCents - booking.payment.refundedAmountCents;
  if (requestedAmountCents && requestedAmountCents > maxRefundable) {
    return NextResponse.json(
      {
        error: `Requested amount exceeds maximum refundable amount of $${(maxRefundable / 100).toFixed(2)}`,
      },
      { status: 400 }
    );
  }

  const refundRequest = await prisma.refundRequest.create({
    data: {
      bookingId,
      memberId: session.user.id,
      reason,
      requestedAmountCents: requestedAmountCents ?? null,
    },
  });

  logAudit({
    action: "refund-request.create",
    memberId: session.user.id,
    targetId: bookingId,
    details: `Refund appeal submitted${requestedAmountCents ? ` for $${(requestedAmountCents / 100).toFixed(2)}` : ""}`,
    ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
  });

  // Notify admins
  sendAdminRefundRequestAlert({
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    bookingId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    reason,
    requestedAmountCents: requestedAmountCents ?? null,
    paidAmountCents: booking.payment.amountCents,
    refundedAmountCents: booking.payment.refundedAmountCents,
  }).catch(() => {});

  return NextResponse.json(refundRequest, { status: 201 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const { id: bookingId } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { memberId: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const requests = await prisma.refundRequest.findMany({
    where: { bookingId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(requests);
}
