import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";

const reviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  /**
   * MEMBER-VISIBLE (#2562). The member reads this verbatim on their booking page
   * under "Change Requests", so the officer panel labels it for that audience
   * before the decision is submitted.
   */
  adminNotes: z.string().max(2000).optional(),
  /**
   * NEVER MEMBER-VISIBLE (#2562). The officer's private commentary, accepted here
   * so the locked-period half of this table has the same honest option the
   * policy-exception half got: before this, one field served both jobs and was
   * member-visible, and the box was headed only "Admin notes" — so an officer
   * recording "third ask this month, do not encourage" had nowhere to put it that
   * the member could not read.
   */
  internalNotes: z.string().max(2000).optional(),
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
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
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
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
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

  // #2524: this route only ever decides LOCKED_PERIOD requests. A POLICY_EXCEPTION
  // request is decided through the booking-policy exception approve-and-execute
  // workflow (#2525), which revalidates hard constraints, executes the canonical
  // booking service atomically and frees the request's open-slot. Marking one
  // APPROVED here would neither execute the booking nor release the slot, so it is
  // refused outright.
  if (existing.kind === "POLICY_EXCEPTION") {
    return NextResponse.json(
      {
        error:
          "Policy-exception requests are reviewed through the booking-policy exception workflow, not this queue.",
      },
      { status: 409 }
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
    // kind guard is defence-in-depth behind the POLICY_EXCEPTION refusal above:
    // this claim can only ever transition a LOCKED_PERIOD row.
    where: { id, status: "REQUESTED", kind: "LOCKED_PERIOD" },
    data: {
      status: parsed.data.status,
      adminNotes: parsed.data.adminNotes?.trim() || null,
      // #2562: the private half, stored beside the member-facing half. No
      // member-facing projection, route select, email template or notification
      // names this column — see `booking-change-request-member-view.ts`.
      internalNotes: parsed.data.internalNotes?.trim() || null,
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
    // #2695 (`INV-PRIV-017`) - member-facing, which PRESERVES what the member
    // reads today rather than widening it: `adminNotes` is #2562's member-facing
    // half, already emailed to them with this decision, while `internalNotes`
    // reaches no member surface and is not in this row at all.
    memberDisclosure: parsed.data.adminNotes?.trim()
      ? { visibility: "member-facing", text: parsed.data.adminNotes.trim() }
      : { visibility: "internal" },
    metadata: {
      bookingId: existing.booking.id,
      requestId: id,
      status: parsed.data.status,
      linkedModificationId: parsed.data.linkedModificationId ?? null,
      // WHETHER an internal note was left, never its text (#2562). The audit log
      // is read by more surfaces than this queue, and a private note copied into
      // it would be private in one place and not the other.
      internalNoteRecorded: Boolean(parsed.data.internalNotes?.trim()),
    },
    ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
  });

  const updated = await prisma.bookingChangeRequest.findUnique({
    where: { id },
    include: includeRequestDetail,
  });

  return NextResponse.json(updated);
}
