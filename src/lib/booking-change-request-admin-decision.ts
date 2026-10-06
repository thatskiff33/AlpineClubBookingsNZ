import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";
import { bookingOwner } from "@/lib/booking-owner";
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

/**
 * The officer's decision on a LOCKED_PERIOD change request
 * (`PATCH /api/admin/booking-change-requests/[id]`), the parts that are not the
 * acknowledgement the route has always made: the admin read shape it answers
 * with, and — #3750 — approve-and-execute on a FINISHED stay. Kept out of the
 * route file so the route stays a thin dispatcher.
 */

/** The admin-only detail a decision answers with (GET and PATCH). */
export const includeRequestDetail = {
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

/**
 * #3750: the PATCH fields read only when approving EXECUTES the request.
 */
export const finishedStayApprovalFields = {
  /**
   * The officer's confirmation that an over-capacity past night may be
   * overbooked, given after the first attempt answered
   * `OVER_CAPACITY_CONFIRM_REQUIRED`.
   */
  confirmOverCapacity: z.boolean().optional(),
  /** Where a reduction goes when the club's policy offers a choice; absent = back the way it was paid. */
  settlementMethod: z.enum(["card", "credit"]).optional(),
  /** The request `version` the officer's screen was read at. */
  expectedVersion: z.number().int().min(1).optional(),
};

/**
 * #3750: what the officer is told when the stay's nights are priced by no ACTIVE
 * season. Refused, never priced from an inactive season (the blueprint's
 * recommendation, approved 6 Oct 2026); the request stays pending.
 */
const FINISHED_STAY_NO_SEASON_MESSAGE =
  "No active season prices this stay's nights, so nothing has been applied. If the season has been switched off since the stay, switch it back on and approve again; the request is still pending.";

/**
 * #3750: when the decision is APPROVED and the booking's stay has finished,
 * execute the request and answer for it; otherwise `null`, and the route
 * acknowledges as it always has.
 *
 * The choice of path is made on the route's pre-read; the executor asks the same
 * question again under the locks (the edit policy's finished-stay mode), so a
 * booking that stopped qualifying in between is refused there rather than
 * edited.
 */
export async function finishedStayApprovalResponse(
  req: NextRequest,
  args: {
    request: {
      id: string;
      version: number;
      booking: { memberId: string | null; checkOut: Date; status: string };
    };
    body: {
      status: "APPROVED" | "REJECTED";
      adminNotes?: string;
      internalNotes?: string;
      linkedModificationId?: string;
      confirmOverCapacity?: boolean;
      settlementMethod?: "card" | "credit";
      expectedVersion?: number;
    };
    actorMemberId: string;
  },
): Promise<NextResponse | null> {
  const { request, body } = args;
  if (body.status !== "APPROVED") return null;
  const today = (await clubTime()).today();
  if (!isFinishedStay(request.booking, dateOnlyInstantOf(today))) return null;
  if (body.linkedModificationId) {
    return NextResponse.json(
      {
        error:
          "This request is applied when it is approved, and links its own booking modification. Leave the modification id empty.",
      },
      { status: 400 },
    );
  }
  return executeFinishedStayApproval(req, {
    id: request.id,
    actorMemberId: args.actorMemberId,
    subjectMemberId: bookingOwner(request.booking).memberId,
    expectedVersion: body.expectedVersion ?? request.version,
    adminNotes: body.adminNotes?.trim() || null,
    internalNotes: body.internalNotes?.trim() || null,
    confirmOverCapacity: body.confirmOverCapacity === true,
    settlementMethod: body.settlementMethod,
    todayAtClub: today,
  });
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
