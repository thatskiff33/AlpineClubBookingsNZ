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
import {
  approveAndExecuteLockedPeriodChangeRequest,
  FinishedStayFiguresChangedError,
  type FinishedStayApprovalMode,
  type FinishedStayExpectedFigures,
} from "@/lib/booking-change-request-execution";
import { prepareBatchModificationForCallerTransaction } from "@/lib/booking-batch-modification-service";
import { BookingModificationSettlementMethodRequiredError } from "@/lib/booking-modify-settlement-required";
import { NO_SEASON_RATE_MESSAGE } from "@/lib/booking-modify-plan";
import {
  OverCapacityConfirmationRequiredError,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { OwnDependantIdentityRefusedError } from "@/lib/booking-dependant-identity";
import {
  dependantIdentityRefusalBody,
  dependantIdentitySpeaksOnBehalf,
} from "@/lib/booking-dependant-identity-doors";
import {
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
} from "@/lib/booking-guests";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import type { ClubFormat } from "@/lib/club-format";
import {
  officerEnteredGuestsSchema,
  type OfficerEnteredGuest,
} from "@/lib/booking-change-request-guests";
import {
  changeRequestPromoChangeSchema,
  OFFICER_PROMO_NEEDS_EXECUTION_MESSAGE,
  type ChangeRequestPromoChange,
} from "@/lib/booking-change-request-promo";

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
  /** Where a reduction goes; absent = back the way the booking was paid. */
  settlementMethod: z.enum(["card", "credit"]).optional(),
  /** The request `version` the officer's screen was read at. */
  expectedVersion: z.number().int().min(1).optional(),
  /**
   * The officer's screen's own answer to "does approving apply this change?"
   * (#3955 concurrency review). REQUIRED on an approval: a card rendered before
   * the stay finished must not apply a change its officer was told would only
   * be acknowledged, nor the other way round.
   */
  execute: z.boolean().optional(),
  /**
   * #4030 Part B: the guests the officer entered for a request that named no
   * change (a member's free-text note), each with its nights. Accepted only on
   * an approval that applies the request; stored on it as officer-entered on
   * the member's behalf by the approval's own claim.
   */
  officerGuests: officerEnteredGuestsSchema.optional(),
  /**
   * #4533: a promo code the officer entered on the member's behalf, for a
   * request that names none. Accepted only on an approval that applies the
   * request; stored on it by the approval's own claim.
   */
  officerPromo: changeRequestPromoChangeSchema.optional(),
  /**
   * #4533: the officer's notify-or-not choice; absent means notify. `false`
   * is refused unless the request's one change is a promo code.
   */
  notifyMember: z.boolean().optional(),
  /**
   * #4030 review C4: the money figures the officer's check showed, REQUIRED on
   * an approval that applies the request; the executor refuses one whose own
   * figures differ.
   */
  expectedFigures: z
    .object({
      additionalAmountCents: z.number().int(),
      refundAmountCents: z.number().int(),
      accountCreditAmountCents: z.number().int(),
    })
    .optional(),
};

/** #4030 review C4: an applying approval sent without the figures it was shown. */
export const EXPECTED_FIGURES_MISSING_MESSAGE =
  "Check the figures before approving, so the change applies at the amounts you saw. Nothing has been changed.";

/** The quote route's body (P2 on #3955), with the officer's entry (#4030). */
export const finishedStayQuoteSchema = z.object({
  confirmOverCapacity: z.boolean().optional(),
  settlementMethod: z.enum(["card", "credit"]).optional(),
  officerGuests: officerEnteredGuestsSchema.optional(),
  /** #4533: the officer's promo entry, priced exactly as approving would. */
  officerPromo: changeRequestPromoChangeSchema.optional(),
});

/** #4030: an officer's entry outside an approval that applies the request. */
export const OFFICER_GUESTS_NEED_EXECUTION_MESSAGE =
  "Guests can be entered only when approving a request on a finished stay, which applies them. Nothing has been changed.";

/**
 * #3750: what the officer is told when the stay's nights are priced by no ACTIVE
 * season. Refused, never priced from an inactive season (the blueprint's
 * recommendation, approved 6 Oct 2026); the request stays pending.
 */
const FINISHED_STAY_NO_SEASON_MESSAGE =
  "No active season prices this stay's nights, so nothing has been applied. If the season has been switched off since the stay, switch it back on and approve again; the request is still pending.";

export const EXECUTION_INTENT_MISSING_MESSAGE =
  "Reload the queue: this approval does not say whether it applies the change.";
export const EXECUTION_INTENT_NOW_APPLIES_MESSAGE =
  "Reload: approving now applies this change, because the stay has finished. Nothing has been changed.";
