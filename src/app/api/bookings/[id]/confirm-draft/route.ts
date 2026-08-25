import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { auth } from "@/lib/auth";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { sendBookingConfirmedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  handleMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import {
  assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  requiresPaidSubscriptionForMemberForBooking,
} from "@/lib/membership-type-policy";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import {
  buildPaidUpAdultRefusalBody,
  evaluateNonMemberPricingRequirements,
  toSubscriptionLockoutParticipants,
} from "@/lib/subscription-lockout-enforcement";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import { hasAdminAccess } from "@/lib/access-roles";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  AdultMemberHostingRequiredError,
  buildAdultMemberHostingRefusalBody,
  hostingCoverageActorOptions,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import {
  SameOwnerCoverageOverrideRequiredError,
  SameOwnerCoverageWouldBreakError,
  buildSameOwnerCoverageOverrideRequiredBody,
  buildSameOwnerCoverageRefusalBody,
  readHostingCoverageOverride,
} from "@/lib/adult-member-hosting-same-owner";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const isAdmin = hasAdminAccess(session.user);
  // Finding 2 (privacy re-review of MG3 #2308): confirming a draft re-checks the
  // booking's STORED guests, which can raise the collapsed refusal about a
  // cross-family member guest added weeks ago.
  const memberGuestRefusalStartedAt = startMemberGuestRefusalClock();

  const { id } = await params;

  // #2576 §7. The only field this route reads off the body: an officer's explicit
  // confirmation and reason for overriding a same-owner coverage refusal. Absent on
  // every ordinary confirmation, and an unparseable body is simply "no override"
  // rather than a 400 — this endpoint took no body at all before.
  const hostingOverride = readHostingCoverageOverride(
    await request.json().catch(() => null),
  );

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: { guests: true, member: true, promoRedemption: { include: { promoCode: true } } },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (booking.status !== BookingStatus.DRAFT) {
    return NextResponse.json({ error: "Booking is not a draft" }, { status: 400 });
  }

  // Defence in depth (#2266): a booking with an unresolved admin review must
  // never confirm. The writers enforce this by parking review-flagged drafts
  // to AWAITING_REVIEW (booking-create and the modify path alike), so a
  // review-flagged DRAFT should not exist — but the invariant is a
  // child-safety gate, so this door checks it too rather than trusting every
  // writer forever. Fail closed on any non-APPROVED review state.
  if (booking.requiresAdminReview && booking.adminReviewStatus !== "APPROVED") {
    return NextResponse.json(
      { error: "This booking needs admin review before it can be confirmed" },
      { status: 409 }
    );
  }

  if (booking.finalPriceCents !== 0) {
    return NextResponse.json(
      { error: "Use the payment flow to complete non-zero bookings" },
      { status: 400 }
    );
  }

  const seasonYear = seasonYearOfStoredDate(new Date(booking.checkIn));
  try {
    await assertMembershipTypeBookingAllowed(prisma, {
      ownerMemberId: booking.memberId,
      guests: booking.guests,
      seasonYear,
      // Finding 2 (privacy re-review of MG3 #2308). These are the booking's
      // STORED guests, which carry no add-time marker at all, so the collapse
      // here rests entirely on the live-boundary backstop inside
      // `getMembershipTypeBookingPolicyBlocks`.
      skipAuthorization: isAdmin,
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      // Finding 2 (privacy re-review of MG3 #2308). This route is a member-facing
      // surface that can now answer D-8's collapsed refusal, so it owes the same
      // three mitigations as the six add paths: the throttle unit, the audit row
      // naming actor and target, and the timing floor. Collapsed-but-uncounted is
      // the exact gap finding H2 closed on `bookings/modify`. A no-op for every
      // other membership-type block.
      await handleMemberGuestAddRefusal({
        request,
        actorMemberId: session.user.id,
        error: err,
        route: "bookings/confirm-draft",
        startedAt: memberGuestRefusalStartedAt,
        throttle: "CHARGE_NOW",
        skipAuthorization: isAdmin,
      });
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    throw err;
  }

  // #2543 — the club's three-way subscription-lockout policy, resolved once so
  // the refusal below and the paid-up-adult requirement after it agree.
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();

  // Subscription check (non-admins only; bypassed when the Xero module is
  // effectively off, because subscriptions are invoiced through Xero, and under
  // NON_MEMBER_PRICING, where the unpaid member confirms and is repriced)
  if (
    subscriptionLockoutMode === "HARD_BLOCK" &&
    !isAdmin &&
    await requiresPaidSubscriptionForMemberForBooking(prisma, {
      memberId: booking.memberId,
      seasonYear,
      ageTier: booking.member.ageTier,
    })
  ) {
    const paidSub = await prisma.memberSubscription.findFirst({
      where: { memberId: booking.memberId, seasonYear, status: "PAID" },
    });
    if (!paidSub) {
      const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;
      return NextResponse.json(
        {
          error: `Your membership subscription for the ${seasonDisplay} season is not paid. Please contact the club to arrange payment before booking.`,
        },
        { status: 403 }
      );
    }
  }

  // #2543 — the paid-up-adult requirement, on the same terms as the create path:
  // non-admins only, refused with the exception-eligible violation so the member
  // can ask a Booking Officer, and a no-op unless the club chose
  // NON_MEMBER_PRICING. Confirming a draft is a booking write like any other, so
  // a draft saved before the club switched policy is judged by today's rule.
  if (!isAdmin) {
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(prisma, {
      mode: subscriptionLockoutMode,
      lodgeId: booking.lodgeId ?? (await getDefaultLodgeId(prisma)),
      seasonYear,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      // Owner decision, 3 Aug 2026: the requirement follows an unfinancial member
      // whether or not they hold a bed on their own draft. The HARD_BLOCK gate
      // directly above refuses this same person as a person.
      bookingOwnerMemberId: booking.memberId,
      participants: toSubscriptionLockoutParticipants(booking.guests),
    });
    if (nonMemberPricing?.violation) {
      return NextResponse.json(
        buildPaidUpAdultRefusalBody(nonMemberPricing.violation),
        { status: 409 },
      );
    }
  }

  // Check capacity + transition to PAID in transaction
  try {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    // Lock the booking's lodge before re-reading it: the draft's lodge cannot
    // change, so the pre-read outside the lock is safe for key selection.
    const lockTarget = await tx.booking.findUnique({
      where: { id },
      select: { lodgeId: true },
    });
    const bookingLodgeId =
      lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    const freshBooking = await tx.booking.findUnique({
      where: { id },
      include: { guests: { include: { nights: true } } }, // per-night sets (issue #713)
    });

    if (!freshBooking || freshBooking.status !== BookingStatus.DRAFT) {
      throw new Error("Booking is no longer a draft");
    }

    // Re-assert the review gate under the lock (#2266): a concurrent edit
    // could have flagged the draft between the outer read and this claim.
    if (
      freshBooking.requiresAdminReview &&
      freshBooking.adminReviewStatus !== "APPROVED"
    ) {
      throw new Error(
        "This booking needs admin review before it can be confirmed"
      );
    }

    const capacity = await checkCapacityForGuestRanges(
      bookingLodgeId,
      freshBooking.checkIn,
      freshBooking.checkOut,
      freshBooking.guests,
      id,
      tx,
    );
    // DRAFT-scoped exemption (#1771): confirming a DRAFT, which can never carry
    // a persisted capacity override (#1767 blocks save-as-draft over capacity),
    // so bookingHasCapacityOverride would always be false — honouring it would
    // be dead code. See docs/CAPACITY_MODEL.md.
    if (!capacity.available) {
      throw new Error("Not enough beds available for your dates.");
    }

    await tx.payment.create({
      data: {
        bookingId: id,
        amountCents: 0,
        status: "SUCCEEDED",
      },
    });

    await tx.booking.update({
      where: { id },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
        // #2265 — this route only ever confirms a $0 booking, so there is
        // nothing for account credit to pay and the member's balance is
        // deliberately left untouched. Clear any stored election so it cannot
        // linger on a settled booking; no credit was consumed, so nothing is
        // lost by dropping it.
        creditElectionCents: null,
      },
    });
    await reconcileBedAllocationsForBookingWithGlobalLockHeld({
      bookingId: id,
      db: tx,
      previousRange: {
        checkIn: freshBooking.checkIn,
        checkOut: freshBooking.checkOut,
      },
    });

    // #2576 §9. CONFIRMING A DRAFT IS A CONFIRMATION, and the owner's decision
    // names it: every route that can confirm must run the shared hosting evaluator
    // immediately before confirmation and re-read current authoritative data,
    // never a quote-time or earlier result. This route already re-runs the
    // minimum-stay check and the #2543 paid-up-adult check on today's facts; the
    // hosting rule was the one it did not.
    //
    // THE GAP WAS DETERMINISTIC RATHER THAN A RACE, and it was the widest one in
    // the design. A DRAFT is outside `ACTIVE_BOOKING_STATUSES`, so it is invisible
    // to `sameOwnerCoverageDependentWhere`: a member could create the draft while
    // another booking supplied cover, cancel that booking (nothing stranded,
    // nothing queued, cancellation allowed), and then confirm here — landing a PAID
    // booking with uncovered non-member guest-nights at an enforcing lodge.
    //
    // REFUSES rather than escalates, and that is right for this route specifically:
    // no money has moved (it only ever confirms a $0 booking), the member is the
    // actor, and the throw rolls the whole claim back — the status flip, the $0
    // payment and the bed allocations — leaving the draft exactly as it was so they
    // can fix the party or ask an officer.
    await reconcileAdultMemberHostingReviewWithSiblings(id, tx, {
      ...hostingCoverageActorOptions({
        actorRole: session.user.role,
        hasBookingsEditAccess: isAdmin,
        actorMemberId: session.user.id,
        ...(hostingOverride ? { override: hostingOverride } : {}),
      }),
    });
  });
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    // #2576 §6/§7/§9, and #2569's own refusal. All three are `ApiError`s thrown
    // from inside the transaction, so the draft is untouched by the time they reach
    // here; each gets the body its own audience needs.
    if (err instanceof AdultMemberHostingRequiredError) {
      return NextResponse.json(buildAdultMemberHostingRefusalBody(err.violation), {
        status: 409,
      });
    }
    if (err instanceof SameOwnerCoverageWouldBreakError) {
      return NextResponse.json(buildSameOwnerCoverageRefusalBody(err), {
        status: 409,
      });
    }
    if (err instanceof SameOwnerCoverageOverrideRequiredError) {
      return NextResponse.json(
        buildSameOwnerCoverageOverrideRequiredBody(err),
        { status: 409 },
      );
    }
    throw err;
  }

  // #2576 §7/§9: drain what the confirmation queued, now that it has committed.
  await settleHostingCoverageAfterCommit({ bookingId: id });

  // Fire-and-forget: confirmation email + Xero invoice
  sendBookingConfirmedEmail(
    { bookingId: booking.id, recipientMemberId: booking.memberId },
    booking.member.email,
    booking.member.firstName,
    booking.checkIn,
    booking.checkOut,
    booking.guests.length,
    0,
    {
      lodgeId: booking.lodgeId,
      ...(booking.promoRedemption?.promoCode
        ? {
            discountCents: booking.discountCents,
            promoAdjustmentCents: booking.promoAdjustmentCents,
            promoCode: booking.promoRedemption.promoCode.code,
          }
        : {}),
    }
  ).catch((err) => logger.error({ err, bookingId: id }, "Failed to send confirmation email for confirmed draft"));

  // The admin alert for review-flagged bookings is sent once at creation
  // time; no second alert when a flagged draft is confirmed.

  void enqueueXeroBookingInvoiceOperation(id, {
    createdByMemberId: session.user.id,
  })
    .then(async (queuedInvoice) => {
      if (!queuedInvoice.queueOperationId) {
        return;
      }

      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    })
    .catch((err) =>
      logger.error(
        { err, bookingId: id },
        "Failed to queue Xero invoice for confirmed draft"
      )
    );

  return NextResponse.json({ success: true, status: BookingStatus.PAID });
}
