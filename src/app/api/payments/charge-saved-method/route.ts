import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { isHostingCoverageParticipantRetry } from "@/lib/adult-member-hosting-queue-participants";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueOwnHostingCoverageReevaluation } from "@/lib/adult-member-hosting-review";
import {
  reconcileBedAllocationsForBookingWithGlobalLockHeld,
  reconcileBedAllocationsForBookingWithLodgeLockHeld,
} from "@/lib/bed-allocation-lifecycle";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { stripeReferenceId } from "@/lib/stripe-references";
import { readStripeErrorFields } from "@/lib/stripe-errors";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { auth } from "@/lib/auth";
import { isValidCronSecret } from "@/lib/cron-auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import logger from "@/lib/logger";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { BookingStatus } from "@prisma/client";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { reusableSavedPaymentMethodOnRow } from "@/lib/saved-payment-method";
import {
  beginSavedCardChargeAttempt,
  SAVED_CARD_CHARGE_REASON,
  SavedCardChargeRefusedError,
} from "@/lib/saved-card-charge-attempt";
import { chargeSavedCardAttempt } from "@/lib/saved-card-charge-request";
import {
  describeUnsettledPaymentIntent,
  settleSavedCardChargeAttempt,
  type SavedCardChargeAnswer,
} from "@/lib/saved-card-charge-settle";
import { hasAdminAccess } from "@/lib/access-roles";
import { PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY } from "@/lib/payment-recovery-contract";

const ChargeSavedMethodSchema = z.object({
  bookingId: z.string().min(1),
});

/**
 * Charge a saved payment method for a pending booking.
 * Used by the cron job when a pending booking auto-confirms at the 7-day mark,
 * or by admin to manually confirm a pending booking.
 *
 * Since #3267 this route takes the SAME claim the settlement cron and the admin
 * confirm-pending-guests route take (#1418): PENDING -> CONFIRMED under global
 * `lock(1)` and the lodge capacity lock BEFORE Stripe is asked anything, with
 * the capacity re-check inside the lock, and the charge ATTEMPT made durable in
 * that same transaction (`beginSavedCardChargeAttempt`, `INV-PAY-055`). Until
 * then it charged with no claim at all, which two things had hidden: the shared
 * `pending_charge_<bookingId>` Stripe key stood in for the double-charge guard,
 * and CONFIRMED-before-charge was what kept a concurrent cron bump from
 * cancelling the booking under a charge in flight. With the key gone, the
 * ledger guard only holds if every path writes its attempt row under the same
 * locks — so this route joins the claim. The locks are released before Stripe.
 */
