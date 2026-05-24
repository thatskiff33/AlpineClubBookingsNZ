import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";

const reviewSchema = z.object({
  status: z.enum(["RESOLVED", "DECLINED"]),
  adminNotes: z.string().max(2000).optional(),
});

const includeRequestDetail = {
  requester: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
  reviewedBy: {
    select: { id: true, firstName: true, lastName: true },
  },
  booking: {
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      status: true,
      finalPriceCents: true,
      memberId: true,
      member: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      payment: {
        select: {
          id: true,
          amountCents: true,
          refundedAmountCents: true,
          status: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
        },
      },
    },
  },
} as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const { id } = await params;
  const request = await prisma.bookingChangeRequest.findUnique({
    where: { id },
    include: includeRequestDetail,
  });

  if (!request) {
    return NextResponse.json({ error: "Booking change request not found" }, { status: 404 });
  }

  return NextResponse.json(request);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const { id } = await params;
  const body = await req.json();
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.bookingChangeRequest.findUnique({
    where: { id },
    include: { booking: { select: { id: true, memberId: true } } },
  });

  if (!existing) {
    return NextResponse.json({ error: "Booking change request not found" }, { status: 404 });
  }

  if (existing.status !== "PENDING") {
    return NextResponse.json(
      { error: "This booking change request has already been reviewed" },
      { status: 400 }
    );
  }

  const reviewedAt = new Date();
  const claim = await prisma.bookingChangeRequest.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: parsed.data.status,
      adminNotes: parsed.data.adminNotes?.trim() || null,
      reviewedById: session.user.id,
      reviewedAt,
    },
  });

  if (claim.count !== 1) {
    return NextResponse.json(
      { error: "This booking change request has already been reviewed" },
      { status: 409 }
    );
  }

  logAudit({
    action:
      parsed.data.status === "RESOLVED"
        ? "booking-change-request.resolve"
        : "booking-change-request.decline",
    memberId: session.user.id,
    targetId: existing.booking.id,
    subjectMemberId: existing.booking.memberId,
    entityType: "BookingChangeRequest",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary:
      parsed.data.status === "RESOLVED"
        ? "Booking change request resolved"
        : "Booking change request declined",
    details: parsed.data.adminNotes?.trim() || null,
    metadata: {
      bookingId: existing.booking.id,
      requestId: id,
      status: parsed.data.status,
    },
    ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
  });

  const updated = await prisma.bookingChangeRequest.findUnique({
    where: { id },
    include: includeRequestDetail,
  });

  return NextResponse.json(updated);
}
