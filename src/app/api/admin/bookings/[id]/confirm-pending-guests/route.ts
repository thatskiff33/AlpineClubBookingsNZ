import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { z } from "zod";

import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { stripeReferenceId } from "@/lib/stripe-references";
import { readStripeErrorFields } from "@/lib/stripe-errors";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import {
  beginSavedCardChargeAttempt,
  cancelStaleSavedCardChargeIntents,
  chargeSavedCardAttempt,
  describeUnsettledPaymentIntent,
  SAVED_CARD_CHARGE_REASON,
  SavedCardChargeRefusedError,
  settleSavedCardChargeAttempt,
} from "@/lib/saved-card-charge-attempt";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueOwnHostingCoverageReevaluation } from "@/lib/adult-member-hosting-review";
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
import { formatDateOnly } from "@/lib/date-only";
import {
  savedPaymentMethodForBooking,
  savedPaymentMethodRowStamp,
} from "@/lib/saved-payment-method";

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
    .map((night) => formatDateOnly(night.date));
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
      // #3269: a split child (#738) may be charged on its parent's saved card;
      // the parent's row is what proves the card was saved for reuse.
      parentBooking: { include: { payment: true } },
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
  // The one home for "may this booking's saved card be charged off-session"
  // (#3269, `INV-PAY-053`): own row first, then the split parent's, each gated
  // on SetupIntent provenance. A one-off checkout card on either row is not a
  // saved card, so the booking takes the payment-owed branch below instead of a
  // charge Stripe would refuse.
  const savedPayment = savedPaymentMethodForBooking({
    payment: booking.payment,
    parentBooking: booking.parentBooking,
  });

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

        await reconcileBedAllocationsForBookingWithLodgeLockHeld({
          bookingId,
          db: tx,
          previousRange,
        });
        await enqueueOwnHostingCoverageReevaluation(bookingId, tx, {
          cause: "SYSTEM_CHANGE",
          actorMemberId: session.user.id,
        });

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

      await settleHostingCoverageAfterCommit({ bookingId });
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
    if (!savedPayment) {
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

    // Claim-first (#1418, the cron's pattern in `resolveHoldWindowUnderLock`):
    // claim PENDING -> CONFIRMED under the advisory lock BEFORE the Stripe
    // call. CONFIRMED holds capacity and is out of the cron's bump scope, so a
    // successful charge can no longer race a concurrent cron cancel into
    // markBookingPaymentSucceeded's "not payable" throw, and the pre-#1418
    // charge-then-refund churn window is gone. The lock is released before
    // Stripe — never hold a DB lock across a payment-provider network call.
    //
    // #3267 (`INV-PAY-055`): the same transaction now also makes the charge
    // ATTEMPT durable (`beginSavedCardChargeAttempt`), which is what stops this
    // route and the cron double-charging one booking now that they no longer
    // share a Stripe key. A payment already holding captured cash throws
    // `SavedCardChargeRefusedError`, rolling the whole claim back.
    const runClaim = () => prisma.$transaction(async (tx) => {
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
      // #2576 §9. "Officer approval" on the owner's list of confirming paths. It is
      // an OFFICER acting, so §7/§8 apply rather than §6: the confirmation is never
      // refused, the obligation to re-read the hosting facts is recorded inside this
      // transaction (under the per-lodge capacity lock the coverage-removing paths
      // also take, which is what closes the confirm-while-source-removed race), and
      // an uncovered booking becomes an urgent compliance incident after commit.
      //
      // Safe against `releaseChargeClaim` below: an incident is only ever opened for
      // a booking whose status is confirmed active attendance, so a claim released
      // back to PENDING when the charge fails drains to nothing.
      await enqueueOwnHostingCoverageReevaluation(bookingId, tx, {
        cause: "SYSTEM_CHANGE",
        actorMemberId: session.user.id,
      });
      // #3269: the card is charged from `savedPayment`; the claim writes only
      // the customer onto this row (`savedPaymentMethodRowStamp`), so it can
      // neither launder a parent's pm nor resurrect one a concurrent
      // replacement mint just cleared.
      const rowStamp = savedPaymentMethodRowStamp(savedPayment);
      const payment = await tx.payment.upsert({
        where: { bookingId },
        create: {
          bookingId,
          amountCents: booking.finalPriceCents,
          status: PaymentStatus.PENDING,
          ...rowStamp,
        },
        update: {
          amountCents: booking.finalPriceCents,
          status: PaymentStatus.PENDING,
          ...rowStamp,
        },
      });
      const attempt = await beginSavedCardChargeAttempt(tx, {
        paymentId: payment.id,
        bookingId,
        amountCents: booking.finalPriceCents,
        card: savedPayment,
        reason: SAVED_CARD_CHARGE_REASON.adminConfirmPendingGuests,
      });
      return { ok: true as const, paymentId: payment.id, attempt };
    });

    let claim: Awaited<ReturnType<typeof runClaim>>;
    try {
      claim = await runClaim();
    } catch (claimErr) {
      if (!(claimErr instanceof SavedCardChargeRefusedError)) throw claimErr;
      // Nothing was claimed and nothing charged; a person has to look.
      logger.error(
        { bookingId, paymentIntentId: claimErr.paymentIntentId },
        "Admin confirm-pending-guests: refused to charge, a captured charge is already recorded on this pending booking (#3267)"
      );
      sendAdminPaymentFailureAlert({
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: booking.finalPriceCents,
        errorMessage: claimErr.message,
        paymentIntentId: claimErr.paymentIntentId ?? "N/A",
      }).catch((alertErr) =>
        logger.error(
          { err: alertErr, bookingId },
          "Failed to send admin payment failure alert"
        )
      );
      await audit("charge_refused_captured_exists", false);
      return NextResponse.json(
        { error: claimErr.message, paymentIntentId: claimErr.paymentIntentId },
        { status: 409 }
      );
    }

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

    // #2576 §9: drain what the claim recorded, now that it has committed.
    await settleHostingCoverageAfterCommit({ bookingId });

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

    // #3267: earlier attempts the claim ended (a replaced card) have their
    // intents cancelled best-effort here, after commit and before the charge.
    await cancelStaleSavedCardChargeIntents(claim.attempt, { bookingId });

    // Charge the saved payment method through the one attempt contract every
    // path uses (#3267, `INV-PAY-055`): a fresh attempt charges under the row's
    // own key; an unresolved earlier attempt (the cron's, or a previous click)
    // is asked about instead of repeated. The never-double-charge property the
    // shared `pending_charge_<bookingId>` key used to provide is now enforced by
    // the ledger inside the claim transaction above, so this route no longer
    // meets Stripe's idempotency parameter-mismatch error — what comes back is
    // the attempt's true outcome.
    let paymentIntent;
    try {
      paymentIntent = await chargeSavedCardAttempt({
        attempt: claim.attempt,
        bookingId,
        memberId: booking.memberId,
        amountCents: booking.finalPriceCents,
        card: savedPayment,
      });
    } catch (chargeErr) {
      // Charge attempt failed with nothing captured: release the claim and
      // alert admins, exactly like the cron path (#1418). A definite Stripe
      // refusal has already ended the attempt row, so the next click starts a
      // fresh one; an ambiguous failure leaves it to be asked about.
      await releaseChargeClaim().catch((revertErr) =>
        logger.error(
          { err: revertErr, bookingId },
          "Failed to release confirm-pending-guests charge claim"
        )
      );
      const stripeFields = readStripeErrorFields(chargeErr);
      sendAdminPaymentFailureAlert({
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: booking.finalPriceCents,
        errorMessage: stripeFields.message,
        paymentIntentId:
          (claim.attempt.kind === "replay" ? claim.attempt.paymentIntentId : null) ??
          booking.payment?.stripePaymentIntentId ??
          "N/A",
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
      // Say what Stripe actually said when Stripe said it; a local failure's
      // message is not for the response body.
      const detail =
        stripeFields.apiType !== null
          ? ` Stripe said: "${stripeFields.message}".`
          : "";
      return NextResponse.json(
        {
          error: `The card charge failed; the booking was returned to pending and admins have been alerted.${detail}`,
        },
        { status: 502 }
      );
    }

    if (paymentIntent.status !== "succeeded") {
      // The intent exists but did not capture (3DS challenge outstanding, still
      // processing, or — on a replay — an earlier attempt that has since died).
      // Record what Stripe answered on the attempt row FIRST, so the next click
      // or cron run asks about this intent rather than minting a second one
      // (or, for a dead intent, starts fresh), then release the claim and leave
      // the booking pending for the Stripe webhook to resolve rather than
      // confirming optimistically.
      await settleSavedCardChargeAttempt({
        attemptRowId: claim.attempt.attemptRowId,
        paymentIntent,
      });
      await releaseChargeClaim().catch((revertErr) =>
        logger.error(
          { err: revertErr, bookingId },
          "Failed to release confirm-pending-guests charge claim"
        )
      );
      return NextResponse.json(
        {
          error: describeUnsettledPaymentIntent(paymentIntent.status),
          paymentStatus: paymentIntent.status,
        },
        { status: 409 }
      );
    }

    const paymentMethodId = stripeReferenceId(paymentIntent.payment_method);

    // Durably record the captured charge BEFORE reconciliation (#1418).
    // markBookingPaymentSucceeded writes this same PRIMARY transaction inside
    // its own transaction, so a throw there rolls the row back — and the
    // payment_intent.succeeded webhook refuses to act without it ("no primary
    // payment transaction"), which is exactly how captured money used to go
    // silent. With the row committed here, the webhook can always finish the
    // promotion (or route a cancelled booking through the #1350 refund guard).
    // Since #3267 the row already exists (the attempt); this stamps the intent
    // and SUCCEEDED onto it.
    try {
      await settleSavedCardChargeAttempt({
        attemptRowId: claim.attempt.attemptRowId,
        paymentIntent,
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
      const hostingRetry = hostingCoverageParticipantRetryResponse(
        reconcileErr,
        {
          paymentReceived: true,
          finalisationPending: true,
        },
      );
      if (hostingRetry) return hostingRetry;
      return NextResponse.json(
        {
          error:
            "The charge succeeded but the booking could not be finalised yet; it stays confirmed and admins have been alerted.",
          paymentReceived: true,
          finalisationPending: true,
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

    if (reconciliation.outcome === "cancelled_refund_failed") {
      // The final capacity claim failed and the reconciler has already
      // committed the cancellation together with a durable refund-recovery
      // operation. This is not booking finalisation pending: the booking is
      // definitively CANCELLED and only the captured charge's refund remains
      // unresolved.
      logger.error(
        { bookingId, outcome: reconciliation.outcome },
        "Admin confirm-pending-guests: booking cancelled and captured-charge refund recovery is pending"
      );
      await audit(`charged_${reconciliation.outcome}`, true);
      return NextResponse.json(
        {
          error:
            "The booking was cancelled because lodge capacity was no longer available. The saved-card charge was captured, but its refund could not be confirmed; automatic refund recovery is pending and admins have been alerted.",
          status: "CANCELLED",
          refunded: false,
          refundRecoveryPending: true,
          paymentReceived: true,
        },
        { status: 409 }
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
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    logger.error({ err, bookingId }, "Failed to confirm pending guests");
    return NextResponse.json(
      { error: "Failed to confirm pending guests" },
      { status: 500 }
    );
  }
}
