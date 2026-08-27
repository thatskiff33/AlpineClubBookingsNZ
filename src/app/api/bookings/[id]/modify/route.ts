import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { z } from "zod";

import {
  AdultMemberHostingRequiredError,
  buildAdultMemberHostingRefusalBody,
} from "@/lib/adult-member-hosting-review";
import {
  SameOwnerCoverageOverrideRequiredError,
  SameOwnerCoverageWouldBreakError,
  buildSameOwnerCoverageOverrideRequiredBody,
  buildSameOwnerCoverageRefusalBody,
  hostingCoverageOverrideSchema,
} from "@/lib/adult-member-hosting-same-owner";
import { ApiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import {
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
} from "@/lib/booking-guests";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import {
  handleMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { clubTime } from "@/lib/club-time/server";
import { adminShiftBookingDates } from "@/lib/booking-date-modification-service";
import { BookingModifyReviewJustificationRequiredError } from "@/lib/booking-modify-validation";
import { MinimumStayPolicyViolationError } from "@/lib/booking-policy-exceptions";
import {
  buildPaidUpAdultRefusalBody,
  PaidUpAdultMemberRequiredError,
} from "@/lib/subscription-lockout-enforcement";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
import { isBookingEnvelopeInvariantViolation } from "@/lib/booking-envelope-invariants";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { nameField } from "@/lib/zod-helpers";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import { getXeroLockGuardErrorResponse } from "@/lib/xero-period-lock-guard";

const batchModifySchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: z.array(z.string()).max(370).optional(),
      }),
    )
    .optional(),
  removeGuestIds: z.array(z.string()).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().min(1),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: z.array(z.string()).max(370).optional(),
      }),
    )
    .optional(),
  guestUpdates: z
    .array(
      z.object({
        guestId: z.string().min(1),
        firstName: nameField(),
        lastName: nameField(),
      }),
    )
    .optional(),
  // #2337: link a placeholder guest to a member (admin-only, member whole-lodge
  // only — enforced in the service by `resolveGuestMemberLinks` and the
  // member-origin check). Re-rates the linked row at the member rate in place.
  linkGuestToMember: z
    .array(
      z.object({
        guestId: z.string().min(1),
        memberId: z.string().min(1),
      }),
    )
    .max(60)
    .optional(),
  // Other Lodges epic: the reciprocal other-club rate election. Admin-only and
  // gated in the service by `resolveOtherLodgeRateElection`; both fields are an
  // END STATE for the whole booking, never a delta.
  otherLodgeId: z.string().min(1).nullable().optional(),
  otherLodgeMemberGuestIds: z.array(z.string().min(1)).max(200).optional(),
  promoCode: z.string().optional(),
  // #2266 (MED-4): guest-targeted promo beneficiaries. Existing guests bind by
  // bookingGuestId (stale ids refuse loudly); positional indexes exist only
  // for TO-BE-ADDED guests within this same request, relative to addGuests.
  promoGuestIds: z.array(z.string().min(1)).max(200).optional(),
  promoAddedGuestIndexes: z.array(z.number().int().min(0)).max(200).optional(),
  removePromoCode: z.boolean().optional(),
  // #2266: credit election on the edit path — stored on the booking (#2265),
  // never applied here. Bounds mirror the create route's applyCreditCents.
  applyCreditCents: z.number().int().min(0).max(100_000_000).optional(),
  memberReviewJustification: z.string().trim().min(1).max(1000).optional(),
  settlementMethod: z.enum(["card", "credit"]).optional(),
  // Admin-only date override (issue #1668).
  adminOverride: z.boolean().optional(),
  pricingMode: z.enum(["shift", "recalculate"]).optional(),
  confirmOverCapacity: z.boolean().optional(),
  notifyMember: z.boolean().optional(),
  // Admin-only (#1746): flag proposed member guests as partner-sharers so
  // capacity runs through the #1745 reserved double-bed slots.
  partnerSharedGuests: z
    .array(
      z.object({
        memberId: z.string().min(1),
        partnerMemberId: z.string().min(1),
      }),
    )
    .max(10)
    .optional(),
  // #2576 §7: the officer's explicit confirmation and mandatory reason for
  // overriding a same-owner coverage refusal. Optional in the shape because the
  // first submission never carries it — the officer is asked only when the change
  // would actually strand another booking on the account.
  hostingCoverageOverride: hostingCoverageOverrideSchema.optional(),
});

