import { NextRequest, NextResponse } from "next/server";
import {
  BookingStatus,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { z } from "zod";

import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { chargePaymentMethod } from "@/lib/stripe";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import {
  reconcileBedAllocationsForBooking,
  reconcileBedAllocationsForBookingWithGlobalLockHeld,
  reconcileBedAllocationsForBookingWithLodgeLockHeld,
} from "@/lib/bed-allocation-lifecycle";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
  type NightAvailability,
} from "@/lib/capacity";
import { wholeLodgeBlockedNights } from "@/lib/over-capacity-confirmation";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import {
  sendAdminPaymentFailureAlert,
  sendBookingConfirmedEmail,
} from "@/lib/email";
import { bookingPromoEmailOptions } from "@/lib/booking-promo-email-options";
import { createStructuredAuditLog, getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";

const confirmPendingGuestsSchema = z.object({
  allowOverbook: z.boolean().optional(),
  // #1769b (#1705 semantics): per-action member-email choice. This route is
  // requireAdmin()-only, so no actor gate is needed. Absent = notify (default);
  // false suppresses the confirmation email (only sent on the zero-amount and
  // charged-card outcomes). A non-boolean value is rejected with 400.
  notifyMember: z.boolean().optional(),
});

function getOverbookedNightDates(nightDetails: NightAvailability[]): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().slice(0, 10));
}