export async function POST(request: NextRequest) {
  let paymentSucceeded = false;
  let finalCapacityClaimed = false;
  let isAuthorizedCron = false;
  let isAdmin = false;
  let capturedPaymentIntentId: string | null = null;
  let capturedPaymentContext: {
    paymentIntentId: string;
    memberName: string;
    checkIn: Date;
    checkOut: Date;
    amountCents: number;
  } | null = null;
  // The claim, once committed: what the outer catch must hand back when the
  // charge does not capture, and what the alert is about.
  let claimReleaser: (() => Promise<void>) | null = null;
  let chargeAttempted = false;
  let attemptAlertContext: {
    memberName: string;
    checkIn: Date;
    checkOut: Date;
    amountCents: number;
    bookingId: string;
  } | null = null;

  try {
    // This endpoint is called by internal cron or admin
    isAuthorizedCron = isValidCronSecret(
      request.headers.get("x-cron-secret")
    );

    const session = await auth();

    if (session?.user?.id) {
      const inactiveResponse = await requireActiveSessionUser(session.user.id);
      if (inactiveResponse && !isAuthorizedCron) {
        return inactiveResponse;
      }

      if (!inactiveResponse) {
        isAdmin = hasAdminAccess(session.user);
      }
    }

    if (!isAuthorizedCron && !isAdmin) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = ChargeSavedMethodSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { bookingId } = parsed.data;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true, member: true, guests: { include: { nights: true } } }, // per-night sets (issue #713)
    });

    if (!booking) {
      return NextResponse.json(
        { error: "Booking not found" },
        { status: 404 }
      );
    }

    if (booking.status !== BookingStatus.PENDING) {
      return NextResponse.json(
        { error: "Booking is not in PENDING status" },
        { status: 400 }
      );
    }

    // #3269 (`INV-PAY-053`): a card is chargeable off-session only with
    // SetupIntent provenance on this booking's OWN row, read through
    // `reusableSavedPaymentMethodOnRow` rather than the split-aware
    // `savedPaymentMethodForBooking`. This route records the capture against
    // the row it read and creates none, so it deliberately offers no
    // split-parent fallback — the settlement cron and the admin
    // confirm-pending-guests route, which upsert the child's row inside their
    // claim, carry that fallback. This pre-lock read decides only the early
    // 400; the card that is CHARGED is re-read under the locks below.
    if (!booking.payment || !reusableSavedPaymentMethodOnRow(booking.payment)) {
      return NextResponse.json(
        { error: "No saved payment method found for this booking" },
        { status: 400 }
      );
    }
    const memberName = `${booking.member.firstName} ${booking.member.lastName}`;
    // lodgeId is immutable, so keying the lock from the pre-lock read is safe
    // (read-key -> lock -> re-read, docs/CONCURRENCY_AND_LOCKING.md).
    const lodgeId = booking.lodgeId ?? (await getDefaultLodgeId(prisma));
    const previousRange = { checkIn: booking.checkIn, checkOut: booking.checkOut };

    // Claim-first (#1418, the cron's `resolveHoldWindowUnderLock` and the admin
    // route's charge branch): claim PENDING -> CONFIRMED under both locks
    // BEFORE the Stripe call, with the capacity re-check consuming the
    // post-lock snapshot. CONFIRMED holds capacity and is out of the cron's
    // bump scope, so a successful charge cannot race a concurrent cron cancel
    // into markBookingPaymentSucceeded's "not payable" throw. #3267: the same
    // transaction makes the charge ATTEMPT durable, which is what stops this
    // route and the other two double-charging one booking now that they no
    // longer share a Stripe key. A payment already holding captured cash throws
    // `SavedCardChargeRefusedError`, rolling the whole claim back.
    const runClaim = () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await acquireLodgeCapacityLock(tx, lodgeId);
        const locked = await tx.booking.findUnique({
          where: { id: bookingId },
          include: { guests: { include: { nights: true } }, payment: true },
        });
        if (!locked || locked.status !== BookingStatus.PENDING) {
          return { error: "Booking is no longer pending" as const, status: 409 };
        }
        // #3267: the card to charge is the one on the row UNDER THE LOCKS, not
        // the pre-lock snapshot — a replacement mint (#3266) or a retire
        // (#3268) between the two reads must change what is charged and what
        // the attempt row records, exactly as the cron derives its card from
        // its own post-lock re-read.
        const lockedCard = reusableSavedPaymentMethodOnRow(locked.payment);
        if (!locked.payment || !lockedCard) {
          return {
            error: "No saved payment method found for this booking" as const,
            status: 409,
          };
        }
        const capacity = await checkCapacityForGuestRanges(
          lodgeId,
          locked.checkIn,
          locked.checkOut,
          locked.guests,
          bookingId,
          tx
        );
        if (!capacity.available && !bookingHasCapacityOverride(locked)) {
          return {
            error: "Lodge capacity is no longer available for this booking." as const,
            status: 409,
          };
        }
        if (!capacity.available) {
          // Persisted capacity override (#1771): admitted above the ceiling by
          // an admin, so do not 409 the charge — proceed. The downstream
          // markBookingPaymentSucceeded re-check honours the same override.
          logger.info(
            { bookingId },
            "Charging an over-capacity booking with a persisted capacity override (#1771); skipping the capacity block"
          );
        }
        const claimed = await tx.booking.updateMany({
          where: { id: bookingId, status: BookingStatus.PENDING },
          data: { status: BookingStatus.CONFIRMED, nonMemberHoldUntil: null },
        });
        if (claimed.count === 0) {
          return { error: "Booking is no longer pending" as const, status: 409 };
        }
        await reconcileBedAllocationsForBookingWithLodgeLockHeld({
          bookingId,
          db: tx,
          previousRange,
        });
        // #2576 §9: "payment completion" is on the owner's list of confirming
        // paths that must re-read the hosting facts. The claim is what reserves
        // the bed before the charge, so the obligation is recorded with it,
        // under the same per-lodge lock every coverage-removing path takes; the
        // drain re-reads the committed facts after commit. Safe against the
        // release below: an incident is only ever opened for a booking whose
        // status is confirmed active attendance.
        await enqueueOwnHostingCoverageReevaluation(bookingId, tx, {
          cause: "SYSTEM_CHANGE",
          ...(isAdmin && session?.user?.id
            ? { actorMemberId: session.user.id }
            : {}),
        });
        const attempt = await beginSavedCardChargeAttempt(tx, {
          paymentId: locked.payment.id,
          bookingId,
          amountCents: locked.finalPriceCents,
          card: lockedCard,
          reason: SAVED_CARD_CHARGE_REASON.chargeSavedMethodRoute,
        });
        return {
          ok: true as const,
          attempt,
          card: lockedCard,
          paymentId: locked.payment.id,
          amountCents: locked.finalPriceCents,
        };
      });

    let claim: Awaited<ReturnType<typeof runClaim>>;
    try {
      claim = await runClaim();
    } catch (claimErr) {
      if (claimErr instanceof SavedCardChargeRefusedError) {
        // Nothing was claimed and nothing charged; a person has to look. The
        // message is the typed domain error's own plain English, written for
        // this response (#1888 F31 permits a typed error's message; never a
        // bare `Error`'s).
        logger.error(
          {
            bookingId,
            why: claimErr.why,
            paymentIntentId: claimErr.paymentIntentId,
            attemptRowId: claimErr.attemptRowId,
          },
          "charge-saved-method: refused to charge (#3267)"
        );
        sendAdminPaymentFailureAlert({
          memberName,
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
        return NextResponse.json(
          { error: claimErr.message, paymentIntentId: claimErr.paymentIntentId },
          { status: 409 }
        );
      }
      throw claimErr;
    }

    if ("error" in claim) {
      return NextResponse.json({ error: claim.error }, { status: claim.status });
    }
    const { paymentId, amountCents, card } = claim;

    // Mirror of the cron's release: only run while Stripe has NOT captured
    // money. Once a charge succeeds the claim is never released — CONFIRMED
    // keeps holding the beds the member just paid for. `answer` is the intent a
    // non-captured branch records on the attempt row inside this same locked
    // transaction, forward only, BEFORE the booking's status is re-read: a
    // `succeeded` webhook that has settled the booking between the retrieve and
    // these locks leaves it PAID, in which case there is nothing to hand back
    // and the release is skipped rather than aimed at a status that is gone.
    // Data, not a callback, so the helper is a plain function of its argument
    // (the transaction-wrapper population in
    // `lock-bound-club-zone-outside-transaction.test.ts` is derived from
    // callback parameters).
    const releaseChargeClaim = async (answer?: {
      attemptRowId: string;
      paymentIntent: SavedCardChargeAnswer;
    }) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await acquireLodgeCapacityLock(tx, lodgeId);
        if (answer) {
          await settleSavedCardChargeAttempt({ ...answer, paymentId, store: tx });
        }
        const current = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { status: true },
        });
        if (current?.status !== BookingStatus.CONFIRMED) {
          // PAID is the expected loser of the race with a settling webhook and
          // is not an anomaly; any other status means another actor took the
          // claim mid-charge, which is what the fence must still shout about
          // (before #3267 that case threw). Same split in the cron and the
          // admin route.
          const releaseLog = {
            bookingId,
            bookingStatus: current?.status ?? null,
          };
          if (current?.status === BookingStatus.PAID) {
            logger.warn(
              releaseLog,
              "charge-saved-method: the booking is already PAID at release; leaving it — the webhook settled it while the charge was in flight (#3267)"
            );
          } else {
            logger.error(
              releaseLog,
              "charge-saved-method: the booking lost its CONFIRMED claim to another actor before the release; leaving it as it is (#3267)"
            );
          }
          return { released: false };
        }
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
        return { released: released.count > 0 };
      });
    claimReleaser = async () => {
      await releaseChargeClaim();
    };
    // The POST-LOCK amount, because that is the one being charged: a price that
    // moved between the pre-lock read and the claim would otherwise make every
    // operator alert on this path name a figure nobody was ever charged.
    attemptAlertContext = {
      memberName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      amountCents,
      bookingId,
    };

    // #2576 §9: drain what the claim recorded, now that it has committed.
    await settleHostingCoverageAfterCommit({ bookingId });

    // The one charge contract every path uses (#3267, `INV-PAY-055`): earlier
    // attempts the claim ended have their intents cancelled best-effort first;
    // a fresh attempt charges under the row's own key; an unresolved earlier
    // attempt (the cron's, or the admin's) is asked about instead of repeated.
    // A DEFINITE refusal ends the attempt row before the throw reaches the
    // catch below, so the next attempt is fresh.
    chargeAttempted = true;
    const paymentIntent = await chargeSavedCardAttempt({
      attempt: claim.attempt,
      bookingId,
      memberId: booking.memberId,
      amountCents,
      card,
    });

    if (paymentIntent.status === "succeeded") {
      paymentSucceeded = true;
      capturedPaymentIntentId = paymentIntent.id;
      capturedPaymentContext = {
        paymentIntentId: paymentIntent.id,
        memberName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents: paymentIntent.amount,
      };
      // Record the capture on the attempt row BEFORE reconciliation, so a
      // promotion failure can always be finished by the Stripe webhook, which
      // finds the row by intent id. Non-fatal: reconciliation upserts the
      // identical row.
      try {
        await settleSavedCardChargeAttempt({
          attemptRowId: claim.attempt.attemptRowId,
          paymentId,
          paymentIntent,
        });
      } catch (recordError) {
        logger.error(
          { err: recordError, bookingId, paymentIntentId: paymentIntent.id },
          "Failed to pre-record captured saved-method charge",
        );
      }
      const reconciliation = await markBookingPaymentSucceeded({
        bookingId,
        paymentIntentId: paymentIntent.id,
        amountCents: paymentIntent.amount,
        paymentMethodId:
          stripeReferenceId(paymentIntent.payment_method),
      });

      if (
        reconciliation.outcome === "cancelled_refunded" ||
        reconciliation.outcome === "cancelled_refund_failed"
      ) {
        return NextResponse.json(
          {
            error:
              "Payment succeeded, but lodge capacity is no longer available for this booking.",
            status: "CANCELLED",
            refunded: reconciliation.outcome === "cancelled_refunded",
          },
          { status: 409 }
        );
      }

      finalCapacityClaimed = true;

      logAudit({
        action: "booking.payment.confirmed",
        category: "payment",
        entityType: "Booking",
        entityId: bookingId,
        memberId: isAdmin ? session?.user?.id : undefined,
        targetId: bookingId,
        details: JSON.stringify({
          paymentIntentId: paymentIntent.id,
          // What Stripe captured, not the pre-lock price snapshot: the same
          // reason the alerts above moved off `booking.finalPriceCents`.
          amountCents: paymentIntent.amount,
          source: isAuthorizedCron ? "cron" : "admin",
        }),
        ipAddress:
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown",
      });
    } else {
      // The intent exists but did not capture (3DS challenge outstanding, still
      // processing, or — on a replay — an earlier attempt that has since died).
      // Record what Stripe answered on the attempt row inside the locked
      // release, forward only, then hand the claim back if it is still ours:
      // the booking returns to PENDING with its hold restored, and the webhook
      // — or the next attempt — resolves it.
      await releaseChargeClaim({
        attemptRowId: claim.attempt.attemptRowId,
        paymentIntent,
      });
      claimReleaser = null;
      const account = describeUnsettledPaymentIntent(paymentIntent.status);
      logger.warn(
        { bookingId, piStatus: paymentIntent.status, memberId: booking.memberId },
        "Off-session charge did not capture — booking returned to PENDING (#3267)"
      );
      // Alert admins so they can contact the member to complete payment
      // manually — with the amount that was actually asked for (the post-lock
      // claim's), not the pre-lock snapshot's.
      sendAdminPaymentFailureAlert({
        memberName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        amountCents,
        errorMessage: account,
        paymentIntentId: paymentIntent.id,
      }).catch(() => {});
      // Say what actually happened. Before #3267 this branch answered
      // `success: true` with the intent's status, which read as a capture.
      return NextResponse.json(
        {
          success: false,
          error: account,
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
        },
        { status: 409 }
      );
    }

    // Queue the invoice durably and try to kick the worker when payment succeeds.
    if (paymentIntent.status === "succeeded" && finalCapacityClaimed) {
      try {
        const queuedInvoice = await enqueueXeroBookingInvoiceOperation(booking.id, {
          createdByMemberId: session?.user?.id,
        });

        if (queuedInvoice.queueOperationId) {
          await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
          logger.info({ bookingId: booking.id }, "Xero invoice queued for booking");
        }
      } catch (xeroErr) {
        logger.error({ err: xeroErr, bookingId: booking.id }, "Failed to queue Xero invoice for booking");
      }
    }

    return NextResponse.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (error) {
    logger.error({ err: error }, "Error charging saved method");

    // A claim that committed but never captured is handed back (#1418 /
    // #3267): CONFIRMED -> PENDING with the hold restored, beds reconciled.
    // Never after a capture — CONFIRMED keeps the beds the member paid for.
    if (claimReleaser && !paymentSucceeded) {
      await claimReleaser().catch((revertErr) =>
        logger.error(
          { err: revertErr },
          "Failed to release charge-saved-method charge claim"
        )
      );
    }

    // A charge that THREW with nothing captured: admins hear about it, in
    // Stripe's own words when Stripe spoke (INV-INT-004). The attempt row has
    // already been ended for a definite refusal, or left for the next attempt
    // to ask about.
    if (chargeAttempted && !paymentSucceeded && attemptAlertContext) {
      sendAdminPaymentFailureAlert({
        memberName: attemptAlertContext.memberName,
        checkIn: attemptAlertContext.checkIn,
        checkOut: attemptAlertContext.checkOut,
        amountCents: attemptAlertContext.amountCents,
        errorMessage: readStripeErrorFields(error).message,
        paymentIntentId: "N/A",
      }).catch((alertError) =>
        logger.error(
          { err: alertError, bookingId: attemptAlertContext?.bookingId },
          "Failed to send admin payment failure alert",
        ),
      );
    }

    const hostingParticipantRetry = isHostingCoverageParticipantRetry(error);
    if (hostingParticipantRetry && capturedPaymentContext) {
      sendAdminPaymentFailureAlert({
        ...capturedPaymentContext,
        errorMessage:
          "The saved-method charge succeeded but booking finalisation was deferred by a concurrent member change. The Stripe webhook will retry; review manually if it remains pending.",
      }).catch((alertError) =>
        logger.error(
          { err: alertError, paymentIntentId: capturedPaymentIntentId },
          "Failed to alert admins about captured saved-method charge awaiting finalisation",
        ),
      );
    }

    if (!hostingParticipantRetry && capturedPaymentContext) {
      sendAdminPaymentFailureAlert({
        ...capturedPaymentContext,
        errorMessage:
          "The saved-method charge succeeded, but the booking status could not be confirmed after a local error. Check the booking and payment status before retrying any charge.",
      }).catch((alertError) =>
        logger.error(
          { err: alertError, paymentIntentId: capturedPaymentIntentId },
          "Failed to alert admins about a captured saved-method charge with unconfirmed booking status",
        ),
      );
    }

    if (isAuthorizedCron && hostingParticipantRetry) {
      throw error;
    }

    if (isAdmin && paymentSucceeded && hostingParticipantRetry) {
      const hostingRetry = hostingCoverageParticipantRetryResponse(error, {
        paymentReceived: true,
        finalisationPending: true,
      });
      if (hostingRetry) return hostingRetry;
    }

    if (paymentSucceeded && capturedPaymentIntentId) {
      return NextResponse.json(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY, {
        status: 409,
      });
    }

    if (!paymentSucceeded) {
      logAudit({
        action: "booking.payment.failed",
        category: "payment",
        details: JSON.stringify({
          errorMessage:
            error instanceof Error
              ? error.message
              : "Failed to charge saved payment method",
        }),
        ipAddress:
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            "unknown",
      });
    }

    return NextResponse.json(
      { error: "Failed to charge saved payment method" },
      { status: 500 }
    );
  }
}