const OVERRIDE_DATE_ONLY_FIELDS = [
  "addGuests",
  "removeGuestIds",
  "guestStayRanges",
  "guestUpdates",
  // #2337: a placeholder→member link is a guest change, never a date override.
  "linkGuestToMember",
  // The other-lodge rate election re-rates guests, so it is a guest change too.
  "otherLodgeId",
  "otherLodgeMemberGuestIds",
  "promoCode",
  "promoGuestIds",
  "promoAddedGuestIndexes",
  "removePromoCode",
  // #1746: partner-shared flags ride guest changes, never a date override.
  "partnerSharedGuests",
] as const;

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // #2388 / MG3 (#2308). This route is a member-facing member-guest ADD path —
  // `addGuests` is in its schema above and any authenticated member reaches it —
  // so it owes the same three mitigations as the quote and guest-add routes: the
  // refusal is throttled, audited, and held to the timing floor. It carried none
  // of them until the privacy review found it (H2).
  //
  // It reads a MONOTONIC clock, never the wall clock:
  // `review-findings-contracts.test.ts` forbids a wall-clock read in this file
  // outright — as a blunt source grep, comments included, which is exactly how
  // this comment first failed it — because a booking-modification idempotency key
  // built from one would mint a fresh Stripe key on every retry. See the note on
  // `startMemberGuestRefusalClock`.
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

  const parsed = batchModifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN
  // so they receive the SAME admin-on-behalf modify authority as a Full Admin.
  const actorRole = bookingManagementAuthorizationRole(session.user);

  // Issue #1668: admin-only date override gating.
  const { adminOverride, pricingMode, confirmOverCapacity, notifyMember } =
    parsed.data;
  const hasOverrideFlags =
    adminOverride !== undefined ||
    pricingMode !== undefined ||
    confirmOverCapacity !== undefined ||
    notifyMember !== undefined;
  if (hasOverrideFlags && actorRole !== "ADMIN") {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 },
    );
  }
  // #1746: partner-shared placement is admin-initiated by owner decision.
  if (parsed.data.partnerSharedGuests?.length && actorRole !== "ADMIN") {
    return NextResponse.json(
      { error: "Partner-shared placement is not available for this account" },
      { status: 403 },
    );
  }
  if (adminOverride && !pricingMode) {
    return NextResponse.json(
      { error: "Choose a pricing mode for the admin override" },
      { status: 400 },
    );
  }
  // Issue #1696: an admin may now suppress the member-facing modified email on
  // ANY edit, so notifyMember is allowed alone (without adminOverride). The
  // pricing/capacity override flags still require adminOverride. actorRole is
  // already the booking-management role (ADMIN for Full Admin / Booking Officer),
  // so the service honours the admin's choice on every edit.
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
  if (
    adminOverride &&
    (OVERRIDE_DATE_ONLY_FIELDS.some((field) => {
      const value = parsed.data[field];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    }) ||
      // #2266: checked explicitly — `Boolean(0)` is false, so a credit
      // election of 0 cents would otherwise slip past the date-only contract.
      parsed.data.applyCreditCents !== undefined ||
      // Same trap, same fix: `otherLodgeId: null` CLEARS the election and is
      // falsy, so the list membership above would let it through a date-only
      // override.
      parsed.data.otherLodgeId !== undefined)
  ) {
    return NextResponse.json(
      { error: "Admin override edits change dates only" },
      { status: 400 },
    );
  }

  // #3123 — the CLUB's day, from its persisted `ClubTimeSettings.timeZone`
  // (`INV-CONFIG-002`), resolved HERE because this is the last position on this
  // path that is outside every transaction on every route in. `modifyBookingBatch`
  // is transaction-AWARE (`withOptionalTransaction`), so it cannot resolve one
  // for itself without reading the club's zone under the caller's locks on the
  // policy-exception path — `INV-LOCK-004`, and the reason its `todayAtClub` is
  // a required parameter.
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
        : await modifyBookingBatch({
            bookingId,
            actor: { id: session.user.id, role: actorRole },
            ...(parsed.data.hostingCoverageOverride
              ? { hostingCoverageOverride: parsed.data.hostingCoverageOverride }
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
        route: "bookings/modify",
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
      // #2388, refusal path only — the same shape `api/bookings/[id]/guests`
      // uses, and for the same reason: this route resolves its members INSIDE
      // `prisma.$transaction` while holding the per-lodge capacity lock, so the
      // throttle cannot be spent on the way in without taking a second
      // connection under that lock. Spending it here still counts every probe,
      // and the channel #2388 describes is built out of refusals. A SUCCESSFUL
      // cross-family add on this route is not a probe: it mutates a real booking
      // and emails the person it added.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: err,
        route: "bookings/modify",
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
    // #2104: a member modification tripped the no-adult review rule for the
    // first time without a justification. Echo the machine-readable code (before
    // the generic ApiError branch — this error extends ApiError) so the edit
    // panel can reveal the required justification field even when its local
    // predicate missed the trip.
    if (err instanceof BookingModifyReviewJustificationRequiredError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
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
    // #2363: the minimum-stay block on this save path carries the frozen review
    // snapshot (policy id/version/scope/nights/requirements/capacity mode) so
    // the edit panel can tell the member exactly which rule stopped the change.
    // MUST stay above the generic ApiError branch — this error extends ApiError,
    // and the generic branch would drop the code and the snapshot.
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
    // #2543 — the paid-up-adult refusal on the SAVE path. Above the generic
    // ApiError branch for exactly the reason the minimum-stay one is: it extends
    // ApiError, and the generic branch would strip the code, the frozen
    // violation, the HOLD promise and the path to ask a Booking Officer, leaving
    // the member with a bare 409 and no way to act on it.
    if (err instanceof PaidUpAdultMemberRequiredError) {
      return NextResponse.json(buildPaidUpAdultRefusalBody(err.violation), {
        status: err.status,
      });
    }
    // #2569 — same reason, same order: `AdultMemberHostingRequiredError` extends
    // ApiError, so it must be tested BEFORE the generic branch or the ENFORCED
    // hosting refusal is flattened to a bare sentence and the member loses the
    // exception door. Host identities are withheld from this body (#2569 §5).
    if (err instanceof AdultMemberHostingRequiredError) {
      return NextResponse.json(
        buildAdultMemberHostingRefusalBody(err.violation),
        { status: err.status },
      );
    }
    // #2576 §6, and ABOVE the generic ApiError branch below for the same reason
    // as its neighbour: a batch edit that would leave another booking on the
    // member's own account without adult-member cover is refused, and the body is
    // what names the affected booking, its lodge and the uncovered nights.
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
        "Booking envelope invariant violated during batch modify — write-path bug",
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
    logger.error({ err, bookingId }, "Batch modify failed");
    return NextResponse.json(
      { error: "Failed to modify booking" },
      { status: 400 }
    );
  }
}