export const EXECUTION_INTENT_NOW_ACKNOWLEDGES_MESSAGE =
  "Reload: approving now only acknowledges this request, because the stay has not finished. Nothing has been changed.";

type PreReadRequest = {
  id: string;
  version: number;
  booking: { memberId: string | null; checkOut: Date; status: string };
};

/**
 * #3750: when the decision is APPROVED and the booking's stay has finished,
 * execute the request and answer for it; otherwise `null`, and the route
 * acknowledges as it always has.
 *
 * The choice of path is made on the route's pre-read and must MATCH the
 * client's `execute` intent; the executor asks the same question again under
 * the locks (the edit policy's finished-stay mode), so a booking that stopped
 * qualifying in between is refused there rather than edited.
 */
export async function finishedStayApprovalResponse(
  req: NextRequest,
  args: {
    request: PreReadRequest;
    body: {
      status: "APPROVED" | "REJECTED";
      adminNotes?: string;
      internalNotes?: string;
      linkedModificationId?: string;
      confirmOverCapacity?: boolean;
      settlementMethod?: "card" | "credit";
      expectedVersion?: number;
      execute?: boolean;
      officerGuests?: OfficerEnteredGuest[];
      officerPromo?: ChangeRequestPromoChange;
      notifyMember?: boolean;
      expectedFigures?: FinishedStayExpectedFigures;
    };
    actorMemberId: string;
  },
): Promise<NextResponse | null> {
  const { request, body } = args;
  // #4030 review C3 / #4533: an entry sent with a decision that applies nothing
  // is refused, never dropped silently.
  const entryRefusal = () =>
    body.officerGuests
      ? NextResponse.json({ error: OFFICER_GUESTS_NEED_EXECUTION_MESSAGE }, { status: 400 })
      : body.officerPromo
        ? NextResponse.json({ error: OFFICER_PROMO_NEEDS_EXECUTION_MESSAGE }, { status: 400 })
        : null;
  if (body.status !== "APPROVED") {
    return entryRefusal();
  }
  const today = (await clubTime()).today();
  const finished = isFinishedStay(request.booking, dateOnlyInstantOf(today));
  if (body.execute === undefined) {
    return NextResponse.json({ error: EXECUTION_INTENT_MISSING_MESSAGE }, { status: 400 });
  }
  if (body.execute !== finished) {
    return NextResponse.json(
      {
        error: finished
          ? EXECUTION_INTENT_NOW_APPLIES_MESSAGE
          : EXECUTION_INTENT_NOW_ACKNOWLEDGES_MESSAGE,
        code: "EXECUTION_INTENT_MISMATCH",
        executesOnApproval: finished,
      },
      { status: 409 },
    );
  }
  if (!finished) {
    // Reached by an approval with `execute: false` on a stay still running —
    // an acknowledgement, which applies nothing. An entry sent with one is
    // refused here, never dropped silently (#4030 review C3).
    return entryRefusal();
  }
  if (body.linkedModificationId) {
    return NextResponse.json(
      {
        error:
          "This request is applied when it is approved, and links its own booking modification. Leave the modification id empty.",
      },
      { status: 400 },
    );
  }
  if (!body.expectedFigures) {
    return NextResponse.json(
      { error: EXPECTED_FIGURES_MISSING_MESSAGE, code: "EXPECTED_FIGURES_REQUIRED" },
      { status: 400 },
    );
  }
  return runFinishedStayApproval(req, {
    id: request.id,
    actorMemberId: args.actorMemberId,
    subjectMemberId: bookingOwner(request.booking).memberId,
    expectedVersion: body.expectedVersion ?? request.version,
    adminNotes: body.adminNotes?.trim() || null,
    internalNotes: body.internalNotes?.trim() || null,
    confirmOverCapacity: body.confirmOverCapacity === true,
    settlementMethod: body.settlementMethod,
    officerGuests: body.officerGuests,
    officerPromo: body.officerPromo,
    notifyMember: body.notifyMember,
    todayAtClub: today,
    mode: { expectedFigures: body.expectedFigures },
  });
}

/**
 * P2 on #3955: the figures approving would produce, computed by the same
 * executor in a transaction that is rolled back — so the quote and the approval
 * cannot disagree about the fee, the refund or the amount due.
 */