/**
 * Admin override: "Confirm pending guests now".
 *
 * Reuses the pending-booking cron confirm logic for a single booking that
 * still has non-member guests on hold: charge the saved payment method (->
 * PAID), or, when there is no saved method (e.g. a #707 request-origin
 * booking), move it to a payment-owed status instead of charging. Either way
 * the hold is cleared so the non-member guests are locked in and the cron will
 * no longer bump them.
 *
 * The charge branch follows the cron's claim-first pattern (#1418): claim
 * PENDING -> CONFIRMED under the advisory lock, charge outside it, then
 * promote. A failed or requires-action charge releases the claim; a captured
 * charge is durably recorded as a PRIMARY payment transaction BEFORE
 * reconciliation so a promotion failure can always be finished by the Stripe
 * webhook, with an admin payment-failure alert either way — captured money is
 * never silent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  const body = await request.json().catch(() => ({}));
  const parsedBody = confirmPendingGuestsSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsedBody.error.flatten() },
      { status: 400 }
    );
  }
  const allowOverbook = parsedBody.data.allowOverbook ?? false;
  const notifyMember = parsedBody.data.notifyMember;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      member: true,
      // Per-night sets (issue #713) so the capacity re-check counts
      // non-contiguous stays on the nights they actually occupy.
      guests: { include: { nights: true } },
      payment: true,
      promoRedemption: { include: { promoCode: true } },
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (
    booking.status !== BookingStatus.PENDING ||
    !booking.hasNonMembers ||
    !booking.nonMemberHoldUntil
  ) {
    return NextResponse.json(
      { error: "This booking has no pending non-member guests to confirm" },
      { status: 409 }
    );
  }

  const previousRange = {
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  };
  const promoEmailOptions = bookingPromoEmailOptions(booking);
  const hasSavedPaymentMethod = Boolean(
    booking.payment?.stripePaymentMethodId && booking.payment?.stripeCustomerId
  );

  const auditRequest = getAuditRequestContext(request);

  const audit = (outcome: string, charged: boolean) =>
    createStructuredAuditLog({
      action: "booking.confirm_pending_guests",
      actor: { memberId: session.user.id },
      subject: { memberId: booking.memberId },
      entity: { type: "booking", id: bookingId },
      category: "booking",
      severity: "important",
      summary: `Admin confirmed pending non-member guests (${outcome})`,
      metadata: {
        outcome,
        charged,
        guestCount: booking.guests.length,
        finalPriceCents: booking.finalPriceCents,
        // #1769b honesty rule: record the notify choice only for the two
        // outcomes that actually send a member email (zero-amount and charged
        // card). The payment-owed and failure outcomes send none, so a
        // suppression there is not real and no field is recorded.
        ...((outcome === "paid_zero" || outcome === "paid_charged") &&
        notifyMember === false
          ? { notifyMember: false }
          : {}),
      },
      request: auditRequest,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to audit confirm-pending-guests")
    );

  const queueXeroInvoice = async () => {
    try {
      const queued = await enqueueXeroBookingInvoiceOperation(bookingId);
      if (queued.queueOperationId) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId },
        "Failed to queue Xero invoice after admin confirm-pending-guests"
      );
    }
  };

  try {
    // Zero-dollar booking: confirm without Stripe. Because a generic
    // non-member-hold PENDING booking does NOT hold capacity (#737), the beds
    // may already be taken by the time an admin confirms it. Re-check capacity
    // under the per-lodge capacity lock (acquireLodgeCapacityLock — the same
    // hashtextextended(lodgeId) key every admission, the cron/force-confirm
    // paths, and the exclusive-hold route take, #172) and only flip
    // PENDING -> PAID (a capacity-holding status) inside that lock. The lodgeId
    // comes from the pre-lock booking snapshot; a booking never changes lodge,
    // so the lock key is stable.
    if (booking.finalPriceCents === 0) {
      const zeroResult = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        // Two-tier protocol (#1881): this branch CLAIMS capacity (PENDING -> a
        // capacity-holding status), so it takes BOTH locks — global lock(1)
        // first (mutual exclusion with cancel/settlement), then the per-lodge
        // capacity lock so the re-check below serialises against per-lodge
        // booking creators. lodgeId is immutable, so keying from the pre-tx
        // read is safe.
        await acquireLodgeCapacityLock(tx, booking.lodgeId);

        // Re-read this booking's own capacity inputs INSIDE the lock (mirroring
        // cron-confirm-pending / force-confirm). Using the pre-lock findUnique
        // snapshot would let a concurrent guest-count increase slip through: we
        // would validate the smaller party but promote the larger one to a
        // capacity-holding status (same-booking TOCTOU).
        const locked = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { guests: { include: { nights: true } } },
        });
        if (!locked || locked.status !== BookingStatus.PENDING) {
          return { error: "Booking is no longer pending" as const, status: 409 };
        }

        const { available, nightDetails } = await checkCapacityForGuestRanges(
          locked.lodgeId,
          locked.checkIn,
          locked.checkOut,
          locked.guests,
          bookingId,
          tx
        );

        // Exclusive whole-lodge hold (ADR-001 decision 5, issue #118): refuse
        // even under allowOverbook, before any status advance. Held nights are
        // pinned to 0 so they never appear in overbookDates — this is the only
        // guard that catches them.
        const blockedNights = wholeLodgeBlockedNights({ nightDetails });
        if (blockedNights.length > 0) {
          return {
            error: "WHOLE_LODGE_HOLD_BLOCKED" as const,
            code: "WHOLE_LODGE_HOLD_BLOCKED" as const,
            blockedNights,
            status: 409,
          };
        }

        if (!available && !allowOverbook) {
          return {
            error: "CAPACITY_EXCEEDED" as const,
            overbookDates: getOverbookedNightDates(nightDetails),
            status: 409,
          };
        }

        const claimed = await tx.booking.updateMany({
          where: { id: bookingId, status: BookingStatus.PENDING },
          data: {
            status: BookingStatus.PAID,
            nonMemberHoldUntil: null,
            // Persisted capacity override (#1771): an admin "confirm now" that
            // advances a $0 booking over the ceiling (allowOverbook past the
            // gate) stamps the acting admin. Guarded — never set in-capacity.
            ...(!available
              ? {
                  capacityOverriddenAt: new Date(),
                  capacityOverriddenByMemberId: session.user.id,
                }
              : {}),
          },
        });
        if (claimed.count === 0) {
          return { error: "Booking is no longer pending" as const, status: 409 };
        }

        return { ok: true as const };
      });

      if ("error" in zeroResult) {
        return NextResponse.json(
          {
            error: zeroResult.error,
            ...("code" in zeroResult ? { code: zeroResult.code } : {}),
            ...("overbookDates" in zeroResult
              ? { overbookDates: zeroResult.overbookDates }
              : {}),
            ...("blockedNights" in zeroResult
              ? { blockedNights: zeroResult.blockedNights }
              : {}),
          },
          { status: zeroResult.status }
        );
      }

      await reconcileBedAllocationsForBooking({ bookingId, previousRange });
      await prisma.payment.upsert({
        where: { bookingId },
        create: { bookingId, amountCents: 0, status: PaymentStatus.SUCCEEDED },
        update: { amountCents: 0, status: PaymentStatus.SUCCEEDED },
      });
      await queueXeroInvoice();
      await audit("paid_zero", false);
      if (notifyMember !== false) {
        sendBookingConfirmedEmail(
          { bookingId: booking.id, recipientMemberId: booking.memberId },
          booking.member.email,
          booking.member.firstName,
          booking.checkIn,
          booking.checkOut,
          booking.guests.length,
          booking.finalPriceCents,
          promoEmailOptions
        ).catch((err) =>
          logger.error({ err, bookingId }, "Failed to send confirmation email")
        );
      }
      return NextResponse.json({ success: true, status: "PAID", charged: false });
    }

    // No saved payment method (request-origin): never charge — move to a
    // payment-owed status and let payment be arranged separately.
    if (!hasSavedPaymentMethod) {
      const claimed = await prisma.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.PAYMENT_PENDING,
          nonMemberHoldUntil: null,
        },
      });
      if (claimed.count === 0) {
        return NextResponse.json(
          { error: "Booking is no longer pending" },
          { status: 409 }
        );
      }
      await reconcileBedAllocationsForBooking({ bookingId, previousRange });
      await audit("payment_owed", false);
      return NextResponse.json({
        success: true,
        status: "PAYMENT_PENDING",
        charged: false,
      });
    }

    // Claim-first (#1418, the cron's pattern at cron-confirm-pending.ts:347-398):
    // claim PENDING -> CONFIRMED under the advisory lock BEFORE the Stripe
    // call. CONFIRMED holds capacity and is out of the cron's bump scope, so a
    // successful charge can no longer race a concurrent cron cancel into
    // markBookingPaymentSucceeded's "not payable" throw, and the pre-#1418
    // charge-then-refund churn window is gone. The lock is released before
    // Stripe — never hold a DB lock across a payment-provider network call.
    const claim = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      // Two-tier protocol (#1881): this branch CLAIMS capacity (PENDING ->
      // CONFIRMED), so it takes BOTH locks — global lock(1) first, then the
      // per-lodge capacity lock so the re-check serialises against per-lodge
      // creators. lodgeId is immutable.
      await acquireLodgeCapacityLock(tx, booking.lodgeId);
      // Re-read this booking's own capacity inputs INSIDE the lock (see the
      // zero-dollar branch) so a concurrent guest-count change can't gate the
      // charge on a stale, smaller party.
      const locked = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { guests: { include: { nights: true } } },
      });
      if (!locked || locked.status !== BookingStatus.PENDING) {
        return { error: "Booking is no longer pending" as const, status: 409 };
      }
      const { available, nightDetails } = await checkCapacityForGuestRanges(
        locked.lodgeId,
        locked.checkIn,
        locked.checkOut,
        locked.guests,
        bookingId,
        tx
      );
      // Exclusive whole-lodge hold (ADR-001 decision 5, issue #118): refuse even
      // under allowOverbook, before the CONFIRMED claim and any Stripe charge.
      const blockedNights = wholeLodgeBlockedNights({ nightDetails });
      if (blockedNights.length > 0) {
        return {
          error: "WHOLE_LODGE_HOLD_BLOCKED" as const,
          code: "WHOLE_LODGE_HOLD_BLOCKED" as const,
          blockedNights,
          status: 409,
        };
      }
      if (!available && !allowOverbook) {
        return {
          error: "CAPACITY_EXCEEDED" as const,
          overbookDates: getOverbookedNightDates(nightDetails),
          status: 409,
        };
      }

      const claimed = await tx.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.CONFIRMED,
          nonMemberHoldUntil: null,
          // Persisted capacity override (#1771): an admin "confirm now" that
          // claims a priced booking CONFIRMED over the ceiling (allowOverbook
          // past the gate) stamps the acting admin so the later charge's
          // markBookingPaymentSucceeded re-check honours it. Guarded — never
          // set in-capacity.
          ...(!available
            ? {
                capacityOverriddenAt: new Date(),
                capacityOverriddenByMemberId: session.user.id,
              }
            : {}),
        },
      });
      if (claimed.count === 0) {
        return { error: "Booking is no longer pending" as const, status: 409 };
      }
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId,
        db: tx,
        previousRange,
      });
      const payment = await tx.payment.upsert({
        where: { bookingId },
        create: {
          bookingId,
          amountCents: booking.finalPriceCents,
          status: PaymentStatus.PENDING,
          stripeCustomerId: booking.payment!.stripeCustomerId,
          stripePaymentMethodId: booking.payment!.stripePaymentMethodId,
        },
        update: {
          amountCents: booking.finalPriceCents,
          status: PaymentStatus.PENDING,
          stripeCustomerId: booking.payment!.stripeCustomerId,
          stripePaymentMethodId: booking.payment!.stripePaymentMethodId,
        },
      });
      return { ok: true as const, paymentId: payment.id };
    });

    if ("error" in claim) {
      return NextResponse.json(
        {
          error: claim.error,
          ...("code" in claim ? { code: claim.code } : {}),
          ...("overbookDates" in claim
            ? { overbookDates: claim.overbookDates }
            : {}),
          ...("blockedNights" in claim
            ? { blockedNights: claim.blockedNights }
            : {}),
        },
        { status: claim.status }
      );
    }

    // Mirror of the cron's releaseChargeClaim: only touched while Stripe has
    // NOT captured money. Once a charge succeeds the claim is never released —
    // CONFIRMED keeps holding the beds the member just paid for.
    const releaseChargeClaim = async () => {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await acquireLodgeCapacityLock(tx, booking.lodgeId);
        const released = await tx.booking.updateMany({
          where: { id: bookingId, status: BookingStatus.CONFIRMED },
          data: {
            status: BookingStatus.PENDING,
            nonMemberHoldUntil: booking.nonMemberHoldUntil,
          },
        });
        if (released.count > 0) {
          await reconcileBedAllocationsForBookingWithGlobalLockHeld({
            bookingId,
            db: tx,
            previousRange,
          });
        }
      });
    };

    // Charge the saved payment method — same path and Stripe idempotency key
    // as the cron (`pending_charge_<bookingId>`), so the two paths can never
    // double-charge the same booking.
    let paymentIntent;
    try {
      paymentIntent = await chargePaymentMethod({
        amountCents: booking.finalPriceCents,
        customerId: booking.payment!.stripeCustomerId!,
        paymentMethodId: booking.payment!.stripePaymentMethodId!,
        metadata: {
          bookingId,
          memberId: booking.memberId,
          source: "admin_confirm_pending_guests",
        },
        idempotencyKey: `pending_charge_${bookingId}`,
      });
    } catch (chargeErr) {
      // Charge attempt failed with nothing captured: release the claim and
      // alert admins, exactly like the cron path (#1418).
      await releaseChargeClaim().catch((revertErr) =>
        logger.error(
          { err: revertErr, bookingId },
          "Failed to release confirm-pending-guests charge claim"
        )
      );
      sendAdminPaymentFailureAlert({
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: booking.finalPriceCents,
        errorMessage:
          chargeErr instanceof Error ? chargeErr.message : String(chargeErr),
        paymentIntentId: booking.payment?.stripePaymentIntentId || "N/A",
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId },
          "Failed to send admin payment failure alert"
        )
      );
      await audit("charge_failed", false);
      logger.error(
        { err: chargeErr, bookingId },
        "Admin confirm-pending-guests: Stripe charge failed"
      );
      return NextResponse.json(
        {
          error:
            "The card charge failed; the booking was returned to pending and admins have been alerted.",
        },
        { status: 502 }
      );
    }

    if (paymentIntent.status !== "succeeded") {
      // Requires further action (e.g. 3DS): release the claim and leave the
      // booking pending for the Stripe webhook to resolve rather than
      // confirming optimistically.
      await releaseChargeClaim().catch((revertErr) =>
        logger.error(
          { err: revertErr, bookingId },
          "Failed to release confirm-pending-guests charge claim"
        )
      );
      return NextResponse.json(
        {
          error:
            "The saved card needs further authorisation; the charge could not be completed automatically.",
          paymentStatus: paymentIntent.status,
        },
        { status: 409 }
      );
    }

    const paymentMethodId =
      typeof paymentIntent.payment_method === "string"
        ? paymentIntent.payment_method
        : paymentIntent.payment_method?.id ?? null;

    // Durably record the captured charge BEFORE reconciliation (#1418).
    // markBookingPaymentSucceeded writes this same PRIMARY transaction inside
    // its own transaction, so a throw there rolls the row back — and the
    // payment_intent.succeeded webhook refuses to act without it ("no primary
    // payment transaction"), which is exactly how captured money used to go
    // silent. With the row committed here, the webhook can always finish the
    // promotion (or route a cancelled booking through the #1350 refund guard).
    try {
      await upsertPaymentIntentTransaction({
        paymentId: claim.paymentId,
        kind: PaymentTransactionKind.PRIMARY,
        paymentIntentId: paymentIntent.id,
        amountCents: paymentIntent.amount,
        status: PaymentStatus.SUCCEEDED,
        paymentMethodId,
        stripeCustomerId: booking.payment!.stripeCustomerId,
      });
    } catch (recordErr) {
      // Non-fatal: reconciliation below upserts the identical row.
      logger.error(
        { err: recordErr, bookingId, paymentIntentId: paymentIntent.id },
        "Failed to pre-record captured charge before reconciliation"
      );
    }

    let reconciliation;
    try {
      reconciliation = await markBookingPaymentSucceeded({
        bookingId,
        paymentIntentId: paymentIntent.id,
        amountCents: paymentIntent.amount,
        paymentMethodId,
      });
    } catch (reconcileErr) {
      // Money is captured but the promotion failed (transient DB error, or a
      // concurrent admin action moved the booking). Do NOT refund and do NOT
      // release the claim: CONFIRMED keeps holding the beds the member paid
      // for, the pre-recorded transaction row lets the Stripe webhook retry
      // the promotion idempotently, and admins are alerted for manual review —
      // the cron makes the same leave-claimed choice (#1418).
      logger.error(
        { err: reconcileErr, bookingId, paymentIntentId: paymentIntent.id },
        "Admin confirm-pending-guests: charge captured but reconciliation failed; leaving booking claimed"
      );
      sendAdminPaymentFailureAlert({
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: paymentIntent.amount,
        errorMessage: `Charge ${paymentIntent.id} was captured but the booking could not be finalised: ${
          reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)
        }. The booking remains CONFIRMED holding its beds; the Stripe webhook will retry the promotion, or review manually.`,
        paymentIntentId: paymentIntent.id,
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId },
          "Failed to send admin payment failure alert"
        )
      );
      await audit("charged_finalisation_pending", true);
      return NextResponse.json(
        {
          error:
            "The charge succeeded but the booking could not be finalised yet; it stays confirmed and admins have been alerted.",
          paymentIntentId: paymentIntent.id,
        },
        { status: 500 }
      );
    }

    if (reconciliation.outcome === "cancelled_refunded") {
      // The final capacity claim failed (only reachable here if the booking
      // lost its CONFIRMED claim to a concurrent actor): the reconciler has
      // already cancelled the booking and auto-refunded the charge in full.
      await audit("charged_capacity_refunded", true);
      return NextResponse.json(
        {
          error:
            "The dates filled before the booking could be finalised; the charge was refunded in full and the booking cancelled.",
        },
        { status: 409 }
      );
    }

    if (
      reconciliation.outcome === "duplicate_capture_refunded" ||
      reconciliation.outcome === "duplicate_capture_refund_failed"
    ) {
      // #1992 — the booking had ALREADY been settled by a different capture
      // (e.g. the member paid an in-flight /pay link intent in the same
      // window), so the charge this route just made was duplicate money. The
      // reconciler auto-refunded it (or, on an inline failure, left a durable
      // refund operation for the recovery cron) and alerted admins either
      // way. The booking IS finalised — by the other capture — so a 500
      // "could not be finalised" here was inaccurate; report the settled
      // booking and the duplicate refund truthfully. The settling path
      // already sent the confirmation email and queued the Xero invoice, so
      // neither is repeated for the duplicate.
      await audit(`charged_${reconciliation.outcome}`, true);
      return NextResponse.json({
        success: true,
        status: "PAID",
        charged: false,
        duplicateChargeRefunded:
          reconciliation.outcome === "duplicate_capture_refunded",
        message:
          reconciliation.outcome === "duplicate_capture_refunded"
            ? "The booking was already paid by another payment; this duplicate charge was automatically refunded in full."
            : "The booking was already paid by another payment; the refund of this duplicate charge failed inline and has been queued for automatic retry. Admins have been alerted.",
      });
    }

    if (reconciliation.outcome !== "paid" && reconciliation.outcome !== "already_paid") {
      // cancelled_refund_failed (the reconciler has already alerted the refund
      // failure) or an unexpected outcome: surface an accurate error.
      logger.error(
        { bookingId, outcome: reconciliation.outcome },
        "Admin confirm-pending-guests: payment succeeded but reconciliation did not settle"
      );
      await audit(`charged_${reconciliation.outcome}`, true);
      return NextResponse.json(
        {
          error:
            "Payment succeeded but the booking could not be finalised; admins have been alerted.",
          paymentIntentId: paymentIntent.id,
        },
        { status: 500 }
      );
    }

    await queueXeroInvoice();
    await audit("paid_charged", true);
    if (notifyMember !== false) {
      sendBookingConfirmedEmail(
        { bookingId: booking.id, recipientMemberId: booking.memberId },
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.finalPriceCents,
        promoEmailOptions
      ).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send confirmation email")
      );
    }
    return NextResponse.json({ success: true, status: "PAID", charged: true });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to confirm pending guests");
    return NextResponse.json(
      { error: "Failed to confirm pending guests" },
      { status: 500 }
    );
  }
}
