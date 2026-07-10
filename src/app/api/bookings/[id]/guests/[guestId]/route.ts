import { NextRequest, NextResponse } from "next/server";
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
import {
  createModificationAdditionalPaymentIntent,
  drainSupersededPrimaryIntents,
  executeBookingModificationRefund,
} from "@/lib/booking-modification-settlement";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; guestId: string }> }
) {
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

  // Issue #1705: the admin-on-behalf per-action email choice. The service honors
  // it ONLY for an admin removing a guest from a booking they do not own — a
  // member/linked-guest self-removal (the wizard's only caller) always notifies,
  // so a stray flag from that path is ignored there.
  const rawNotifyMember = (body as { notifyMember?: unknown } | null)
    ?.notifyMember;
  if (rawNotifyMember !== undefined && typeof rawNotifyMember !== "boolean") {
    return NextResponse.json(
      { error: "notifyMember must be a boolean" },
      { status: 400 },
    );
  }
  const notifyMember = rawNotifyMember as boolean | undefined;

  try {
    const result = await prisma.$transaction((tx) =>
      removeBookingGuestInTransaction({
        tx,
        bookingId,
        guestId,
        actorMemberId: session.user.id,
        actorRole: authorizationRoleFromAccessRoles(session.user),
        settlementMethod,
        notifyMember,
      })
    );

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
        // Issue #1705: record only when an admin-on-behalf removal suppressed the
        // member email; a default (notify) removal stays byte-identical.
        ...(result.notifyMember ? {} : { notifyMember: false }),
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

    // Send email. Issue #1705: an admin acting on-behalf may opt out via
    // notifyMember:false (result.notifyMember echoes the service's effective
    // decision — always true for member/linked-guest self-removal). The
    // minors-only admin alert below is an ADMIN notification, not the member
    // email, so it stays unconditional.
    const member = result.notifyMember
      ? await prisma.member.findUnique({
          where: { id: result.booking.memberId },
        })
      : null;
    if (member) {
      sendBookingModifiedEmail({
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
      choreWarnings: result.choreWarnings,
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingGuestRemovalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message =
      err instanceof Error ? err.message : "Failed to remove guest";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
