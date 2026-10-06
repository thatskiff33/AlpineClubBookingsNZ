import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";
import { ApiError } from "@/lib/api-error";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { clubTime } from "@/lib/club-time/server";
import { dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import { clubFormatValues } from "@/lib/club-format-server";
import { isFinishedStay } from "@/lib/booking-edit-policy";
import { approveAndExecuteLockedPeriodChangeRequest } from "@/lib/booking-change-request-execution";
import { prepareBatchModificationForCallerTransaction } from "@/lib/booking-batch-modification-service";
import { BookingModificationSettlementMethodRequiredError } from "@/lib/booking-modify-settlement-required";
import { NO_SEASON_RATE_MESSAGE } from "@/lib/booking-modify-plan";
import {
  OverCapacityConfirmationRequiredError,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";

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
  /**
   * #3750: only read when approving EXECUTES the request (a finished stay). The
   * officer's confirmation that an over-capacity past night may be overbooked,
   * given after the first attempt answered `OVER_CAPACITY_CONFIRM_REQUIRED`.
   */
  confirmOverCapacity: z.boolean().optional(),
  /**
   * #3750: where a reduction goes when the club's policy offers a choice.
   * Absent means back the way it was paid.
   */
  settlementMethod: z.enum(["card", "credit"]).optional(),
  /** #3750: the request `version` the officer's screen was read at. */
  expectedVersion: z.number().int().min(1).optional(),
});

/**
 * #3750: what the officer is told when the stay's nights are priced by no ACTIVE
 * season. Refused, never priced from an inactive season (the blueprint's
 * recommendation, approved 6 Oct 2026); the request stays pending.
 */
