import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { checkCapacityForGuestRanges } from "./capacity";
import { chargePaymentMethod } from "./stripe";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "./xero-operation-outbox";
import {
  sendBookingConfirmedEmail,
  sendBookingBumpedEmail,
  sendBookingGuestsRemovedEmail,
  sendBookingGuestsCancelledEmail,
  sendAdminPaymentFailureAlert,
  sendAdminBookingRequestHoldExpiredEmail,
} from "./email";
import { processWaitlistForDates } from "./waitlist";
import logger from "@/lib/logger";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { applyPartialBumpInTransaction } from "@/lib/partial-bump";
import { deletePromoRedemptionAndAdjustCount } from "@/lib/promo";
import { revokePaymentLinksForBooking } from "@/lib/payment-link";

/** How long to extend the hold for request-origin bookings (no saved card) at hold expiry. */
const REQUEST_HOLD_EXTENSION_MS = 2 * 24 * 60 * 60 * 1000;

export interface CronConfirmResult {
  confirmedBookingIds: string[];
  bumpedBookingIds: string[];
  // Bookings whose non-member guests were dropped at hold expiry (the new
  // default) but kept their member guests and continued.
  partialBumpedBookingIds: string[];
  failedBookingIds: string[];
}

/**
 * Process pending bookings that have reached their hold deadline.
 *
 * For each PENDING booking where nonMemberHoldUntil <= now():
 * 1. Re-check bed availability for the booking's date range
 * 2. If beds available AND saved payment method exists:
 *    - Charge the saved PaymentMethod via Stripe
 *    - Set status to CONFIRMED
 *    - Send confirmation email
 * 3. If beds NOT available:
 *    - Set status to BUMPED
 *    - Send bumped notification email
 */