export async function finishedStayQuoteResponse(
  req: NextRequest,
  args: {
    requestId: string;
    body: z.infer<typeof finishedStayQuoteSchema>;
    actorMemberId: string;
  },
): Promise<NextResponse> {
  const request = await prisma.bookingChangeRequest.findUnique({
    where: { id: args.requestId },
    select: {
      id: true,
      kind: true,
      status: true,
      version: true,
      booking: { select: { memberId: true, checkOut: true, status: true } },
    },
  });
  if (!request || request.kind !== "LOCKED_PERIOD") {
    return NextResponse.json({ error: "Booking change request not found" }, { status: 404 });
  }
  if (request.status !== "REQUESTED") {
    return NextResponse.json(
      { error: "This booking change request has already been reviewed" },
      { status: 409 },
    );
  }
  const today = (await clubTime()).today();
  if (!isFinishedStay(request.booking, dateOnlyInstantOf(today))) {
    return NextResponse.json(
      { error: EXECUTION_INTENT_NOW_ACKNOWLEDGES_MESSAGE, code: "EXECUTION_INTENT_MISMATCH" },
      { status: 409 },
    );
  }
  return runFinishedStayApproval(req, {
    id: request.id,
    actorMemberId: args.actorMemberId,
    subjectMemberId: bookingOwner(request.booking).memberId,
    expectedVersion: request.version,
    adminNotes: null,
    internalNotes: null,
    confirmOverCapacity: args.body.confirmOverCapacity === true,
    settlementMethod: args.body.settlementMethod,
    officerGuests: args.body.officerGuests,
    officerPromo: args.body.officerPromo,
    notifyMember: undefined,
    todayAtClub: today,
    mode: { dryRun: true },
  });
}

/**
 * The canonical service's refusals, explained as they are on the member's own
 * edit route (`bookings/[id]/modify`), with the request kept pending. These are
 * decided refusals, not faults, so none is logged at error level. The D-8
 * probe throttle that route spends is a member-side mitigation; here the actor
 * is an officer deciding a request, exactly as on the policy-exception queue,
 * which maps these the same way without it.
 */
function finishedStayRefusalResponse(
  error: unknown,
  ctx: { id: string; actorMemberId: string; format: ClubFormat },
): NextResponse | null {
  const pending = (body: Record<string, unknown>, status: number) =>
    NextResponse.json({ id: ctx.id, status: "REQUESTED", keptPending: true, ...body }, { status });
  const hostingRetry = hostingCoverageParticipantRetryResponse(error, {
    id: ctx.id,
    status: "REQUESTED",
    keptPending: true,
  });
  if (hostingRetry) return hostingRetry;
  if (error instanceof FinishedStayFiguresChangedError) {
    // #4030 review C4: rolled back; the card clears its figures and re-checks.
    return pending({ error: error.message, code: error.code, figures: error.actual }, 409);
  }
  if (error instanceof OverCapacityConfirmationRequiredError) {
    // Decision 3: warn, and let the officer confirm. Nothing was written.
    return pending(
      {
        error:
          "Some of this stay's nights are over the lodge's capacity with these guests. Confirm the overbooking to approve and apply the change.",
        code: error.code,
        nightDetails: error.nightDetails,
        needsCapacityConfirmation: true,
      },
      409,
    );
  }
  if (error instanceof WholeLodgeHoldBlockedError) {
    return pending({ error: error.message, code: error.code, blockedNights: error.blockedNights }, 409);
  }
  if (error instanceof BookingModificationSettlementMethodRequiredError) {
    return pending(
      {
        error:
          "This change reduces the price, so choose whether the refund goes back the way it was paid or to account credit, then approve again.",
        needsSettlementMethod: true,
      },
      400,
    );
  }
  if (error instanceof BookingMemberNightConflictError) {
    return pending(getBookingMemberNightConflictResponse(error.conflicts, ctx.format), 409);
  }
  if (error instanceof OwnDependantIdentityRefusedError) {
    return pending(
      dependantIdentityRefusalBody(error.refusal, {
        onBehalf: dependantIdentitySpeaksOnBehalf({
          actorIsAdmin: true,
          actorId: ctx.actorMemberId,
          ownerMemberId: error.ownerMemberId,
        }),
        surface: "edit",
      }),
      error.refusal.status,
    );
  }
  if (error instanceof MembershipTypeBookingPolicyError) {
    return pending(getMembershipTypeBookingPolicyErrorBody(error), error.status);
  }
  if (error instanceof BookingGuestValidationError) {
    return pending(getBookingGuestValidationErrorResponse(error), error.status);
  }
  if (error instanceof ApiError) {
    if (error.message === NO_SEASON_RATE_MESSAGE) {
      return pending({ error: FINISHED_STAY_NO_SEASON_MESSAGE, code: "NO_ACTIVE_SEASON" }, 409);
    }
    const code = (error as { code?: unknown }).code;
    return pending(
      { error: error.message, ...(typeof code === "string" ? { code } : {}) },
      error.status,
    );
  }
  return null;
}

