import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import {
  AdultMemberHostingRequiredError,
  buildAdultMemberHostingRefusalBody,
} from "@/lib/adult-member-hosting-review";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  SameOwnerCoverageOverrideRequiredError,
  SameOwnerCoverageWouldBreakError,
  buildSameOwnerCoverageOverrideRequiredBody,
  buildSameOwnerCoverageRefusalBody,
  readHostingCoverageOverride,
} from "@/lib/adult-member-hosting-same-owner";
import { ApiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  sendAdminMinorsOnlyReviewAlert,
  sendBookingModifiedEmail,
} from "@/lib/email";
import { ADULT_SUPERVISION_REVIEW_REASON } from "@/lib/booking-review";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  BookingGuestRemovalError,
  removeBookingGuestInTransaction,
} from "@/lib/booking-guest-removal-service";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import {
  buildPaidUpAdultRefusalBody,
  buildPaidUpAdultRefusalBodyForOtherPartyMember,
  PaidUpAdultMemberRequiredError,
} from "@/lib/subscription-lockout-enforcement";
import {
  createModificationAdditionalPaymentIntent,
  drainSupersededPrimaryIntents,
  executeBookingModificationRefund,
} from "@/lib/booking-modification-settlement";
import {
  handleMemberGuestAddRefusal,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; guestId: string }> }
) {
  // Finding 2 (privacy re-review of MG3 #2308): removing a guest re-checks the
  // REMAINING party, which can raise the collapsed refusal about a cross-family
  // member guest still on the booking.
  const memberGuestRefusalStartedAt = startMemberGuestRefusalClock();
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId, guestId } = await params;
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  const body = await request.json().catch(() => null);
  const rawSettlementMethod = (body as { settlementMethod?: unknown } | null)
    ?.settlementMethod;
  if (
    rawSettlementMethod !== undefined &&
    rawSettlementMethod !== "card" &&
    rawSettlementMethod !== "credit"
  ) {
    return NextResponse.json(
      { error: "settlementMethod must be 'card' or 'credit'" },
      { status: 400 },
    );
  }
  const settlementMethod = rawSettlementMethod as
    | BookingModificationSettlementMethod
    | undefined;

  // #2576 §7: the officer's explicit confirmation and reason for overriding a
  // same-owner coverage refusal. Read off the same body, and simply absent when the
  // client did not send one — the officer is asked only when the removal would
  // actually strand another booking on the owner's account.
  const hostingCoverageOverride = readHostingCoverageOverride(body);

  // Issue #1705 (#1696 semantics): the per-action member-email choice. Only a
  // booking-management ADMIN (Full Admin / Booking Officer) may carry the flag;
  // any other caller — the booking owner or a self-removing linked guest — is
  // refused before the removal runs, so a member can never suppress their own
  // guest-removal notification. Absent means notify.
  const rawNotifyMember = (body as { notifyMember?: unknown } | null)
    ?.notifyMember;
  if (rawNotifyMember !== undefined && typeof rawNotifyMember !== "boolean") {
    return NextResponse.json(
      { error: "notifyMember must be a boolean" },
      { status: 400 },
    );
  }
  const managementRole = bookingManagementAuthorizationRole(session.user);
  if (rawNotifyMember !== undefined && managementRole !== "ADMIN") {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 },
    );
  }
  const notifyMember =
    managementRole !== "ADMIN" ? true : rawNotifyMember !== false;

  // #2543 — read BEFORE the transaction opens: the removal re-evaluates the
  // paid-up-adult requirement over what is left, and resolving the mode inside
  // the transaction would both take a second pooled connection under its locks
  // and let the financial-year refresh reach Xero from there.
  const subscriptionLockoutMode = await resolveSubscriptionLockoutMode();

  // #3123 — read BEFORE the transaction opens, for the same reason and in the
  // same place as the line above. Resolving the club's persisted timezone is a
  // `clubTimeSettings.findUnique`, and the removal's self-removal window is
  // judged under the per-lodge capacity key (`INV-LOCK-004`). It decides
  // whether a member may take themselves off a stay that has not started, so
  // for a club behind Greenwich the container's timezone would refuse a
  // self-removal a whole day early.
  const clubTodayDateOnly = await clubTodayDateOnlyInstant();

  try {
    const result = await prisma.$transaction((tx) =>
      removeBookingGuestInTransaction({
        tx,
        bookingId,
        guestId,
        actorMemberId: session.user.id,
        // Booking Officer is delegated booking-management authority even when
        // their legacy access-role projection is USER. Preserve that authority
        // on an override-only retry.
        actorRole: managementRole,
        settlementMethod,
        subscriptionLockoutMode,
        hostingCoverageOverride,
        today: clubTodayDateOnly,
      })
    );

    // #2576 §7/§8. Removing the qualifying adult member is the change class the
    // owner names first. A member's removal that would strand another of their
    // bookings was already refused inside the transaction above; an officer's was
    // allowed and recorded a bounded re-evaluation row, and this is where that
    // becomes an urgent incident and an email to the owner. Best-effort — the
    // removal is committed, and the cron sweep is the authority on completion.
    await settleHostingCoverageAfterCommit({ bookingId });

    /**
     * MG4 (#2309): tell a member guest their place has gone.
     *
     * WIRED HERE RATHER THAN IN `removeBookingGuestInTransaction`, and that is
     * the load-bearing choice. Three callers share that service, and only ONE of
     * them owes this email:
     *
     *   - this route, where a booker or an officer took somebody off;
     *   - the consent endpoint, where the member (or their delegate) DECLINED —
     *     they already know, and they already get the decline confirmation;
     *   - the nightly expiry sweep, where the request lapsed — which has its own
     *     template saying exactly that, and calling this one too would send the
     *     same person two different explanations of one event.
     *
     * Putting it in the service would have meant a flag the other two remember
     * to pass, i.e. a duplicate email waiting for whoever forgets.
     *
     * The three skips below are each a real case, not defensiveness: a NULL
     * consent status means no message was ever sent about this row (family
     * scope, or any pre-feature guest), a null memberId means there is no member
     * to tell, and a self-removal (#2250) means the reader is the person who
     * just pressed the button.
     */
    const removed = result.removedGuest;
    if (
      removed.memberId != null &&
      removed.consentStatus != null &&
      removed.memberId !== session.user.id
    ) {
      const { sendMemberGuestWithdrawnNotifications } = await import(
        "@/lib/member-guest-consent-notifications"
      );
      try {
        await sendMemberGuestWithdrawnNotifications({
          bookingId,
          targetMemberIds: [removed.memberId],
          // A request nobody had answered yet was called off; a settled place
          // was taken off. Two different things to the reader.
          context:
            removed.consentStatus === "PENDING"
              ? "REQUEST_CANCELLED"
              : "TAKEN_OFF",
        });
      } catch (err) {
        logger.error(
          { err, bookingId, guestId },
          "Failed to dispatch a member-guest withdrawal notification",
        );
      }
    }

    // A zero-dollar auto-pay supersedes any outstanding primary
    // PaymentIntents inside the transaction; cancel them on Stripe now so a
    // stale checkout tab cannot capture the pre-removal amount (#1041).
    await drainSupersededPrimaryIntents({
      bookingId,
      supersededPrimaryPaymentIntents: result.supersededPrimaryPaymentIntents,
    });

    // Process the Stripe refund outside the transaction (avoids holding the
    // advisory lock during the Stripe API call). Only the Stripe-refundable
    // slice (pendingRefundAmountCents) is charged back; account credit and
    // non-Stripe captured payments never issue a Stripe refund. The shared
    // helper scopes the idempotency key to this modification and enqueues
    // durable recovery on failure (issue #818).
    const stripeRefundId = await executeBookingModificationRefund({
      bookingId,
      result,
      metadataReason: "guest_removed_price_decrease",
      idempotencyKeyPrefix: `guest_remove_refund_${bookingId}`,
      failureMessage:
        "Stripe refund failed after guest removal - enqueueing recovery",
      recoveryFailureMessage:
        "Failed to enqueue guest-removal refund recovery - manual reconciliation required",
    });

    // Collect a removal-induced price increase on a Stripe booking (#1042):
    // removing a guest can invalidate a group promo and raise the price of the
    // remaining guests. Reuse the batch flow's additional-intent helper; the
    // payer is always the booking owner (result.memberId), whose booking page
    // surfaces the pending additional payment via AdditionalPaymentCard.
    // No-op when nothing is owed or the payment is not a captured Stripe
    // payment (Internet Banking increases bill via the Xero supplementary
    // invoice below, unchanged).
    const { additionalPaymentClientSecret, additionalPaymentIntentId } =
      await createModificationAdditionalPaymentIntent({
        bookingId,
        result,
        reason: "guest_removal_price_increase",
        idempotencyKey: `mod_guest_remove_${bookingId}_${result.bookingModificationId}`,
        failureMessage:
          "Failed to create additional PaymentIntent for guest removal",
      });

    // Audit log
    logAudit({
      action: "booking.modify.guests.remove",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: result.booking.memberId,
      entityType: "BookingModification",
      entityId: result.bookingModificationId,
      category: "booking",
      outcome: "success",
      summary: "Booking guest removed",
      details: JSON.stringify({
        removedGuest: `${result.removedGuest.firstName} ${result.removedGuest.lastName}`,
        priceDiffCents: result.priceDiffCents,
        refundAmountCents: result.refundAmountCents,
        accountCreditAmountCents: result.accountCreditAmountCents,
        settlementMethod: result.settlementMethod,
        policyRetainedAmountCents: result.policyRetainedAmountCents,
        choreWarnings: result.choreWarnings,
      }),
      metadata: {
        bookingId,
        removedGuest: `${result.removedGuest.firstName} ${result.removedGuest.lastName}`,
        priceDiffCents: result.priceDiffCents,
        refundAmountCents: result.refundAmountCents,
        accountCreditAmountCents: result.accountCreditAmountCents,
        settlementMethod: result.settlementMethod,
        policyRetainedAmountCents: result.policyRetainedAmountCents,
        choreWarnings: result.choreWarnings,
        newGuestCount: result.booking.guests.length,
        // Issue #1705 (#1698 pattern): a suppressed admin removal records the
        // choice — notifyMember is false only when an admin opted out, so every
        // suppressed guest-removal email stays auditable.
        ...(notifyMember ? {} : { notifyMember: false }),
      },
      ipAddress,
    });

    void queueXeroBookingEditSettlement({
      bookingId,
      bookingModificationId: result.bookingModificationId,
      createdByMemberId: session.user.id,
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      originalPaymentStatus: result.paymentStatus,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: 0,
      datesChanged: false,
      // Policy-limited settlement amount + method so a captured-payment
      // reduction issues the correct (card vs credit) modification credit
      // note; an unpaid issued invoice falls back to the full delta inside
      // classifyXeroBookingEditSettlement when this is null.
      settlementAmountCents: result.xeroRefundAmountCents,
      settlementMethod: result.settlementMethod,
      // A Stripe-collected increase must not double-bill through Xero: hold
      // the supplementary invoice's payment recording on the Stripe intent,
      // exactly as the batch flow does.
      requiresAdditionalStripePayment:
        result.xeroAdditionalAmountCents > 0 && result.hasSucceededPayment,
      additionalPaymentIntentId,
      createPrimaryInvoiceWhenMissing:
        result.zeroDollarAutoPaid && !result.hasIssuedXeroInvoice,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to queue Xero settlement for guest removal")
    );

    // Send email — unless an admin explicitly chose not to (#1705). The
    // admin-facing minors-only review alert below is NOT member-facing and is
    // never suppressed by the choice.
    const member = notifyMember
      ? await prisma.member.findUnique({
          where: { id: result.booking.memberId },
        })
      : null;
    if (member) {
      sendBookingModifiedEmail({
        bookingId: result.booking.id,
        recipientMemberId: member.id,
        email: member.email,
        firstName: member.firstName,
        modificationType: "GUEST_REMOVE",
        oldCheckIn: result.booking.checkIn,
        oldCheckOut: result.booking.checkOut,
        newCheckIn: result.booking.checkIn,
        newCheckOut: result.booking.checkOut,
        oldGuestCount: result.oldGuestCount,
        newGuestCount: result.booking.guests.length,
        oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
        newFinalPriceCents: result.booking.finalPriceCents,
        changeFeeCents: 0,
        refundAmountCents: result.refundAmountCents,
        accountCreditAmountCents: result.accountCreditAmountCents,
        // #2390: same words as the edit preview and the booking history when a
        // usage cap stopped the promotion reaching somebody on this booking.
        promoCoverageNote: result.promoCoverage?.message ?? null,
        lodgeId: result.booking.lodgeId,
        // Removing a guest can raise the price when it invalidates a group
        // promo the remaining guests relied on. Surface the increase when a
        // way to pay it exists: the Xero supplementary invoice on the
        // issued-invoice (Internet Banking) path, or the additional
        // PaymentIntent now created for captured Stripe payments (#1042). If
        // Stripe intent creation failed, stay silent — an "additional payment
        // required" note with no way to pay is worse than saying nothing; the
        // price change still shows via old/new total.
        additionalAmountCents:
          result.hasIssuedXeroInvoice || additionalPaymentIntentId
            ? result.additionalAmountCents
            : 0,
        additionalPaymentMethod:
          result.additionalAmountCents > 0 && additionalPaymentIntentId
            ? "STRIPE"
            : result.hasIssuedXeroInvoice && result.additionalAmountCents > 0
              ? "INTERNET_BANKING"
              : undefined,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send booking modified email")
      );
    }

    // #1372: removing the last adult from a paid booking blocks its lodge
    // check-in (the booking KEEPS its PAID status). Nudge admins to review it,
    // best-effort — an email failure must never block the removal.
    if (result.minorsOnlyReviewNewlyFlagged) {
      sendAdminMinorsOnlyReviewAlert({
        memberName: result.memberName,
        checkIn: result.booking.checkIn,
        checkOut: result.booking.checkOut,
        guestCount: result.booking.guests.length,
        reviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      }).catch((err) =>
        logger.error(
          { err, bookingId },
          "Failed to send minors-only review admin alert",
        ),
      );
    }

    return NextResponse.json({
      booking: result.booking,
      removedGuest: result.removedGuest,
      priceDiffCents: result.priceDiffCents,
      refundAmountCents: result.refundAmountCents,
      accountCreditAmountCents: result.accountCreditAmountCents,
      settlementMethod: result.settlementMethod,
      policyRetainedAmountCents: result.policyRetainedAmountCents,
      stripeRefundId: stripeRefundId ?? null,
      additionalAmountCents: result.additionalAmountCents,
      // The payer is the booking owner. Hand the client secret only to them
      // (or an admin acting on their behalf); a linked guest self-removing
      // must not receive a secret for someone else's payment — the owner
      // completes it from their booking page instead.
      additionalPaymentClientSecret:
        session.user.id === result.memberId ||
        authorizationRoleFromAccessRoles(session.user) === "ADMIN"
          ? additionalPaymentClientSecret ?? null
          : null,
      promoRemoved: result.promoRemoved,
      // #2390: who the promotion still covers after this edit, and who it does
      // not. Null unless a usage cap left somebody out.
      promoCoverage: result.promoCoverage,
      choreWarnings: result.choreWarnings,
    });
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
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
        route: "bookings/guest-remove",
        startedAt: memberGuestRefusalStartedAt,
        throttle: "CHARGE_NOW",
        skipAuthorization:
          authorizationRoleFromAccessRoles(session.user) === "ADMIN",
      });
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingGuestRemovalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // #2543 — handled BEFORE the generic `ApiError` branch below, which would
    // otherwise reduce this refusal to a bare message and drop the frozen
    // violation, the HOLD promise and the path to ask a Booking Officer. Same
    // body as the other five paths.
    if (err instanceof PaidUpAdultMemberRequiredError) {
      // The one refusal in the tree that can be delivered to somebody who does NOT
      // own the booking: a member may take their own guest row off another member's
      // booking, and the #2543 owner arm can then fire alone, where
      // `repricedUnpaidMemberCount: 0` would expose the OWNER's unpaid subscription.
      // The service decides the audience, because only it still holds the booking
      // row by the time this catch runs (see `PaidUpAdultRefusalAudience`).
      return NextResponse.json(
        err.audience === "OTHER_PARTY_MEMBER"
          ? buildPaidUpAdultRefusalBodyForOtherPartyMember(err.violation)
          : buildPaidUpAdultRefusalBody(err.violation),
        { status: err.status },
      );
    }
    // #2569 — same reason, same order: `AdultMemberHostingRequiredError` extends
    // ApiError, so it must be tested BEFORE the generic branch or the ENFORCED
    // hosting refusal is flattened to a bare sentence and the member loses the
    // exception door. Host identities are withheld from this body (#2569 §5).
    //
    // This is the path where the refusal is most easily misread as a bug: taking
    // the LAST adult member off a booking that still carries non-member guests is
    // exactly the change the rule forbids, so the removal is refused and the
    // booking is left whole. Unlike its #2543 neighbour above this body has no
    // audience split — the hosting violation names no member (§5), so there is
    // nothing in it that could disclose the owner's affairs to another party
    // member removing their own row.
    if (err instanceof AdultMemberHostingRequiredError) {
      return NextResponse.json(
        buildAdultMemberHostingRefusalBody(err.violation),
        { status: err.status },
      );
    }
    // #2576 §6 — the OTHER direction of the same removal, and the same ordering
    // rule for the same reason: taking the adult member off THIS booking can leave
    // ANOTHER booking on the member's own account without cover, and the body is
    // what names which booking, which lodge and which nights.
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
    // Shared-lib domain errors (e.g. the #1032 quote-priced edit block from
    // assertBookingNotQuotePriced) carry intentional user-facing messages.
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // #1888 — unexpected (non-typed) errors must not leak their message to
    // the client; the raw error stays in the log only.
    logger.error({ err }, "Failed to remove guest from booking");
    return NextResponse.json(
      { error: "Failed to remove guest" },
      { status: 400 }
    );
  }
}
