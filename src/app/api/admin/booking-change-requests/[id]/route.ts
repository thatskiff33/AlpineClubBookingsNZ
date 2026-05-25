import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";

const reviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  adminNotes: z.string().max(2000).optional(),
  linkedModificationId: z.string().min(1).optional(),
});

const includeRequestDetail = {
  requestedBy: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
  reviewedBy: {
    select: { id: true, firstName: true, lastName: true },
  },
  linkedModification: {
    select: {
      id: true,
      createdAt: true,
      modificationType: true,
      priceDiffCents: true,
      changeFeeCents: true,
    },
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
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

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
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  const body = await req.json();
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  if (parsed.data.status === "REJECTED" && parsed.data.linkedModificationId) {
    return NextResponse.json(
      { error: "linkedModificationId cannot be attached to a rejected change request" },
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

  if (existing.status !== "REQUESTED") {
    return NextResponse.json(
      { error: "This booking change request has already been reviewed" },
      { status: 400 }
    );
  }

  if (parsed.data.linkedModificationId) {
    const modification = await prisma.bookingModification.findUnique({
      where: { id: parsed.data.linkedModificationId },
      select: { id: true, bookingId: true },
    });
    if (!modification) {
      return NextResponse.json(
        { error: "Linked booking modification not found" },
        { status: 400 }
      );
    }
    if (modification.bookingId !== existing.booking.id) {
      return NextResponse.json(
        { error: "Linked booking modification does not belong to this booking" },
        { status: 400 }
      );
    }
  }

  const reviewedAt = new Date();
  const claim = await prisma.bookingChangeRequest.updateMany({
    where: { id, status: "REQUESTED" },
    data: {
      status: parsed.data.status,
      adminNotes: parsed.data.adminNotes?.trim() || null,
      reviewedByMemberId: session.user.id,
      reviewedAt,
      linkedModificationId: parsed.data.linkedModificationId ?? null,
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
      parsed.data.status === "APPROVED"
        ? "booking-change-request.approve"
        : "booking-change-request.reject",
    memberId: session.user.id,
    targetId: existing.booking.id,
    subjectMemberId: existing.booking.memberId,
    entityType: "BookingChangeRequest",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary:
      parsed.data.status === "APPROVED"
        ? "Booking change request approved"
        : "Booking change request rejected",
    details: parsed.data.adminNotes?.trim() || null,
    metadata: {
      bookingId: existing.booking.id,
      requestId: id,
      status: parsed.data.status,
      linkedModificationId: parsed.data.linkedModificationId ?? null,
    },
    ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
  });

  const updated = await prisma.bookingChangeRequest.findUnique({
    where: { id },
    include: includeRequestDetail,
  });

  return NextResponse.json(updated);
}
