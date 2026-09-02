import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";

import { AdultMemberHostingRequiredError, buildAdultMemberHostingRefusalBody } from "@/lib/adult-member-hosting-refusal";
import {
  SameOwnerCoverageOverrideRequiredError,
  SameOwnerCoverageWouldBreakError,
  buildSameOwnerCoverageOverrideRequiredBody,
  buildSameOwnerCoverageRefusalBody,
  hostingCoverageOverrideSchema,
} from "@/lib/adult-member-hosting-same-owner";
import {
  SameOwnerCoverageLinkedMoveRequiredError,
  buildSameOwnerCoverageLinkedMoveBody,
  hostingCoverageLinkedMoveSchema,
} from "@/lib/adult-member-hosting-linked-move";
import { modifyBookingDatesWithLinkedMoveSupport } from "@/lib/booking-linked-date-move-service";
import { ApiError } from "@/lib/api-error";
import { MinimumStayPolicyViolationError } from "@/lib/booking-policy-exceptions";
import { auth } from "@/lib/auth";
import { clubTime } from "@/lib/club-time/server";
import { adminShiftBookingDates } from "@/lib/booking-date-modification-service";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
import {
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
} from "@/lib/booking-guests";
import {
  handleMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import { isBookingEnvelopeInvariantViolation } from "@/lib/booking-envelope-invariants";
import logger from "@/lib/logger";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import { getXeroLockGuardErrorResponse } from "@/lib/xero-period-lock-guard";

const modifyDatesSchema = z
  .object({
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    settlementMethod: z.enum(["card", "credit"]).optional(),
    // Admin-only date override (issue #1668).
    adminOverride: z.boolean().optional(),
    pricingMode: z.enum(["shift", "recalculate"]).optional(),
    confirmOverCapacity: z.boolean().optional(),
    notifyMember: z.boolean().optional(),
    // #2576 §7: the officer's explicit confirmation and mandatory reason for
    // overriding a same-owner coverage refusal. Optional in the shape because the
    // first submission never carries it — the officer is asked only when the change
    // would actually strand another booking on the account.
    hostingCoverageOverride: hostingCoverageOverrideSchema.optional(),
    // #3232: the MEMBER's answer to the linked-move offer. Absent on a first
    // submission, which is the normal case — the question is only asked when the
    // move would actually strand another booking on their own account.
    //
    // DELIBERATELY NOT one of the admin-gated flags below. Every other optional
    // field on this schema raises the caller to the booking-management role and
    // 403s a member who sends it, because every other one is an officer's
    // authority over somebody else's booking. This is the owner deciding about
    // their own two bookings, so gating it on ADMIN would 403 the only person
    // entitled to answer it.
    hostingCoverageLinkedMove: hostingCoverageLinkedMoveSchema.optional(),
  })
  .refine((d) => d.checkIn || d.checkOut, {
    message: "At least one of checkIn or checkOut is required",
  });

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // MG3 (#2308) C1: a date change on a booking that already carries a
  // cross-family member guest can now produce D-8's neutral refusal, so this
  // route needs the refusal clock the timing floor is measured from. Monotonic,
  // never the wall clock — see `startMemberGuestRefusalClock`, and note that the
  // contract test forbidding a wall-clock read in this file greps the source
  // including its comments.
  const startedAt = startMemberGuestRefusalClock();

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON",
        details: { body: ["Request body must be valid JSON"] },
      },
      { status: 400 },
    );
  }

  const parsed = modifyDatesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  // Issue #1668: admin-only date override gating. The booking-management role
  // (Booking Officer / Full Admin → ADMIN) applies ONLY when the override is
  // actually active (adminOverride === true); every other request — including
  // an explicit adminOverride: false — keeps the legacy access-role mapping, so
  // a caller-controlled boolean can never flip the standard path's authority.
  const { adminOverride, pricingMode, confirmOverCapacity, notifyMember } =
    parsed.data;
  const hasOverrideFlags =
    adminOverride !== undefined ||
    pricingMode !== undefined ||
    confirmOverCapacity !== undefined ||
    notifyMember !== undefined ||
    parsed.data.hostingCoverageOverride !== undefined;
  if (
    hasOverrideFlags &&
    bookingManagementAuthorizationRole(session.user) !== "ADMIN"
  ) {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 },
    );
  }
  // Issue #1696: a plain admin edit may now carry notifyMember alone, so the
  // booking-management role (→ ADMIN) is also resolved when notifyMember is
  // present — otherwise a Booking Officer's legacy mapping (USER) would make the
  // service always notify. An explicit adminOverride: false with no notify choice
  // still keeps the legacy mapping: a caller boolean cannot flip the standard
  // path's authority (the 403 gate above already required ADMIN for any flag).
  const actorRole =
    adminOverride === true ||
    notifyMember !== undefined ||
    parsed.data.hostingCoverageOverride !== undefined
      ? bookingManagementAuthorizationRole(session.user)
      : authorizationRoleFromAccessRoles(session.user);
  if (adminOverride && !pricingMode) {
    return NextResponse.json(
      { error: "Choose a pricing mode for the admin override" },
      { status: 400 },
    );
  }
  if (
    !adminOverride &&
    (pricingMode !== undefined || confirmOverCapacity !== undefined)
  ) {
    return NextResponse.json(
      {
        error: "adminOverride is required for pricingMode/confirmOverCapacity",
      },
      { status: 400 },
    );
  }

  // #3123 / #3232 — the CLUB's day, from its persisted `ClubTimeSettings.timeZone`
  // (`INV-CONFIG-002`), resolved HERE because this is the last position on this
  // path that is outside every transaction on every route in. It reached this route
  // with the linked move (#3232): accepting the offer moves two bookings in ONE
  // transaction through the transaction-AWARE batch service, which cannot resolve a
  // day for itself without reading the club's zone under the global money key and
  // the lodge capacity key — `INV-LOCK-004`, the same reason its `todayAtClub` is a
  // required parameter on the `/modify` door.
  const todayAtClub = (await clubTime()).today();

  try {
    const result =
      adminOverride && pricingMode === "shift"
        ? await adminShiftBookingDates({
            bookingId,
            actor: { id: session.user.id, role: actorRole },
            ...(parsed.data.hostingCoverageOverride
              ? { hostingCoverageOverride: parsed.data.hostingCoverageOverride }
              : {}),
            input: {
              checkIn: parsed.data.checkIn,
              checkOut: parsed.data.checkOut,
              confirmOverCapacity,
              notifyMember,
            },
            ipAddress,
          })
        : await modifyBookingDatesWithLinkedMoveSupport({
            bookingId,
            actor: { id: session.user.id, role: actorRole },
            ...(parsed.data.hostingCoverageOverride
              ? { hostingCoverageOverride: parsed.data.hostingCoverageOverride }
              : {}),
            ...(parsed.data.hostingCoverageLinkedMove
              ? { linkedMove: parsed.data.hostingCoverageLinkedMove }
              : {}),
            input: parsed.data,
            ipAddress,
            todayAtClub,
          });

    return NextResponse.json(result);
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    if (err instanceof OverCapacityConfirmationRequiredError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          nightDetails: err.nightDetails,
        },
        { status: err.status },
      );
    }
    if (err instanceof MembershipTypeBookingPolicyError) {
      // Finding 2 (privacy re-review of MG3 #2308). The membership-type refusal
      // is D-8's FOURTH collapsing refusal, so when it collapsed it owes the
      // same three mitigations as its siblings — the throttle unit, the audit
      // row naming actor and target, and the timing floor. A no-op for every
      // other membership-type block: the handler returns immediately unless the
      // error carries `crossFamilyMemberIds`, which only a collapsed one does.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: err,
        route: "bookings/modify-dates",
        startedAt,
        throttle: "CHARGE_NOW",
        skipAuthorization: actorRole === "ADMIN",
      });
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingGuestValidationError) {
      // MG3 (#2308) C1 + #2388. Re-dating a booking that already carries a
      // cross-family member guest now refuses NEUTRALLY rather than returning
      // that member's booked nights, so this route became a refusal surface and
      // owes the same three mitigations as every other add path: the throttle is
      // spent, the refusal is audited against the actor and the target, and the
      // response is held to the timing floor. Without this branch the neutral
      // refusal would have fallen through to the generic 500.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: err,
        route: "bookings/modify-dates",
        startedAt,
        throttle: "CHARGE_NOW",
        skipAuthorization: actorRole === "ADMIN",
      });
      return NextResponse.json(getBookingGuestValidationErrorResponse(err), {
        status: err.status,
      });
    }
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    // Xero lock-date guard (#1697): keep the machine-readable code + lockDate
    // (both errors extend ApiError, so this branch must come first).
    const xeroLockGuardResponse = getXeroLockGuardErrorResponse(err);
    if (xeroLockGuardResponse) {
      return NextResponse.json(xeroLockGuardResponse.body, {
        status: xeroLockGuardResponse.status,
      });
    }
    if (err instanceof MinimumStayPolicyViolationError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          details: err.details,
          violations: err.violations,
          exceptionReview: err.exceptionReview,
        },
        { status: err.status },
      );
    }
    // #2569 — the ENFORCED hosting refusal on the DATE path. Tested BEFORE the
    // generic ApiError branch for the reason the minimum-stay branch above is:
    // `AdultMemberHostingRequiredError` extends ApiError, so the generic branch
    // would flatten it to a bare 409 sentence and drop the code, the frozen
    // violation and the path to ask a Booking Officer — leaving the member refused
    // with no door. Moving dates is one of the ways a covered booking becomes
    // uncovered (the adult member's own stay no longer spans the new nights), so
    // this path refuses as often as the guest paths do. Host identities are
    // withheld from this body (#2569 §5).
    if (err instanceof AdultMemberHostingRequiredError) {
      return NextResponse.json(
        buildAdultMemberHostingRefusalBody(err.violation),
        { status: err.status },
      );
    }
    // #2576 §6, and ABOVE the generic ApiError branch below for the same reason
    // as its neighbour: a date change that would leave another booking on the
    // member's own account without adult-member cover is refused, and the body is
    // what names the affected booking, its lodge and the uncovered nights.
    // #3232 D1, ABOVE its bare-refusal sibling and for the same positional reason
    // every branch on this handler is ordered: both extend ApiError. Moving this
    // booking would strand another of the member's own bookings that they cannot
    // move themselves — the same rule refuses THAT edit from the other end — so
    // they are OFFERED the linked move rather than refused: both together on one
    // combined figure, or this one alone with the other left uncovered and a
    // Booking Officer told. The bare refusal below is still right for a stranding
    // the member CAN fix on the affected booking.
    if (err instanceof SameOwnerCoverageLinkedMoveRequiredError) {
      return NextResponse.json(buildSameOwnerCoverageLinkedMoveBody(err), {
        status: err.status,
      });
    }
    if (err instanceof SameOwnerCoverageWouldBreakError) {
      return NextResponse.json(buildSameOwnerCoverageRefusalBody(err), {
        status: err.status,
      });
    }
    // #2576 §7. The officer is not refused: they are shown which bookings and
    // nights the change would strand and asked to confirm it with a reason.
    if (err instanceof SameOwnerCoverageOverrideRequiredError) {
      return NextResponse.json(
        buildSameOwnerCoverageOverrideRequiredBody(err),
        { status: err.status },
      );
    }
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (isBookingEnvelopeInvariantViolation(err)) {
      // A write-path bug produced a guest stay range outside the booking
      // envelope; the deferred DB triggers caught it and rolled back.
      logger.error(
        { err, bookingId },
        "Booking envelope invariant violated during date modification — write-path bug",
      );
      return NextResponse.json(
        {
          error:
            "The booking update failed an internal consistency check and no changes were saved. Please report this to an administrator.",
        },
        { status: 500 },
      );
    }
    // #1888 — unexpected (non-typed) errors must not leak their message to
    // the client; the raw error stays in the log only.
    logger.error({ err, bookingId }, "Booking date modification failed");
    return NextResponse.json(
      { error: "Failed to modify booking dates" },
      { status: 400 }
    );
  }
}