export async function confirmPendingBookings(): Promise<CronConfirmResult> {
  const now = new Date();

  // Find all PENDING bookings past their hold deadline
  const pendingBookings = await prisma.booking.findMany({
    where: {
      status: BookingStatus.PENDING,
      nonMemberHoldUntil: { lte: now },
    },
    include: {
      member: true,
      guests: true,
      payment: true,
      originBookingRequest: { select: { id: true } },
      promoRedemption: {
        include: {
          guestTargets: { select: { bookingGuestId: true } },
          promoCode: {
            include: { assignments: { select: { memberId: true } } },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" }, // Process oldest first
  });

  const result: CronConfirmResult = {
    confirmedBookingIds: [],
    bumpedBookingIds: [],
    partialBumpedBookingIds: [],
    failedBookingIds: [],
  };

  type PendingBooking = (typeof pendingBookings)[number];

  // Whole-booking bump at hold expiry. `flagged` distinguishes the member's
  // explicit "only book if my guests can come" cancellation (distinct email)
  // from a regular bump. Uses the status-claim pattern for idempotency and
  // never charges/refunds — the booking is still PENDING (uncharged).
  const bumpWholeBookingAtHoldExpiry = async (
    booking: PendingBooking,
    { flagged }: { flagged: boolean }
  ): Promise<boolean> => {
    const claimed = await prisma.booking.updateMany({
      where: { id: booking.id, status: BookingStatus.PENDING },
      data: { status: BookingStatus.BUMPED },
    });
    if (claimed.count === 0) {
      logger.info(
        { bookingId: booking.id, job: "confirmPendingBookings" },
        "Booking already processed by another handler"
      );
      return false;
    }

    await reconcileBedAllocationsForBooking({
      bookingId: booking.id,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    // Clean up the promo redemption (re-read so a partial bump's recalculated
    // redemption is also handled). No redemption count is restored to a charge
    // because nothing was ever charged.
    const promoRedemption = await prisma.promoRedemption.findUnique({
      where: { bookingId: booking.id },
    });
    if (promoRedemption) {
      await prisma.$transaction((tx) =>
        deletePromoRedemptionAndAdjustCount(tx, promoRedemption)
      );
    }

    result.bumpedBookingIds.push(booking.id);

    try {
      if (flagged) {
        await sendBookingGuestsCancelledEmail(
          booking.member.email,
          booking.member.firstName,
          booking.checkIn,
          booking.checkOut
        );
      } else {
        await sendBookingBumpedEmail(
          booking.member.email,
          booking.member.firstName,
          booking.checkIn,
          booking.checkOut,
          booking.guests.length
        );
      }
    } catch (emailErr) {
      logger.error(
        { err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" },
        "Failed to send bumped email"
      );
    }

    // Trigger waitlist processing for dates freed by bumping
    processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut }).catch(
      (err) =>
        logger.error(
          { err, bookingId: booking.id },
          "Failed to process waitlist after cron bump"
        )
    );

    return true;
  };

  for (const booking of pendingBookings) {
    let chargeAttempted = false;
    let paymentSucceeded = false;
    // Set when the default partial bump has dropped this booking's non-member
    // guests and the remaining member booking still fits — the charge/confirm
    // logic below then settles the reduced amount and sends the "guests didn't
    // fit, your booking continues" email instead of the standard confirmation.
    let isPartialBump = false;

    try {
      // Check capacity (excluding this booking since it's already counted as PENDING)
      const capacityCheck = await checkCapacityForGuestRanges(
        booking.checkIn,
        booking.checkOut,
        booking.guests,
        booking.id
      );

      if (!capacityCheck.available) {
        // Request-origin bookings (#707) are never partially bumped: they pay
        // via a tokenised PaymentLink and have no member guest to keep. Whole-
        // cancel and revoke the link so it can't be paid after the bump.
        if (booking.originBookingRequest) {
          const bumped = await bumpWholeBookingAtHoldExpiry(booking, {
            flagged: false,
          });
          if (bumped) {
            await revokePaymentLinksForBooking(booking.id);
          }
          continue;
        }

        const nonMemberGuests = booking.guests.filter((g) => !g.isMember);
        const memberGuests = booking.guests.filter((g) => g.isMember);

        // Flagged ("only book if my guests can come"), or no member/non-member
        // split to keep => whole-booking cancellation. Otherwise partial bump.
        const wholeCancel =
          booking.cancelIfGuestsBumped ||
          nonMemberGuests.length === 0 ||
          memberGuests.length === 0;

        if (wholeCancel) {
          await bumpWholeBookingAtHoldExpiry(booking, {
            flagged: booking.cancelIfGuestsBumped,
          });
          continue;
        }

        // Default: drop the non-member guests, keep the members, reprice.
        const partial = await prisma.$transaction((tx) =>
          applyPartialBumpInTransaction({ tx, booking })
        );

        if (partial.kind !== "partial") {
          // already-processed, or (defensively) nothing to partially keep.
          if (partial.kind === "already-processed") {
            logger.info(
              { bookingId: booking.id, job: "confirmPendingBookings" },
              "Booking already processed by another handler"
            );
            continue;
          }
          await bumpWholeBookingAtHoldExpiry(booking, { flagged: false });
          continue;
        }

        // Re-check capacity for the reduced, members-only booking.
        const reducedCapacity = await checkCapacityForGuestRanges(
          booking.checkIn,
          booking.checkOut,
          partial.remainingGuests,
          booking.id
        );

        if (!reducedCapacity.available) {
          // Members alone still don't fit => fall back to a whole-booking bump.
          await bumpWholeBookingAtHoldExpiry(booking, { flagged: false });
          continue;
        }

        // The reduced booking fits and continues. Update the in-memory booking
        // so the charge/confirm logic below settles the reduced amount.
        booking.totalPriceCents = partial.newTotalPriceCents;
        booking.discountCents = partial.newDiscountCents;
        booking.promoAdjustmentCents = partial.newPromoAdjustmentCents;
        booking.finalPriceCents = partial.newFinalPriceCents;
        booking.guests = partial.remainingGuests;
        booking.hasNonMembers = false;
        booking.nonMemberHoldUntil = null;
        if (partial.promoRemoved) {
          booking.promoRedemption = null;
        }
        isPartialBump = true;
        result.partialBumpedBookingIds.push(booking.id);

        // No saved payment method (e.g. request-origin bookings, #707): never
        // charge them here. Move the members-only booking to PAYMENT_PENDING
        // (mirroring the admin "confirm pending guests" path) so it is routed
        // to payment-owed rather than stranded in PENDING with its hold cleared
        // — the cron filters on nonMemberHoldUntil, so a null-hold PENDING row
        // would never be revisited. Idempotent via the status-claim.
        if (
          booking.finalPriceCents > 0 &&
          (!booking.payment?.stripePaymentMethodId ||
            !booking.payment?.stripeCustomerId)
        ) {
          const claimedPaymentOwed = await prisma.booking.updateMany({
            where: { id: booking.id, status: BookingStatus.PENDING },
            data: { status: BookingStatus.PAYMENT_PENDING },
          });
          if (claimedPaymentOwed.count === 0) {
            logger.info(
              { bookingId: booking.id, job: "confirmPendingBookings" },
              "Booking already processed by another handler"
            );
            continue;
          }
          booking.status = BookingStatus.PAYMENT_PENDING;

          try {
            await sendBookingGuestsRemovedEmail(
              booking.member.email,
              booking.member.firstName,
              booking.checkIn,
              booking.checkOut,
              booking.guests.length,
              booking.finalPriceCents
            );
          } catch (emailErr) {
            logger.error(
              { err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" },
              "Failed to send guests-removed email"
            );
          }

          // Non-member beds were freed; let the waitlist take them.
          processWaitlistForDates({
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
          }).catch((err) =>
            logger.error(
              { err, bookingId: booking.id },
              "Failed to process waitlist after cron partial bump"
            )
          );

          continue;
        }

        // Otherwise fall through to the $0 / saved-card charge logic, which
        // confirms the reduced booking and (because isPartialBump) sends the
        // guests-removed email.
      }

      // Zero-dollar booking: skip Stripe, just confirm with a SUCCEEDED Payment
      if (booking.finalPriceCents === 0) {
        const claimed = await prisma.booking.updateMany({
          where: { id: booking.id, status: BookingStatus.PENDING },
          data: { status: BookingStatus.PAID },
        });
        if (claimed.count === 0) {
          logger.info({ bookingId: booking.id, job: "confirmPendingBookings" }, "Booking already processed by another handler");
          continue;
        }
        await reconcileBedAllocationsForBooking({
          bookingId: booking.id,
          previousRange: {
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
          },
        });

        if (booking.payment) {
          await prisma.payment.update({
            where: { bookingId: booking.id },
            data: { status: "SUCCEEDED", amountCents: 0 },
          });
        } else {
          await prisma.payment.create({
            data: { bookingId: booking.id, amountCents: 0, status: "SUCCEEDED" },
          });
        }

        result.confirmedBookingIds.push(booking.id);

        try {
          const queuedInvoice = await enqueueXeroBookingInvoiceOperation(booking.id);
          if (queuedInvoice.queueOperationId) {
            await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
            logger.info(
              { bookingId: booking.id, job: "confirmPendingBookings" },
              "Xero invoice queued for $0 booking"
            );
          }
        } catch (xeroErr) {
          logger.error({ err: xeroErr, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to queue Xero invoice for $0 booking");
        }

        try {
          if (isPartialBump) {
            await sendBookingGuestsRemovedEmail(
              booking.member.email,
              booking.member.firstName,
              booking.checkIn,
              booking.checkOut,
              booking.guests.length,
              booking.finalPriceCents
            );
          } else {
            await sendBookingConfirmedEmail(
              booking.member.email,
              booking.member.firstName,
              booking.checkIn,
              booking.checkOut,
              booking.guests.length,
              booking.finalPriceCents,
              booking.promoRedemption?.promoCode
                ? {
                    discountCents: booking.discountCents,
                    promoAdjustmentCents: booking.promoAdjustmentCents,
                    promoCode: booking.promoRedemption.promoCode.code,
                  }
                : undefined
            );
          }
        } catch (emailErr) {
          logger.error({ err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to send confirmation email for $0 booking");
        }

        continue;
      }

      // Beds available - try to charge saved payment method
      if (!booking.payment?.stripePaymentMethodId || !booking.payment?.stripeCustomerId) {
        if (booking.originBookingRequest) {
          // Request-origin bookings (#707) pay via a tokenised PaymentLink, not
          // a saved card - never auto-charge them. Extend the hold so the
          // booking stays PENDING (capacity-protected) and alert admins to
          // follow up with the requester.
          const extendedHoldUntil = new Date(
            now.getTime() + REQUEST_HOLD_EXTENSION_MS
          );
          const claimed = await prisma.booking.updateMany({
            where: {
              id: booking.id,
              status: BookingStatus.PENDING,
              nonMemberHoldUntil: booking.nonMemberHoldUntil,
            },
            data: { nonMemberHoldUntil: extendedHoldUntil },
          });

          if (claimed.count > 0) {
            try {
              await sendAdminBookingRequestHoldExpiredEmail({
                requesterName: `${booking.member.firstName} ${booking.member.lastName}`,
                checkIn: booking.checkIn,
                checkOut: booking.checkOut,
                guestCount: booking.guests.length,
                totalCents: booking.finalPriceCents,
                holdUntil: extendedHoldUntil,
              });
            } catch (emailErr) {
              logger.error(
                { err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" },
                "Failed to send admin hold-expired alert"
              );
            }
          }

          continue;
        }

        logger.error({ bookingId: booking.id, job: "confirmPendingBookings" }, "Booking has no saved payment method - cannot auto-confirm");
        result.failedBookingIds.push(booking.id);
        continue;
      }

      // Charge the saved card
      chargeAttempted = true;
      const paymentIntent = await chargePaymentMethod({
        amountCents: booking.finalPriceCents,
        customerId: booking.payment.stripeCustomerId,
        paymentMethodId: booking.payment.stripePaymentMethodId,
        metadata: {
          bookingId: booking.id,
          memberId: booking.memberId,
        },
        idempotencyKey: `pending_charge_${booking.id}`,
      });

      if (paymentIntent.status === "succeeded") {
        paymentSucceeded = true;
        const reconciliation = await markBookingPaymentSucceeded({
          bookingId: booking.id,
          paymentIntentId: paymentIntent.id,
          amountCents: paymentIntent.amount,
          paymentMethodId:
            typeof paymentIntent.payment_method === "string"
              ? paymentIntent.payment_method
              : paymentIntent.payment_method?.id ?? null,
        });

        if (
          reconciliation.outcome === "cancelled_refunded" ||
          reconciliation.outcome === "cancelled_refund_failed"
        ) {
          logger.warn(
            {
              bookingId: booking.id,
              paymentIntentId: paymentIntent.id,
              outcome: reconciliation.outcome,
              job: "confirmPendingBookings",
            },
            "Pending booking payment succeeded but final capacity claim failed"
          );
          result.failedBookingIds.push(booking.id);
          continue;
        }

        result.confirmedBookingIds.push(booking.id);

        // Queue the invoice durably and let the worker handle the actual Xero write.
        try {
          const queuedInvoice = await enqueueXeroBookingInvoiceOperation(booking.id);
          if (queuedInvoice.queueOperationId) {
            await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
            logger.info(
              { bookingId: booking.id, job: "confirmPendingBookings" },
              "Xero invoice queued"
            );
          }
        } catch (xeroErr) {
          logger.error({ err: xeroErr, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to queue Xero invoice");
        }

        try {
          if (isPartialBump) {
            await sendBookingGuestsRemovedEmail(
              booking.member.email,
              booking.member.firstName,
              booking.checkIn,
              booking.checkOut,
              booking.guests.length,
              booking.finalPriceCents
            );
          } else {
            await sendBookingConfirmedEmail(
              booking.member.email,
              booking.member.firstName,
              booking.checkIn,
              booking.checkOut,
              booking.guests.length,
              booking.finalPriceCents,
              booking.promoRedemption?.promoCode
                ? {
                    discountCents: booking.discountCents,
                    promoAdjustmentCents: booking.promoAdjustmentCents,
                    promoCode: booking.promoRedemption.promoCode.code,
                  }
                : undefined
            );
          }
        } catch (emailErr) {
          logger.error({ err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to send confirmation email");
        }
      } else {
        // Payment is processing (requires_action, etc.) - revert to PENDING for webhook to handle
        await prisma.$transaction(async (tx) => {
          await upsertPaymentIntentTransaction({
            paymentId: booking.payment!.id,
            kind: PaymentTransactionKind.PRIMARY,
            paymentIntentId: paymentIntent.id,
            amountCents: paymentIntent.amount,
            status: PaymentStatus.PROCESSING,
            paymentMethodId:
              typeof paymentIntent.payment_method === "string"
                ? paymentIntent.payment_method
                : paymentIntent.payment_method?.id ?? null,
            reason: "pending_hold_auto_charge",
            store: tx,
          });

          await tx.booking.update({
            where: { id: booking.id },
            data: { status: BookingStatus.PENDING },
          });
          await reconcileBedAllocationsForBooking({
            bookingId: booking.id,
            db: tx,
            previousRange: {
              checkIn: booking.checkIn,
              checkOut: booking.checkOut,
            },
          });
        });

        // Will be resolved by Stripe webhook
        logger.info({ bookingId: booking.id, paymentStatus: paymentIntent.status, job: "confirmPendingBookings" }, "Booking payment processing");
      }
    } catch (err) {
      logger.error({ err, bookingId: booking.id, job: "confirmPendingBookings" }, "Error processing pending booking");

      // Only roll back the booking when Stripe never confirmed a successful charge.
      if (!paymentSucceeded) {
        await prisma.booking.updateMany({
          where: { id: booking.id, status: BookingStatus.PAID },
          data: { status: BookingStatus.PENDING },
        }).catch((revertErr) => logger.error({ err: revertErr, bookingId: booking.id, job: "confirmPendingBookings" }, "Failed to revert booking status"));
      } else {
        logger.error(
          { bookingId: booking.id, job: "confirmPendingBookings" },
          "Stripe charge succeeded but local booking reconciliation failed; leaving booking claimed for webhook recovery"
        );
      }

      result.failedBookingIds.push(booking.id);

      // Only emit a payment-failure alert when the Stripe charge attempt itself failed.
      if (chargeAttempted && !paymentSucceeded) {
        sendAdminPaymentFailureAlert({
          memberName: `${booking.member.firstName} ${booking.member.lastName}`,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          amountCents: booking.finalPriceCents,
          errorMessage: err instanceof Error ? err.message : String(err),
          paymentIntentId: booking.payment?.stripePaymentIntentId || "N/A",
        }).catch((alertErr) =>
          logger.error({ err: alertErr, bookingId: booking.id }, "Failed to send admin payment failure alert")
        );
      }
    }
  }

  return result;
}