/** The approval's audit summary: what the officer entered, then what was done. */
function approvalAuditSummary(entry: { officerEnteredGuests: boolean; promoCodes: string[] | null }): string {
  const entered = [
    entry.officerEnteredGuests ? "Guests entered by the booking officer on the member's behalf" : null,
    // #4533: the promo code applied, named on the approval's own row.
    entry.promoCodes ? `Promo code ${entry.promoCodes.join(", ")} applied on the member's behalf` : null,
  ].filter((part): part is string => part !== null);
  return entered.length > 0
    ? `${entered.join("; ")}; booking change request approved and applied to the finished stay`
    : "Booking change request approved and applied to the finished stay";
}

/**
 * #3750: approve-and-execute on a finished stay, or its dry run. Every refusal
 * leaves the request REQUESTED at its old version — the executor's transaction
 * rolled the claim back with everything else — and says so.
 */
async function runFinishedStayApproval(
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
    officerGuests: OfficerEnteredGuest[] | undefined;
    officerPromo: ChangeRequestPromoChange | undefined;
    notifyMember: boolean | undefined;
    todayAtClub: CalendarDate;
    /** A dry run, or an approval carrying the figures the officer was shown. */
    mode: FinishedStayApprovalMode;
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
      ...(args.officerGuests ? { officerEnteredGuests: args.officerGuests } : {}),
      ...(args.officerPromo ? { officerPromoChange: args.officerPromo } : {}),
      ...(args.notifyMember === false ? { notifyMember: false } : {}),
      todayAtClub: args.todayAtClub,
      format,
      preTransaction,
      ipAddress,
      ...args.mode,
    });
  } catch (error) {
    const refusal = finishedStayRefusalResponse(error, {
      id,
      actorMemberId: args.actorMemberId,
      format,
    });
    if (refusal) return refusal;
    logger.error({ err: error, requestId: id }, "Locked-period change request execution failed");
    return NextResponse.json(
      {
        id,
        status: "REQUESTED",
        keptPending: true,
        error: "The approval could not be completed. The request is still pending.",
      },
      { status: 500 },
    );
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
      return NextResponse.json(
        { id, status: "REQUESTED", keptPending: true, error: result.message },
        { status: 409 },
      );
    case "quoted":
      return NextResponse.json({
        id,
        quote: {
          priceDiffCents: result.priceDiffCents,
          changeFeeCents: result.changeFeeCents,
          additionalAmountCents: result.additionalAmountCents,
          refundAmountCents: result.refundAmountCents,
          accountCreditAmountCents: result.accountCreditAmountCents,
          capacityOverridden: result.capacityOverridden,
          settlementMethod: result.settlementMethod,
        },
      });
    case "executed":
      break;
  }

  // #4030 Part B: the officer's entry, named on the approval's own row — the
  // officer is the row's actor, and the guests they entered are listed.
  const officerEntered = result.officerEnteredGuests;
  const promoChange = result.promoChange;
  logAudit({
    action: "booking-change-request.approve",
    memberId: args.actorMemberId,
    targetId: result.bookingId,
    subjectMemberId: args.subjectMemberId,
    entityType: "BookingChangeRequest",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary: approvalAuditSummary({
      officerEnteredGuests: Boolean(officerEntered),
      promoCodes: promoChange?.codes ?? null,
    }),
    details: args.adminNotes,
    // `INV-PRIV-018`: exactly what the acknowledgement path discloses — the
    // member-facing explanation, which the member reads on their booking page —
    // and nothing of the internal note.
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
      settlementMethod: result.settlementMethod,
      // Both, as the #1668 override records them.
      confirmOverCapacity: args.confirmOverCapacity,
      capacityOverridden: result.capacityOverridden,
      followUpFailed: result.followUpFailed === true,
      internalNoteRecorded: Boolean(args.internalNotes),
      officerEnteredGuests: officerEntered
        ? {
            onMemberBehalf: true,
            enteredByMemberId: args.actorMemberId,
            guests: officerEntered.map((guest) => ({
              firstName: guest.firstName,
              lastName: guest.lastName,
              ageTier: guest.ageTier,
              isMember: guest.isMember,
              memberId: guest.isMember ? guest.memberId ?? null : null,
              stayStart: guest.stayStart,
              stayEnd: guest.stayEnd,
            })),
          }
        : null,
      // #4533: the promo change applied, who entered it and where, and the
      // officer's email choice — joined to the modification above.
      promoChange: promoChange
        ? {
            codes: promoChange.codes,
            onMemberBehalf: true,
            enteredByMemberId: promoChange.enteredBy.officerMemberId,
            enteredOn: promoChange.enteredBy.enteredOn,
          }
        : null,
      notifyMember: result.notifyMember,
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
      settlementMethod: result.settlementMethod,
      capacityOverridden: result.capacityOverridden,
      officerEnteredGuestCount: officerEntered?.length ?? 0,
      promoCodesApplied: promoChange?.codes ?? [],
      memberEmailWithheld: !result.notifyMember,
      followUpFailed: result.followUpFailed === true,
    },
  });
}