const FINISHED_STAY_NO_SEASON_MESSAGE =
  "No active season prices this stay's nights, so nothing has been applied. If the season has been switched off since the stay, switch it back on and approve again; the request is still pending.";

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
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
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
    include: {
      booking: {
        select: { id: true, memberId: true, checkOut: true, status: true },
      },
    },
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

  // #3750: approving a request on a FINISHED stay executes it. The choice of
  // path is made on this pre-read; the executor asks the same question again
  // under the locks (the edit policy's finished-stay mode), so a booking that
  // stopped qualifying in between is refused there rather than edited.
  if (parsed.data.status === "APPROVED") {
    const today = (await clubTime()).today();
    if (isFinishedStay(existing.booking, dateOnlyInstantOf(today))) {
      if (parsed.data.linkedModificationId) {
        return NextResponse.json(
          {
            error:
              "This request is applied when it is approved, and links its own booking modification. Leave the modification id empty.",
          },
          { status: 400 },
        );
      }
      return executeFinishedStayApproval(req, {
        id,
        actorMemberId: session.user.id,
        subjectMemberId: bookingOwner(existing.booking).memberId,
        expectedVersion: parsed.data.expectedVersion ?? existing.version,
        adminNotes: parsed.data.adminNotes?.trim() || null,
        internalNotes: parsed.data.internalNotes?.trim() || null,
        confirmOverCapacity: parsed.data.confirmOverCapacity === true,
        settlementMethod: parsed.data.settlementMethod,
        todayAtClub: today,
      });
    }
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
      // The optimistic token every mutating write bumps (schema docblock), so a
      // concurrent execution reading the old version loses its claim (#3750).
      version: { increment: 1 },
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
    subjectMemberId: bookingOwner(existing.booking).memberId,
    entityType: "BookingChangeRequest",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary:
      parsed.data.status === "APPROVED"
        ? "Booking change request approved"
        : "Booking change request rejected",
    details: parsed.data.adminNotes?.trim() || null,
    // #2695 (`INV-PRIV-018`) - member-facing, which PRESERVES what the member
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
      // #3750: an acknowledgement, not an execution — the stay had not finished.
      executed: false,
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

/**
 * #3750: approve-and-execute on a finished stay. Every refusal leaves the
 * request REQUESTED at its old version — the executor's transaction rolled the
 * claim back with everything else — and says so.
 */
async function executeFinishedStayApproval(
  req: NextRequest,
  args: {
    id: string;
    actorMemberId: string;
    subjectMemberId: string | null;
    expectedVersion: number;
    adminNotes: string | null;
    internalNotes: string | null;
    confirmOverCapacity: boolean;
    settlementMethod: "card" | "credit" | undefined;
    todayAtClub: CalendarDate;
  },
): Promise<NextResponse> {
  const { id } = args;
  const ipAddress = getClientIp(req);
  // Resolved BEFORE the executor opens its transaction (`INV-LOCK-004`): the
  // club's format, and the member-guest policy, lockout mode and Xero lock
  // dates the batch service would otherwise read under two locks.
  const format = await clubFormatValues();
  const preTransaction = await prepareBatchModificationForCallerTransaction({
    audience: "admin",
  });
  const pending = (error: string, status: number, extra: Record<string, unknown> = {}) =>
    NextResponse.json({ id, status: "REQUESTED", keptPending: true, error, ...extra }, { status });

  let result;
  try {
    result = await approveAndExecuteLockedPeriodChangeRequest({
      requestId: id,
      expectedVersion: args.expectedVersion,
      actorMemberId: args.actorMemberId,
      adminNotes: args.adminNotes,
      internalNotes: args.internalNotes,
      confirmOverCapacity: args.confirmOverCapacity,
      settlementMethod: args.settlementMethod,
      todayAtClub: args.todayAtClub,
      format,
      preTransaction,
      ipAddress,
    });
  } catch (error) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(error, {
      id,
      status: "REQUESTED",
      keptPending: true,
    });
    if (hostingRetry) return hostingRetry;
    if (error instanceof OverCapacityConfirmationRequiredError) {
      // Decision 3: warn, and let the officer confirm. Nothing was written.
      return pending(
        "Some of this stay's nights are over the lodge's capacity with these guests. Confirm the overbooking to approve and apply the change.",
        409,
        { code: error.code, nightDetails: error.nightDetails, needsCapacityConfirmation: true },
      );
    }
    if (error instanceof WholeLodgeHoldBlockedError) {
      return pending(error.message, 409, {
        code: error.code,
        blockedNights: error.blockedNights,
      });
    }
    if (error instanceof BookingModificationSettlementMethodRequiredError) {
      return pending(
        "This change reduces the price, so choose whether the refund goes back the way it was paid or to account credit, then approve again.",
        400,
        { needsSettlementMethod: true },
      );
    }
    if (error instanceof ApiError) {
      if (error.message === NO_SEASON_RATE_MESSAGE) {
        return pending(FINISHED_STAY_NO_SEASON_MESSAGE, 409, { code: "NO_ACTIVE_SEASON" });
      }
      const code = (error as { code?: unknown }).code;
      return pending(error.message, error.status, typeof code === "string" ? { code } : {});
    }
    logger.error({ err: error, requestId: id }, "Locked-period change request execution failed");
    return pending("The approval could not be completed. The request is still pending.", 500);
  }

  switch (result.outcome) {
    case "notFound":
      return NextResponse.json({ error: "Booking change request not found" }, { status: 404 });
    case "notAuthorized":
      return NextResponse.json(
        { error: "Your account can no longer approve booking changes" },
        { status: 403 },
      );
    case "claimLost":
      return NextResponse.json(
        { error: "This booking change request has already been reviewed" },
        { status: 409 },
      );
    case "keptPending":
      return pending(result.message, 409);
    case "executed":
      break;
  }

  logAudit({
    action: "booking-change-request.approve",
    memberId: args.actorMemberId,
    targetId: result.bookingId,
    subjectMemberId: args.subjectMemberId,
    entityType: "BookingChangeRequest",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary: "Booking change request approved and applied to the finished stay",
    details: args.adminNotes,
    // `INV-PRIV-018`: exactly what the acknowledgement path discloses — the
    // member-facing explanation, which the member already reads — and nothing
    // of the internal note.
    memberDisclosure: args.adminNotes
      ? { visibility: "member-facing", text: args.adminNotes }
      : { visibility: "internal" },
    metadata: {
      bookingId: result.bookingId,
      requestId: id,
      status: "APPROVED",
      executed: true,
      modificationId: result.modificationId,
      linkedModificationId: result.modificationId,
      addedGuestCount: result.addedGuestCount,
      removedGuestCount: result.removedGuestCount,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      additionalAmountCents: result.additionalAmountCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      capacityOverridden: result.capacityOverridden,
      followUpFailed: result.followUpFailed === true,
      internalNoteRecorded: Boolean(args.internalNotes),
    },
    ipAddress,
  });

  const updated = await prisma.bookingChangeRequest.findUnique({
    where: { id },
    include: includeRequestDetail,
  });
  return NextResponse.json({
    ...updated,
    execution: {
      executed: true,
      modificationId: result.modificationId,
      additionalAmountCents: result.additionalAmountCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      changeFeeCents: result.changeFeeCents,
      capacityOverridden: result.capacityOverridden,
      followUpFailed: result.followUpFailed === true,
    },
  });
}
