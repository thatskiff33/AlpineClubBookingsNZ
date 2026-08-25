import {
  BookingEventType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";

import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueOwnHostingCoverageReevaluation } from "@/lib/adult-member-hosting-review";
import {
  reconcileBedAllocationsForBookingWithGlobalLockHeld,
  reconcileBedAllocationsForBookingWithLodgeLockHeld,
} from "@/lib/bed-allocation-lifecycle";
import { recordBookingEvent } from "@/lib/booking-events";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { recordWithheldBookingEmail } from "@/lib/booking-email-suppression";
import logger from "@/lib/logger";
import {
  mintSplitGuestPaymentLinkIfAbsent,
  revokePaymentLinkById,
  revokePaymentLinksForBooking,
  type MintedSplitGuestPaymentLink,
} from "@/lib/payment-link";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  paymentLinkExpiryForCheckIn,
  type ClubTimeZone,
} from "@/lib/payment-link-expiry";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { deletePromoRedemptionAndAdjustCount } from "@/lib/promo";
import { prisma } from "./prisma";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "./capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { cancelPaymentIntentIfCancellable, chargePaymentMethod } from "./stripe";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "./xero-operation-outbox";
import {
  sendAdminBookingRequestHoldCancelledEmail,
  sendAdminBookingRequestHoldExpiredEmail,
  sendAdminPaymentFailureAlert,
  sendAdminSplitSettlementCancelledAlert,
  sendAdminSplitSettlementUnpaidAlert,
  sendBookingBumpedEmail,
  sendBookingConfirmedEmail,
  sendBookingGuestsCancelledEmail,
  sendBookingRequestPaymentExpiredEmail,
  sendSplitGuestPaymentLinkEmail,
  sendSplitGuestPortionCancelledEmail,
} from "./email";
import { bookingPromoEmailOptions } from "./booking-promo-email-options";
import { getNonMemberHoldDays } from "./cancellation";
import { processWaitlistForDates } from "./waitlist";

/** How long to extend the hold for request-origin bookings (no saved card) at hold expiry. */
/** Registry template the split-guest pay-link email ships as (#1967). */
const SPLIT_GUEST_PAYMENT_LINK_TEMPLATE = "split-guest-payment-link";

const REQUEST_HOLD_EXTENSION_MS = 2 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * #1993 Part B — derived admin-alert cadence for a split child's unpaid
 * guest-portion hold. Pure function of elapsed time (NO schema, NO counter):
 * the returned 1-based number identifies which ~2-day extension window `now`
 * falls in, measured from the hold's ORIGINAL (first) expiry. Idempotency is
 * preserved by the extension CAS upstream — exactly one cron run wins per
 * window, and within a window `now` maps to a stable number, so a rerun in the
 * same window never re-alerts.
 *
 * #2012 reuses this generic ~2-day-window helper unchanged for the request-hold
 * (#707) admin-alert stream — both holds extend by REQUEST_HOLD_EXTENSION_MS, so
 * the window math is identical. Kept split-settlement-named (not renamed) so the
 * existing call sites and tests stay byte-equivalent.
 */
export function splitSettlementExtensionNumber(
  originalHoldExpiry: Date,
  now: Date
): number {
  const elapsed = now.getTime() - originalHoldExpiry.getTime();
  if (elapsed <= 0) return 1;
  return Math.floor(elapsed / REQUEST_HOLD_EXTENSION_MS) + 1;
}

/**
 * #1993 Part B — alert on extension windows 1, 2, 3, then every 7th window
 * thereafter (…, 7, 14, 21). Caps the previously-uncapped ~2-daily admin alert
 * while the guest portion stays unsettled. With Part A's terminal auto-cancel
 * at check-in, this only governs the bounded pre-check-in window.
 */
export function shouldAlertOnSplitSettlementExtension(
  extensionNumber: number
): boolean {
  return extensionNumber <= 3 || extensionNumber % 7 === 0;
}

/**
 * The ledger `reason` this cron stamps on its own saved-card charge
 * transactions. Load-bearing for #1992: the pre-charge link-intent sweep keys
 * its EXCLUSION on this reason, because a prior run's still-PROCESSING
 * auto-charge intent is re-returned by Stripe under the shared
 * `pending_charge_<bookingId>` idempotency key when this run charges — so
 * cancelling it here would cancel this run's own charge.
 */
const PENDING_HOLD_AUTO_CHARGE_REASON = "pending_hold_auto_charge";

/**
 * The ledger `reason` the charge-saved-method route stamps on a saved-card
 * charge left PROCESSING by a 3DS/SCA challenge
 * (src/app/api/payments/charge-saved-method/route.ts). That route mints its
 * intent under the SAME `pending_charge_<bookingId>` Stripe idempotency key
 * this cron replays, so the #1992 pre-charge sweep must never cancel such a
 * row either: Stripe would answer this cron's idempotent charge with the
 * cancelled intent and the settlement would stall until the key expires
 * (~24h). Keep this in sync with the route's literal.
 */
const PENDING_SAVED_METHOD_CHARGE_REASON = "pending_saved_method_charge";

const pendingBookingInclude = {
  member: true,
  // Per-night sets (issue #713) for accurate capacity re-check at the hold window.
  guests: { include: { nights: true } },
  payment: true,
  parentBooking: {
    include: {
      payment: true,
    },
  },
  // #1967: a #796 group joiner also carries parentBookingId (the organiser's
  // booking) but always has a GroupBookingJoin row written atomically with its
  // creation — this is the discriminator that keeps joiners out of the
  // split-guest settlement branch.
  groupBookingJoin: { select: { id: true } },
  originBookingRequest: { select: { id: true } },
  promoRedemption: {
    include: {
      guestTargets: { select: { bookingGuestId: true } },
      promoCode: {
        include: { assignments: { select: { memberId: true } } },
      },
    },
  },
} satisfies Prisma.BookingInclude;

type PendingBooking = Prisma.BookingGetPayload<{
  include: typeof pendingBookingInclude;
}>;

type SavedPaymentMethod = {
  stripeCustomerId: string;
  stripePaymentMethodId: string;
};

type HoldResolution =
  | { type: "already_processed" }
  | { type: "bumped"; booking: PendingBooking; flagged: boolean }
  | { type: "confirmed_zero"; booking: PendingBooking }
  | {
      type: "extended_request_hold";
      booking: PendingBooking;
      extendedHoldUntil: Date;
    }
  | {
      // #2012 (symmetric twin of #1993 Part A) — terminal state for a booking
      // created from an approved public booking request (#707) still PENDING
      // (unpaid, no saved card) once its check-in day has ended. UNLIKE the
      // split child, this booking HOLDS REAL CAPACITY (AWAITING_REVIEW -> PENDING
      // on approval keeps the beds reserved), so the terminal action must RELEASE
      // that capacity: the guarded PENDING -> CANCELLED CAS, bed reconcile
      // (release), promo cleanup and link revocation commit inside the lock
      // transaction; the CANCELLED narrative event, the requester's payment-
      // expired email, ONE final admin notice and the waitlist wake fire
      // post-commit. The request row stays CONVERTED (it is a historical fact
      // that a booking was created); the booking's own CANCELLED status is the
      // capacity source of truth. A PAID/CONFIRMED booking is never reached (it
      // is not PENDING) — a concurrent /pay settlement wins the CAS cleanly.
      type: "request_hold_terminal_cancelled";
      booking: PendingBooking;
    }
  | { type: "missing_payment_method"; booking: PendingBooking }
  | {
      type: "split_child_payment_link";
      booking: PendingBooking;
      extendedHoldUntil: Date;
      // The freshly minted link (raw token + row id) when THIS run minted one
      // (the caller emails the member, and revokes the link by id if that
      // email fails so the next run re-mints). Null when an active link
      // already existed — the member was emailed on a prior run, so the
      // caller sends no member email; the admin alert fires either way.
      mintedLink: MintedSplitGuestPaymentLink | null;
      // #2258: the booking's "No emails" switch withheld the link email, so
      // nothing was minted at all. The hold extension and the admin alert still
      // run — an operator must still learn the guest portion is unpaid — but no
      // PaymentLink row is created and no member email is attempted.
      emailWithheld: boolean;
      // When the current "No emails" episode began, so the withheld record is
      // written once per episode rather than once ever (#2258).
      noEmailsAt: Date | null;
    }
  | {
      // A genuine split child with no saved card whose PARENT is not settled
      // (e.g. an abandoned card PAYMENT_PENDING parent): the member's own
      // place is unpaid, so no guest payment link is minted or emailed — the
      // guest portion must not become settleable ahead of the member's own
      // place. The hold extension is the alert-cadence claim.
      type: "split_child_parent_unpaid";
      booking: PendingBooking;
      extendedHoldUntil: Date;
    }
  | {
      // #1993 Part A (owner-selected Option 1) — terminal state for a split
      // non-member child still PENDING (unsettled, no saved card) once its
      // check-in day has ended. The child holds no capacity, so this is
      // bookkeeping + notification, not a capacity change: the guarded
      // PENDING -> CANCELLED CAS, link revocation and bed reconcile commit
      // inside the lock transaction; the CANCELLED narrative event, the member
      // cancellation email and ONE final admin notice fire post-commit (the
      // event write must not sit in-tx — see booking-events.ts).
      // A PAID child is never reached (it is not PENDING); the parent is never
      // touched; there is no Xero void (an unsettled child has no invoice).
      // `parentUnpaid` only selects the admin-notice wording.
      type: "split_child_terminal_cancelled";
      booking: PendingBooking;
      parentUnpaid: boolean;
    }
  | {
      type: "claimed_for_charge";
      booking: PendingBooking;
      payment: SavedPaymentMethod;
      paymentId: string;
      previousHoldUntil: Date | null;
    };

export interface CronConfirmResult {
  confirmedBookingIds: string[];
  bumpedBookingIds: string[];
  // #1993 Part A: split non-member children auto-cancelled at end of check-in
  // day while still unsettled (PENDING, no saved card). #2012: also request-
  // origin bookings (#707) still unpaid past check-in — those additionally
  // RELEASE held capacity (bed reconcile + waitlist wake). Distinct from bumped
  // (capacity loss) and failed (processing error) — a clean terminal cancel.
  cancelledBookingIds: string[];
  // Retained for response-shape stability. The cron no longer partial-bumps at
  // hold expiry (issue #737): members pay up front, so there is no reduced
  // members-only amount to settle here. Always empty.
  partialBumpedBookingIds: string[];
  failedBookingIds: string[];
}

/**
 * #1993 Part B — the split child's ORIGINAL (first) hold expiry, the anchor for
 * the derived alert cadence. Derived, not stored: the hold was minted at
 * `checkIn - holdDays` (booking-create), read back here from the same policy
 * source (`getNonMemberHoldDays`). Clamped to `createdAt` so a last-minute
 * child (booked inside the hold window, whose hold was born already expired)
 * anchors at creation rather than a phantom pre-creation expiry — otherwise its
 * very first extension run would compute a high index and skip the first alert.
 * Stable across cron reruns (all inputs are immutable booking/policy values),
 * which is what keeps the cadence idempotent.
 *
 * #2012 reuses this anchor for request-origin holds. Their true first expiry is
 * `max(checkIn - holdDays, approvalTime + minimum hold)` and the approval time
 * is not stored on the Booking, so for a request approved inside the hold
 * window the computed window index can run ~1 high — which under the
 * 1,2,3-then-every-7th rule can only SKIP an early alert, never spam or break
 * the cap. Accepted imprecision; a request-specific anchor would need the
 * approval timestamp persisted.
 */
async function resolveOriginalHoldExpiry(
  booking: PendingBooking
): Promise<Date> {
  const holdDays = await getNonMemberHoldDays(booking.checkIn, booking.lodgeId);
  const scheduledFirstExpiry = booking.checkIn.getTime() - holdDays * DAY_MS;
  return new Date(Math.max(scheduledFirstExpiry, booking.createdAt.getTime()));
}

function savedPaymentMethodForBooking(
  booking: PendingBooking
): SavedPaymentMethod | null {
  if (booking.payment?.stripeCustomerId && booking.payment.stripePaymentMethodId) {
    return {
      stripeCustomerId: booking.payment.stripeCustomerId,
      stripePaymentMethodId: booking.payment.stripePaymentMethodId,
    };
  }

  const parentPayment = booking.parentBooking?.payment;
  if (parentPayment?.stripeCustomerId && parentPayment.stripePaymentMethodId) {
    return {
      stripeCustomerId: parentPayment.stripeCustomerId,
      stripePaymentMethodId: parentPayment.stripePaymentMethodId,
    };
  }

  return null;
}

async function queueXeroInvoice(bookingId: string, logMessage: string) {
  try {
    const queuedInvoice = await enqueueXeroBookingInvoiceOperation(bookingId);
    if (queuedInvoice.queueOperationId) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      logger.info(
        { bookingId, job: "confirmPendingBookings" },
        logMessage
      );
    }
  } catch (xeroErr) {
    logger.error(
      { err: xeroErr, bookingId, job: "confirmPendingBookings" },
      "Failed to queue Xero invoice"
    );
  }
}

async function sendConfirmationEmail(booking: PendingBooking) {
  try {
    await sendBookingConfirmedEmail(
      { bookingId: booking.id, recipientMemberId: booking.memberId },
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      booking.guests.length,
      booking.finalPriceCents,
      bookingPromoEmailOptions(booking)
    );
  } catch (emailErr) {
    logger.error(
      { err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" },
      "Failed to send confirmation email"
    );
  }
}

async function sendBumpedEmail(booking: PendingBooking, flagged: boolean) {
  try {
    if (flagged) {
      await sendBookingGuestsCancelledEmail(
        { bookingId: booking.id, recipientMemberId: booking.memberId },
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.lodgeId
      );
    } else {
      await sendBookingBumpedEmail(
        { bookingId: booking.id, recipientMemberId: booking.memberId },
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.lodgeId,
        // #2430: the only send site of this template, and it reaches two
        // recipient classes. A club member (their own pending booking, or a
        // split guest child) can sign in and rebook; the non-login
        // NON_MEMBER/SCHOOL contact who owns a booking converted from a public
        // booking request (#707) — or any non-login contact an admin booked for
        // — cannot, so the notice points them at the club contact page instead
        // of the members-only booking flow.
        booking.member.canLogin
      );
    }
  } catch (emailErr) {
    logger.error(
      { err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" },
      "Failed to send bumped email"
    );
  }
}

function triggerWaitlistProcessing(booking: PendingBooking) {
  processWaitlistForDates({
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    lodgeId: booking.lodgeId,
  }).catch((err) =>
    logger.error(
      { err, bookingId: booking.id },
      "Failed to process waitlist after cron bump"
    )
  );
}

/**
 * `clubZone` IS SUPPLIED BY THE CALLER, never read here: this body holds
 * `lock(1)` AND the per-lodge lock throughout, and resolving the zone is a
 * settings query. See `payment-link-expiry.ts`.
 */
async function resolveHoldWindowUnderLock(
  bookingId: string,
  now: Date,
  clubZone: ClubTimeZone
): Promise<HoldResolution> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    // Pre-lock read: only the fields the early bail and the lock key need.
    // lodgeId is immutable, so keying the lock from this read is safe; every
    // capacity-relevant field is taken from the post-lock re-read below.
    const preLock = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true, status: true, nonMemberHoldUntil: true },
    });

    if (
      !preLock ||
      preLock.status !== BookingStatus.PENDING ||
      !preLock.nonMemberHoldUntil ||
      preLock.nonMemberHoldUntil > now
    ) {
      logger.info(
        { bookingId, job: "confirmPendingBookings" },
        "Booking already processed by another handler"
      );
      return { type: "already_processed" };
    }

    const bookingLodgeId = preLock.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read the full booking under the lock; the capacity check, claims and
    // reconcile below consume ONLY this post-lock snapshot. Re-validate the
    // hold window: a concurrent handler may have resolved it between the
    // pre-lock read and acquiring the lock.
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: pendingBookingInclude,
    });

    if (
      !booking ||
      booking.status !== BookingStatus.PENDING ||
      !booking.nonMemberHoldUntil ||
      booking.nonMemberHoldUntil > now
    ) {
      logger.info(
        { bookingId, job: "confirmPendingBookings" },
        "Booking already processed by another handler"
      );
      return { type: "already_processed" };
    }

    const capacityCheck = await checkCapacityForGuestRanges(
      bookingLodgeId,
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      booking.id,
      tx
    );

    if (!capacityCheck.available && bookingHasCapacityOverride(booking)) {
      // Persisted capacity override (#1771): this hold-eligible PENDING booking
      // was deliberately admitted above the ceiling by an admin, so the
      // hold-window re-check must NOT bump it. Fall through to the normal
      // confirm flow below ($0 -> PAID, or the priced claim-for-charge path).
      // This read-site is what lets booking-create retire its PENDING carve-out.
      logger.info(
        { bookingId: booking.id, job: "confirmPendingBookings" },
        "Confirming an over-capacity booking with a persisted capacity override (#1771); skipping the capacity bump"
      );
    }
    if (!capacityCheck.available && !bookingHasCapacityOverride(booking)) {
      const claimed = await tx.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.CANCELLED,
          nonMemberHoldUntil: null,
        },
      });
      if (claimed.count === 0) {
        logger.info(
          { bookingId: booking.id, job: "confirmPendingBookings" },
          "Booking already processed by another handler"
        );
        return { type: "already_processed" };
      }

      await reconcileBedAllocationsForBookingWithGlobalLockHeld({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      const promoRedemption = await tx.promoRedemption.findUnique({
        where: { bookingId: booking.id },
      });
      if (promoRedemption) {
        await deletePromoRedemptionAndAdjustCount(tx, promoRedemption);
      }

      await revokePaymentLinksForBooking(booking.id, tx);

      return {
        type: "bumped",
        booking,
        flagged: booking.cancelIfGuestsBumped,
      };
    }

    // Zero-dollar booking: skip Stripe, just confirm with a SUCCEEDED Payment.
    if (booking.finalPriceCents === 0) {
      const claimed = await tx.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.PAID,
          nonMemberHoldUntil: null,
        },
      });
      if (claimed.count === 0) {
        logger.info(
          { bookingId: booking.id, job: "confirmPendingBookings" },
          "Booking already processed by another handler"
        );
        return { type: "already_processed" };
      }

      await reconcileBedAllocationsForBookingWithGlobalLockHeld({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });
      await enqueueOwnHostingCoverageReevaluation(booking.id, tx, {
        cause: "SYSTEM_CHANGE",
      });

      await tx.payment.upsert({
        where: { bookingId: booking.id },
        create: {
          bookingId: booking.id,
          amountCents: 0,
          status: PaymentStatus.SUCCEEDED,
        },
        update: {
          amountCents: 0,
          status: PaymentStatus.SUCCEEDED,
        },
      });

      return { type: "confirmed_zero", booking };
    }

    const savedPayment = savedPaymentMethodForBooking(booking);
    if (!savedPayment) {
      if (booking.originBookingRequest) {
        // Request-origin bookings (#707) pay via a tokenised PaymentLink, not
        // a saved card. Keep the link path alive when capacity is still
        // available; revoke it in the unavailable branch above.

        // #2012 (symmetric twin of #1993 Part A) — terminal state. Once the
        // check-in day has ended, stop extending the hold forever and cancel
        // the still-unpaid request booking. Use the SAME boundary the approval
        // uses for the payment link's hard expiry
        // (booking-request.ts:approveBookingRequest sets
        // paymentLinkExpiryForCheckIn) — literally the same function, so the
        // two can never disagree: past it the /pay link is dead anyway,
        // yet without this the hold kept extending (and the admin alert kept
        // firing) forever. UNLIKE the split child (#1993), this booking HOLDS
        // REAL capacity, so this is a capacity change: the guarded
        // PENDING -> CANCELLED CAS (count 0 => a /pay settlement won the lock
        // seconds earlier: already_processed, safe), then bed reconcile
        // (RELEASE), promo cleanup and link revocation, all in this tx —
        // mirroring the capacity-releasing `bumped` path above. The CANCELLED
        // narrative event, the requester email, one final admin notice and the
        // waitlist wake fire post-commit (the event must not sit in-tx — see
        // booking-events.ts). A PAID/CONFIRMED booking is never here (not
        // PENDING); the CONVERTED request row is left as the historical record.
        const checkInDayEnded =
          paymentLinkExpiryForCheckIn(booking.checkIn, clubZone).getTime() <=
          now.getTime();
        if (checkInDayEnded) {
          const cancelled = await tx.booking.updateMany({
            where: { id: booking.id, status: BookingStatus.PENDING },
            data: {
              status: BookingStatus.CANCELLED,
              nonMemberHoldUntil: null,
            },
          });
          if (cancelled.count === 0) {
            return { type: "already_processed" };
          }

          await reconcileBedAllocationsForBookingWithGlobalLockHeld({
            bookingId: booking.id,
            db: tx,
            previousRange: {
              checkIn: booking.checkIn,
              checkOut: booking.checkOut,
            },
          });

          // Defensive promo cleanup, matching the capacity-releasing bump path
          // (a request-origin booking is officer-priced and normally carries no
          // promo redemption, but never leak a redemption count if one exists).
          const promoRedemption = await tx.promoRedemption.findUnique({
            where: { bookingId: booking.id },
          });
          if (promoRedemption) {
            await deletePromoRedemptionAndAdjustCount(tx, promoRedemption);
          }

          await revokePaymentLinksForBooking(booking.id, tx);

          return { type: "request_hold_terminal_cancelled", booking };
        }

        const extendedHoldUntil = new Date(
          now.getTime() + REQUEST_HOLD_EXTENSION_MS
        );
        const claimed = await tx.booking.updateMany({
          where: {
            id: booking.id,
            status: BookingStatus.PENDING,
            nonMemberHoldUntil: booking.nonMemberHoldUntil,
          },
          data: { nonMemberHoldUntil: extendedHoldUntil },
        });

        return claimed.count > 0
          ? {
              type: "extended_request_hold",
              booking,
              extendedHoldUntil,
            }
          : { type: "already_processed" };
      }

      // #1967: a split non-member child whose parent paid via Internet Banking
      // (switch-at-pay) has no saved card and is not request-origin, so it
      // cannot be auto-charged. Rather than stranding the guests unsettled (the
      // old missing_payment_method → log-only path), reuse the #707 tokenised
      // PaymentLink so the member can settle their guests' portion. Mirror the
      // request-origin path: extend the hold to stop 15-minute churn, mint the
      // link (idempotently), email the member once per mint, and alert admins
      // on every extension run while unsettled. The child stays PENDING and
      // holds no capacity, exactly as before.
      //
      // Genuine #738 split children only: a #796 group joiner also carries
      // parentBookingId (the organiser's booking) but always has a
      // GroupBookingJoin row written atomically at creation. Joiners keep the
      // pre-existing missing_payment_method behaviour below — their guest
      // wording, payment link (minted at join for EACH_PAYS_OWN) and
      // organiser-settlement flows are a different machine.
      if (booking.parentBookingId && !booking.groupBookingJoin) {
        // #1967 FIX-1: only treat the guest portion as settleable-by-link when
        // the parent (the member's own place) is genuinely settled without a
        // saved card — an Internet Banking payment on a live parent (the
        // switch-at-pay flips the parent to CONFIRMED with an IB-source
        // payment), or a parent already in a settled/settling status. An
        // abandoned-card PAYMENT_PENDING parent also reaches here with no
        // saved card, but then the member's own place is unpaid: emailing
        // "pay for your guests" would assert false facts and let the guest
        // portion settle ahead of the member's own place.
        const parent = booking.parentBooking;
        const parentIsLive =
          parent != null &&
          parent.deletedAt == null &&
          parent.status !== BookingStatus.CANCELLED &&
          parent.status !== BookingStatus.BUMPED;
        const parentSettledWithoutCard =
          parentIsLive &&
          (parent.payment?.source === PaymentSource.INTERNET_BANKING ||
            parent.status === BookingStatus.CONFIRMED ||
            parent.status === BookingStatus.PAID ||
            parent.status === BookingStatus.COMPLETED);

        // #1993 Part A (Option 1) — terminal state. Once the child's check-in
        // day has ended, stop extending/re-minting and auto-cancel the still-
        // unsettled guest portion. Use the SAME boundary the link-mint stop
        // uses (payment-link.ts:mintSplitGuestPaymentLinkIfAbsent) so the two
        // can never disagree about "check-in has passed". The child holds no
        // capacity, so this is bookkeeping + notification: a guarded
        // PENDING -> CANCELLED CAS (count 0 => a payment won the lock seconds
        // earlier: already_processed, safe), then link revocation and bed
        // reconcile, all in this tx. The CANCELLED narrative event, the member
        // email and one final admin notice fire post-commit (the event must not
        // sit in-tx — see booking-events.ts). A PAID child is never here (not
        // PENDING); the parent is never touched; no Xero void (an unsettled
        // child has no invoice).
        const checkInDayEnded =
          paymentLinkExpiryForCheckIn(booking.checkIn, clubZone).getTime() <=
          now.getTime();
        if (checkInDayEnded) {
          const cancelled = await tx.booking.updateMany({
            where: { id: booking.id, status: BookingStatus.PENDING },
            data: {
              status: BookingStatus.CANCELLED,
              nonMemberHoldUntil: null,
            },
          });
          if (cancelled.count === 0) {
            return { type: "already_processed" };
          }

          await reconcileBedAllocationsForBookingWithGlobalLockHeld({
            bookingId: booking.id,
            db: tx,
            previousRange: {
              checkIn: booking.checkIn,
              checkOut: booking.checkOut,
            },
          });

          await revokePaymentLinksForBooking(booking.id, tx);

          // The CANCELLED narrative event is recorded POST-COMMIT (below), not
          // here: booking-events.ts documents recordBookingEvent as a
          // post-commit write on the base client, because a failed INSERT
          // inside a Postgres transaction aborts the whole transaction — an
          // in-tx narrative failure would poison this tx and block the cancel.
          // Every sibling terminal path (bumped/confirmed_zero, the group
          // settlement reaper) records post-commit; match them.
          return {
            type: "split_child_terminal_cancelled",
            booking,
            parentUnpaid: !parentSettledWithoutCard,
          };
        }

        const extendedHoldUntil = new Date(
          now.getTime() + REQUEST_HOLD_EXTENSION_MS
        );
        const claimed = await tx.booking.updateMany({
          where: {
            id: booking.id,
            status: BookingStatus.PENDING,
            nonMemberHoldUntil: booking.nonMemberHoldUntil,
          },
          data: { nonMemberHoldUntil: extendedHoldUntil },
        });
        if (claimed.count === 0) {
          return { type: "already_processed" };
        }

        if (!parentSettledWithoutCard) {
          return {
            type: "split_child_parent_unpaid",
            booking,
            extendedHoldUntil,
          };
        }

        // #2258: decide BEFORE minting. Minting first and discovering the
        // withhold at send time would revoke-and-re-mint on every run —
        // unbounded PaymentLink/EmailLog churn whose repeats bury the withholds
        // an operator actually needs to see in the booking's withheld list. A
        // withhold is not a delivery failure to retry: nothing changes until an
        // admin clears the switch.
        const emailGate = await tx.booking.findUnique({
          where: { id: booking.id },
          select: { noEmails: true, noEmailsAt: true },
        });
        if (emailGate?.noEmails) {
          return {
            type: "split_child_payment_link",
            booking,
            extendedHoldUntil,
            mintedLink: null,
            emailWithheld: true,
            noEmailsAt: emailGate.noEmailsAt,
          };
        }

        // Mint only when no active (unexpired) link exists; a pre-existing
        // active link means a prior run already emailed the member.
        const mintedLink = await mintSplitGuestPaymentLinkIfAbsent(
          tx,
          { id: booking.id, checkIn: booking.checkIn },
          clubZone
        );

        return {
          type: "split_child_payment_link",
          booking,
          extendedHoldUntil,
          mintedLink,
          emailWithheld: false,
          noEmailsAt: null,
        };
      }

      return { type: "missing_payment_method", booking };
    }

    const claimed = await tx.booking.updateMany({
      where: { id: booking.id, status: BookingStatus.PENDING },
      data: {
        // Claim capacity before the external Stripe call. CONFIRMED is a
        // capacity-holding, payment-owed status; it is released back to PENDING
        // if the saved-card charge cannot complete.
        status: BookingStatus.CONFIRMED,
        nonMemberHoldUntil: null,
      },
    });
    if (claimed.count === 0) {
      logger.info(
        { bookingId: booking.id, job: "confirmPendingBookings" },
        "Booking already processed by another handler"
      );
      return { type: "already_processed" };
    }

    // #2576 §9. This is "payment completion" on the owner's list of paths that must
    // re-read the hosting facts at confirmation, and it is the one that CANNOT
    // refuse: the claim is what reserves the bed before the saved-card charge, so
    // throwing here would fail the cron item rather than tell anybody anything, and
    // §8 names automated status transitions and payment lifecycle among the changes
    // that cannot reasonably be blocked. So the obligation to look is recorded with
    // the claim — inside this transaction, under the same per-lodge capacity lock
    // every coverage-removing path takes, which is what closes §9's confirm-while-
    // source-removed race — and the drain re-reads the committed facts afterwards.
    //
    // Safe against the RELEASE below (a charge that does not complete puts the
    // booking back to PENDING): `reconcileSameOwnerCoverageIncident` opens an
    // incident only for a booking whose status is confirmed active attendance, so a
    // released claim drains to nothing rather than to a false emergency.
    await enqueueOwnHostingCoverageReevaluation(booking.id, tx, {
      cause: "SYSTEM_CHANGE",
    });

    // #1967 FIX-6: the auto-charge claim supersedes any outstanding /pay link
    // (e.g. one minted while no card was on file, before a card appeared on
    // the parent). Revoke inside the claim transaction — under the same lodge
    // lock the /pay intent path re-reads the link beneath — so the tokenised
    // link and the saved-card charge can never both be live settlement paths.
    // Mirrors the bump path's revocation above.
    await revokePaymentLinksForBooking(booking.id, tx);

    await reconcileBedAllocationsForBookingWithGlobalLockHeld({
      bookingId: booking.id,
      db: tx,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    const payment = await tx.payment.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        amountCents: booking.finalPriceCents,
        status: PaymentStatus.PENDING,
        stripeCustomerId: savedPayment.stripeCustomerId,
        stripePaymentMethodId: savedPayment.stripePaymentMethodId,
      },
      update: {
        amountCents: booking.finalPriceCents,
        status: PaymentStatus.PENDING,
        stripeCustomerId: savedPayment.stripeCustomerId,
        stripePaymentMethodId: savedPayment.stripePaymentMethodId,
      },
    });

    return {
      type: "claimed_for_charge",
      booking,
      payment: savedPayment,
      paymentId: payment.id,
      previousHoldUntil: booking.nonMemberHoldUntil,
    };
  });
}

async function releaseChargeClaim(
  claim: Extract<HoldResolution, { type: "claimed_for_charge" }>
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const claimLodgeId = claim.booking.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, claimLodgeId);

    const released = await tx.booking.updateMany({
      where: { id: claim.booking.id, status: BookingStatus.CONFIRMED },
      data: {
        status: BookingStatus.PENDING,
        nonMemberHoldUntil: claim.previousHoldUntil,
      },
    });

    if (released.count > 0) {
      await reconcileBedAllocationsForBookingWithGlobalLockHeld({
        bookingId: claim.booking.id,
        db: tx,
        previousRange: {
          checkIn: claim.booking.checkIn,
          checkOut: claim.booking.checkOut,
        },
      });
    }
  });
}

/**
 * #1992 (Option 1) — best-effort Stripe-side cancellation of any in-flight
 * /pay link PaymentIntent the auto-charge claim just superseded, closing the
 * residual #1967 double-charge window: a link intent minted (client secret
 * already in the member's browser) BEFORE the claim revoked the booking's
 * links can otherwise still be confirmed after the saved card is charged.
 *
 * Ordering — runs AFTER the claim transaction commits (Stripe calls never run
 * inside a database transaction) and BEFORE the saved-card charge:
 *   - The claim revoked the booking's links under the lodge lock and the /pay
 *     intent path re-reads the link under that same lock (#1967 FIX-6), so no
 *     NEW link-intent mint can START after the claim. That does NOT freeze the
 *     swept set at claim time: a mint that passed the link re-read just before
 *     the claim records its PaymentTransaction row only after its Stripe
 *     round-trip, outside the lodge lock, so the row can land after this
 *     sweep's findMany and be missed entirely. The sweep is best-effort
 *     narrowing of the window, nothing more; Option 2 (the #1992
 *     duplicate-capture auto-refund below) is the authoritative backstop and
 *     must never be removed as "redundant".
 *   - Cancelling before the charge minimises the window in which the member's
 *     browser can still capture. A cancel that LOSES that race (the intent
 *     already succeeded → not cancellable, or the cancel API errors against a
 *     parallel confirm) is expected: the charge proceeds and the succeeded
 *     link intent's webhook lands on the then-PAID booking, where the #1992
 *     duplicate-capture auto-refund in markBookingPaymentSucceeded is the
 *     backstop for whichever capture arrives second.
 *   - The sweep EXCLUDES every transaction minted under the shared
 *     `pending_charge_<bookingId>` Stripe idempotency key (matched by reason:
 *     PENDING_HOLD_AUTO_CHARGE_REASON for this cron's own prior-run charge,
 *     PENDING_SAVED_METHOD_CHARGE_REASON for charge-saved-method's
 *     3DS-pending charge): Stripe re-returns that key's intent when this run
 *     charges, so cancelling either row would cancel this run's own charge —
 *     the idempotent replay would come back as the cancelled intent and the
 *     settlement would stall until the key expires.
 *
 * Deliberately Stripe-side only and best-effort (no durable
 * CANCEL_PAYMENT_INTENT recovery operation): the durable cancel path's
 * succeeded-intent handoff mints its own superseded-payment refund, which
 * would race the #1992 duplicate-capture refund for the same money under
 * different Stripe keys. Losing a transient cancel here only re-opens the
 * window Option 2 already covers. Local ledger state is left to the
 * payment_intent.canceled webhook, as with every other cancelled intent.
 */
async function cancelSupersededLinkIntentsBestEffort(
  claim: Extract<HoldResolution, { type: "claimed_for_charge" }>
) {
  const bookingId = claim.booking.id;
  try {
    const inFlightIntents = await prisma.paymentTransaction.findMany({
      where: {
        paymentId: claim.paymentId,
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.STRIPE,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        stripePaymentIntentId: { not: null },
        amountCents: { gt: 0 },
        // Never a `pending_charge_<bookingId>`-keyed saved-card charge — this
        // cron's own from a prior run, or charge-saved-method's 3DS-pending
        // one (see the ordering note above). `notIn` alone would also drop
        // rows with a NULL reason, so include them explicitly.
        OR: [
          { reason: null },
          {
            reason: {
              notIn: [
                PENDING_HOLD_AUTO_CHARGE_REASON,
                PENDING_SAVED_METHOD_CHARGE_REASON,
              ],
            },
          },
        ],
      },
      select: { id: true, stripePaymentIntentId: true },
    });

    for (const transaction of inFlightIntents) {
      if (!transaction.stripePaymentIntentId) {
        continue;
      }
      try {
        const canceled = await cancelPaymentIntentIfCancellable(
          transaction.stripePaymentIntentId
        );
        if (canceled) {
          logger.info(
            {
              bookingId,
              paymentIntentId: transaction.stripePaymentIntentId,
              job: "confirmPendingBookings",
            },
            "Cancelled an in-flight payment-link intent superseded by the saved-card auto-charge (#1992)"
          );
        } else {
          // Expected race: the member's confirm won (intent succeeded) or the
          // intent already reached a terminal state. The #1992
          // duplicate-capture auto-refund covers a succeeded duplicate.
          logger.info(
            {
              bookingId,
              paymentIntentId: transaction.stripePaymentIntentId,
              job: "confirmPendingBookings",
            },
            "Superseded payment-link intent was not cancellable (likely already succeeded); duplicate-capture reconciliation is the backstop (#1992)"
          );
        }
      } catch (cancelErr) {
        logger.error(
          {
            err: cancelErr,
            bookingId,
            paymentIntentId: transaction.stripePaymentIntentId,
            job: "confirmPendingBookings",
          },
          "Failed to cancel a superseded payment-link intent; proceeding with the saved-card charge (best-effort, #1992)"
        );
      }
    }
  } catch (lookupErr) {
    logger.error(
      { err: lookupErr, bookingId, job: "confirmPendingBookings" },
      "Failed to look up in-flight payment-link intents before the saved-card charge (best-effort, #1992)"
    );
  }
}

/**
 * Process provisional bookings that have reached their hold deadline.
 *
 * For each PENDING booking where nonMemberHoldUntil <= now():
 * 1. Re-check bed availability under the booking advisory lock.
 * 2. If beds are unavailable, cancel the provisional booking, revoke payment
 *    links, and send the appropriate no-charge bump/cancellation email.
 * 3. If beds are available and a saved payment method exists, claim capacity,
 *    charge off-session, then move to PAID and queue the booking's Xero invoice.
 * 4. If the booking is request-origin and has no saved card, keep the #707
 *    payment-link path alive by extending the follow-up hold and alerting admins
 *    on a capped cadence — until the check-in day has ended, at which point the
 *    still-unpaid booking is auto-cancelled, its held capacity released, and the
 *    requester + admins are given a terminal notice (#2012).
 */
export async function confirmPendingBookings(): Promise<CronConfirmResult> {
  const now = new Date();

  // ONE settings read per run, outside every transaction, so no lock waits on
  // it and two bookings in one tick share a club day (`payment-link-expiry.ts`).
  const clubZone = await readClubTimeZoneOutsideRequest();

  // Find all PENDING bookings past their hold deadline, including split
  // non-member child bookings (#738). Process oldest first so older provisional
  // non-member windows resolve before newer competing holds.
  const pendingBookings = await prisma.booking.findMany({
    where: {
      status: BookingStatus.PENDING,
      nonMemberHoldUntil: { lte: now },
    },
    include: pendingBookingInclude,
    orderBy: { createdAt: "asc" },
  });

  const result: CronConfirmResult = {
    confirmedBookingIds: [],
    bumpedBookingIds: [],
    cancelledBookingIds: [],
    partialBumpedBookingIds: [],
    failedBookingIds: [],
  };

  for (const candidate of pendingBookings) {
    let chargeAttempted = false;
    let paymentSucceeded = false;
    let claimForCharge: Extract<
      HoldResolution,
      { type: "claimed_for_charge" }
    > | null = null;
    let paymentIntentId = candidate.payment?.stripePaymentIntentId || "N/A";

    try {
      const resolution = await resolveHoldWindowUnderLock(
        candidate.id,
        now,
        clubZone
      );

      if (resolution.type === "already_processed") {
        continue;
      }

      if (resolution.type === "bumped") {
        result.bumpedBookingIds.push(resolution.booking.id);
        // Durable fact (issue #740): these dates filled up before the
        // provisional guests were confirmed; the booking was released, no
        // payment taken. This is what lets the narrative tell a bumped booking
        // apart from a member-initiated cancellation — both end up CANCELLED.
        await recordBookingEvent({
          bookingId: resolution.booking.id,
          type: BookingEventType.BUMPED,
          reason: resolution.flagged
            ? "Released because the whole party could not be confirmed (only-if-guests-come)."
            : "These dates filled up before the provisional guests were confirmed.",
          snapshot: { flagged: resolution.flagged },
        });
        await sendBumpedEmail(resolution.booking, resolution.flagged);
        triggerWaitlistProcessing(resolution.booking);
        continue;
      }

      if (resolution.type === "confirmed_zero") {
        result.confirmedBookingIds.push(resolution.booking.id);
        await recordBookingEvent({
          bookingId: resolution.booking.id,
          type: BookingEventType.NON_MEMBER_CONFIRMED,
          amountCents: 0,
        });
        await queueXeroInvoice(
          resolution.booking.id,
          "Xero invoice queued for $0 booking"
        );
        await sendConfirmationEmail(resolution.booking);
        continue;
      }

      if (resolution.type === "extended_request_hold") {
        // #2012 — cap the previously-every-run admin alert to the same derived
        // cadence #1993 Part B applies to the split-settlement stream:
        // extension windows 1, 2, 3, then every 7th. The extension CAS upstream
        // already fired exactly once for this window, so this decision is
        // idempotent across cron reruns. The helpers are shared, generic
        // ~2-day-window functions (keyed on REQUEST_HOLD_EXTENSION_MS, the
        // request-hold constant) — no rename, so the split-settlement call
        // sites stay byte-equivalent.
        const extensionNumber = splitSettlementExtensionNumber(
          await resolveOriginalHoldExpiry(resolution.booking),
          now
        );
        if (shouldAlertOnSplitSettlementExtension(extensionNumber)) {
          try {
            await sendAdminBookingRequestHoldExpiredEmail({
              requesterName: `${resolution.booking.member.firstName} ${resolution.booking.member.lastName}`,
              checkIn: resolution.booking.checkIn,
              checkOut: resolution.booking.checkOut,
              guestCount: resolution.booking.guests.length,
              totalCents: resolution.booking.finalPriceCents,
              holdUntil: resolution.extendedHoldUntil,
            });
          } catch (emailErr) {
            logger.error(
              {
                err: emailErr,
                bookingId: resolution.booking.id,
                job: "confirmPendingBookings",
              },
              "Failed to send admin hold-expired alert"
            );
          }
        }
        continue;
      }

      if (resolution.type === "request_hold_terminal_cancelled") {
        // #2012 — the guarded cancel, bed reconcile (capacity RELEASED), promo
        // cleanup and link revocation already committed under the lodge lock.
        // Post-commit, outside any transaction: record the CANCELLED narrative
        // event (kept OUT of the tx per booking-events.ts — an in-tx INSERT
        // failure would abort the whole transaction and block the cancel), tell
        // the requester their approved booking was released (nothing charged),
        // send ONE dedicated final admin notice, and wake the waitlist for the
        // freed beds. None of the four is load-bearing for the transition — a
        // failure is logged, never retried into a double-cancel.
        result.cancelledBookingIds.push(resolution.booking.id);

        await recordBookingEvent({
          bookingId: resolution.booking.id,
          type: BookingEventType.CANCELLED,
          reason:
            "The booking created from a public booking request was still unpaid at the end of the check-in day, so it was automatically cancelled and its held beds released. No payment was taken.",
          snapshot: { autoCancelledPastCheckIn: true },
        });

        try {
          await sendBookingRequestPaymentExpiredEmail({
            bookingContext: {
              bookingId: resolution.booking.id,
              recipientMemberId: resolution.booking.memberId,
            },
            email: resolution.booking.member.email,
            firstName: resolution.booking.member.firstName,
            checkIn: resolution.booking.checkIn,
            checkOut: resolution.booking.checkOut,
            lodgeId: resolution.booking.lodgeId,
          });
        } catch (emailErr) {
          logger.error(
            {
              err: emailErr,
              bookingId: resolution.booking.id,
              job: "confirmPendingBookings",
            },
            "Failed to send requester payment-expired email for auto-cancelled request booking (#2012)"
          );
        }

        try {
          await sendAdminBookingRequestHoldCancelledEmail({
            requesterName: `${resolution.booking.member.firstName} ${resolution.booking.member.lastName}`,
            checkIn: resolution.booking.checkIn,
            checkOut: resolution.booking.checkOut,
            guestCount: resolution.booking.guests.length,
            totalCents: resolution.booking.finalPriceCents,
          });
        } catch (alertErr) {
          logger.error(
            {
              err: alertErr,
              bookingId: resolution.booking.id,
              job: "confirmPendingBookings",
            },
            "Failed to send final admin notice for auto-cancelled request booking (#2012)"
          );
        }

        triggerWaitlistProcessing(resolution.booking);
        continue;
      }

      if (resolution.type === "split_child_terminal_cancelled") {
        // #1993 Part A — the guarded cancel, link revocation and bed reconcile
        // already committed under the lodge lock. Post-commit, outside any
        // transaction: record the CANCELLED narrative event (kept OUT of the
        // tx per booking-events.ts — an in-tx INSERT failure would abort the
        // whole transaction and block the cancel), tell the member the
        // provisional guest portion was cancelled (nothing ever charged; their
        // own booking untouched), and send ONE dedicated final admin notice.
        // None of the three is load-bearing for the transition — a failure is
        // logged, never retried into a double-cancel.
        result.cancelledBookingIds.push(resolution.booking.id);

        await recordBookingEvent({
          bookingId: resolution.booking.id,
          type: BookingEventType.CANCELLED,
          reason:
            "The guest portion was still unpaid at the end of the check-in day, so the provisional guest booking was automatically cancelled. No payment was taken.",
          snapshot: { autoCancelledPastCheckIn: true },
        });

        try {
          await sendSplitGuestPortionCancelledEmail({
            bookingId: resolution.booking.id,
            recipientMemberId: resolution.booking.memberId,
            email: resolution.booking.member.email,
            firstName: resolution.booking.member.firstName,
            checkIn: resolution.booking.checkIn,
            checkOut: resolution.booking.checkOut,
            // parentUnpaid conflates unpaid/cancelled/bumped parents, so only
            // promise "your own booking remains confirmed" when the parent is
            // genuinely settled (parentUnpaid === false).
            parentConfirmed: !resolution.parentUnpaid,
            parentBookingReference: resolution.booking.parentBookingId,
            lodgeId: resolution.booking.lodgeId,
          });
        } catch (emailErr) {
          logger.error(
            {
              err: emailErr,
              bookingId: resolution.booking.id,
              job: "confirmPendingBookings",
            },
            "Failed to send member cancellation email for auto-cancelled split child (#1993)"
          );
        }

        try {
          await sendAdminSplitSettlementCancelledAlert({
            memberName: `${resolution.booking.member.firstName} ${resolution.booking.member.lastName}`,
            checkIn: resolution.booking.checkIn,
            checkOut: resolution.booking.checkOut,
            guestCount: resolution.booking.guests.length,
            totalCents: resolution.booking.finalPriceCents,
            parentUnpaid: resolution.parentUnpaid,
          });
        } catch (alertErr) {
          logger.error(
            {
              err: alertErr,
              bookingId: resolution.booking.id,
              job: "confirmPendingBookings",
            },
            "Failed to send final admin notice for auto-cancelled split child (#1993)"
          );
        }

        triggerWaitlistProcessing(resolution.booking);
        continue;
      }

      if (resolution.type === "split_child_payment_link") {
        // Member email: only the run that minted a fresh link sends one (a
        // null mintedLink means an active link exists and the member was
        // emailed on a prior run — idempotent across cron re-runs). If the
        // send throws or is suppressed, the raw token dies with this run, so
        // revoke the just-minted link (by id, so a concurrent on-demand
        // re-mint's newer link survives) — the next extension run then
        // re-mints and re-sends instead of stalling forever behind a stale
        // active-link sentinel.
        if (resolution.emailWithheld) {
          // #2258: nothing minted, nothing sent. Record the withhold ONCE per
          // booking (this cron re-drives every run, and a per-run row would
          // flood the booking's withheld list), then fall through to the admin
          // alert below so an operator still learns the portion is unpaid.
          await recordWithheldBookingEmail({
            bookingId: resolution.booking.id,
            templateName: SPLIT_GUEST_PAYMENT_LINK_TEMPLATE,
            subject: "Pay for your guests to confirm their place",
            to: resolution.booking.member.email,
            detail:
              'Withheld: this booking has the "No emails" switch turned on. No payment link was created.',
            once: true,
            // Scope the once-check to THIS episode, so a re-enable records afresh.
            sinceAt: resolution.noEmailsAt,
          }).catch((err) =>
            logger.error(
              { err, bookingId: resolution.booking.id, job: "confirmPendingBookings" },
              "Failed to record the withheld split guest payment link email"
            )
          );
          logger.warn(
            { bookingId: resolution.booking.id, job: "confirmPendingBookings" },
            'Skipped minting a split guest payment link: the booking has "No emails" turned on'
          );
        } else if (resolution.mintedLink) {
          // `expiresAt` comes back FROM the mint, so the email states the row's
          // own instant rather than deriving the boundary a second time.
          const { token, paymentLinkId, expiresAt } = resolution.mintedLink;
          let delivered = false;
          let withheld = false;
          try {
            const emailOutcome = await sendSplitGuestPaymentLinkEmail({
              bookingContext: {
                bookingId: resolution.booking.id,
                recipientMemberId: resolution.booking.memberId,
              },
              email: resolution.booking.member.email,
              firstName: resolution.booking.member.firstName,
              token,
              checkIn: resolution.booking.checkIn,
              checkOut: resolution.booking.checkOut,
              guestCount: resolution.booking.guests.length,
              priceCents: resolution.booking.finalPriceCents,
              bookingReference: resolution.booking.id,
              expiresAt,
              lodgeId: resolution.booking.lodgeId ?? null,
            });
            delivered = emailOutcome.status === "sent";
            // #2258: the switch can be flipped between the pre-mint gate and this
            // send. The token is revoked below either way, but a DELIBERATE
            // withhold must not be reported as a retryable delivery failure, while
            // a fail-closed one (the setting could not be READ) is transient and
            // keeps retry semantics. The else-branch names NO cause: it said
            // "(suppressed recipient)", false for an environment withhold (#3035).
            withheld =
              emailOutcome.status === "withheld_for_booking" &&
              emailOutcome.reason === "booking_no_emails";
            if (!delivered) {
              logger.warn(
                {
                  bookingId: resolution.booking.id,
                  emailStatus: emailOutcome.status,
                  job: "confirmPendingBookings",
                },
                withheld
                  ? "Split-booking guest payment link email withheld by the booking's email gate; revoking the link"
                  : "Split-booking guest payment link email not delivered; revoking the link so the next settlement run re-mints. emailStatus says why"
              );
            }
          } catch (emailErr) {
            logger.error(
              {
                err: emailErr,
                bookingId: resolution.booking.id,
                job: "confirmPendingBookings",
              },
              "Failed to send split-booking guest payment link email; revoking the link so the next settlement run re-mints"
            );
          }
          if (!delivered) {
            await revokePaymentLinkById(paymentLinkId).catch((revokeErr) =>
              logger.error(
                {
                  err: revokeErr,
                  bookingId: resolution.booking.id,
                  paymentLinkId,
                  job: "confirmPendingBookings",
                },
                "Failed to revoke undelivered split guest payment link; a stale active link may block re-minting until it expires"
              )
            );
          }
        }

        // Admin alert: #1993 Part B caps the previously-every-run cadence to
        // extension windows 1, 2, 3, then every 7th. The extension CAS upstream
        // already fired exactly once for this window, so this decision is
        // idempotent across cron reruns.
        const extensionNumber = splitSettlementExtensionNumber(
          await resolveOriginalHoldExpiry(resolution.booking),
          now
        );
        if (shouldAlertOnSplitSettlementExtension(extensionNumber)) {
          try {
            await sendAdminSplitSettlementUnpaidAlert({
              memberName: `${resolution.booking.member.firstName} ${resolution.booking.member.lastName}`,
              checkIn: resolution.booking.checkIn,
              checkOut: resolution.booking.checkOut,
              guestCount: resolution.booking.guests.length,
              totalCents: resolution.booking.finalPriceCents,
              holdUntil: resolution.extendedHoldUntil,
              parentUnpaid: false,
            });
          } catch (alertErr) {
            logger.error(
              {
                err: alertErr,
                bookingId: resolution.booking.id,
                job: "confirmPendingBookings",
              },
              "Failed to send admin split-settlement unpaid alert"
            );
          }
        }
        continue;
      }

      if (resolution.type === "split_child_parent_unpaid") {
        // The member's own (parent) booking is unpaid, so no guest payment
        // link was minted or emailed. Keep the legacy missing-payment-method
        // observability (error log + failed id) and alert admins once per
        // hold extension — the extension claim is the dedupe across the
        // 15-minute cron cadence.
        logger.error(
          { bookingId: resolution.booking.id, job: "confirmPendingBookings" },
          "Split child booking has no saved payment method and its parent booking is unsettled - cannot auto-confirm or issue a guest payment link"
        );
        result.failedBookingIds.push(resolution.booking.id);
        // #1993 Part B — same derived cadence as the payment-link branch, so a
        // parent-unpaid split child no longer alerts admins every extension run.
        const extensionNumber = splitSettlementExtensionNumber(
          await resolveOriginalHoldExpiry(resolution.booking),
          now
        );
        if (shouldAlertOnSplitSettlementExtension(extensionNumber)) {
          try {
            await sendAdminSplitSettlementUnpaidAlert({
              memberName: `${resolution.booking.member.firstName} ${resolution.booking.member.lastName}`,
              checkIn: resolution.booking.checkIn,
              checkOut: resolution.booking.checkOut,
              guestCount: resolution.booking.guests.length,
              totalCents: resolution.booking.finalPriceCents,
              holdUntil: resolution.extendedHoldUntil,
              parentUnpaid: true,
            });
          } catch (alertErr) {
            logger.error(
              {
                err: alertErr,
                bookingId: resolution.booking.id,
                job: "confirmPendingBookings",
              },
              "Failed to send admin split-settlement unpaid alert"
            );
          }
        }
        continue;
      }

      if (resolution.type === "missing_payment_method") {
        logger.error(
          { bookingId: resolution.booking.id, job: "confirmPendingBookings" },
          "Booking has no saved payment method - cannot auto-confirm"
        );
        result.failedBookingIds.push(resolution.booking.id);
        continue;
      }

      claimForCharge = resolution;

      // #1992 (Option 1) — the claim just revoked this booking's payment
      // links; also cancel any link PaymentIntent already minted from them
      // (best-effort, outside any transaction, before the charge — see the
      // helper's ordering analysis).
      await cancelSupersededLinkIntentsBestEffort(resolution);

      chargeAttempted = true;

      const paymentIntent = await chargePaymentMethod({
        amountCents: resolution.booking.finalPriceCents,
        customerId: resolution.payment.stripeCustomerId,
        paymentMethodId: resolution.payment.stripePaymentMethodId,
        metadata: {
          bookingId: resolution.booking.id,
          memberId: resolution.booking.memberId,
        },
        idempotencyKey: `pending_charge_${resolution.booking.id}`,
      });
      paymentIntentId = paymentIntent.id;

      const paymentMethodId =
        typeof paymentIntent.payment_method === "string"
          ? paymentIntent.payment_method
          : paymentIntent.payment_method?.id ?? null;

      if (paymentIntent.status === "succeeded") {
        paymentSucceeded = true;

        await upsertPaymentIntentTransaction({
          paymentId: resolution.paymentId,
          kind: PaymentTransactionKind.PRIMARY,
          paymentIntentId: paymentIntent.id,
          amountCents: paymentIntent.amount,
          status: PaymentStatus.SUCCEEDED,
          paymentMethodId,
          reason: PENDING_HOLD_AUTO_CHARGE_REASON,
        });

        const reconciliation = await markBookingPaymentSucceeded({
          bookingId: resolution.booking.id,
          paymentIntentId: paymentIntent.id,
          amountCents: paymentIntent.amount,
          paymentMethodId,
        });

        if (
          reconciliation.outcome === "cancelled_refunded" ||
          reconciliation.outcome === "cancelled_refund_failed"
        ) {
          logger.warn(
            {
              bookingId: resolution.booking.id,
              paymentIntentId: paymentIntent.id,
              outcome: reconciliation.outcome,
              job: "confirmPendingBookings",
            },
            "Pending booking payment succeeded but final capacity claim failed"
          );
          result.failedBookingIds.push(resolution.booking.id);
          continue;
        }

        if (
          reconciliation.outcome === "duplicate_capture_refunded" ||
          reconciliation.outcome === "duplicate_capture_refund_failed"
        ) {
          // #1992 — the member's in-flight link intent won the race and had
          // already settled the booking; this saved-card charge was the
          // duplicate and was auto-refunded (or its refund is pending in the
          // recovery cron). The booking IS settled, so it counts as
          // confirmed, but the settling path already sent the confirmation
          // email and queued the Xero invoice — repeating either here would
          // double them up.
          logger.warn(
            {
              bookingId: resolution.booking.id,
              paymentIntentId: paymentIntent.id,
              outcome: reconciliation.outcome,
              job: "confirmPendingBookings",
            },
            "Auto-charge captured against a booking already settled by its payment link; the duplicate charge was handed to the #1992 auto-refund"
          );
          result.confirmedBookingIds.push(resolution.booking.id);
          continue;
        }

        result.confirmedBookingIds.push(resolution.booking.id);
        await queueXeroInvoice(resolution.booking.id, "Xero invoice queued");
        await sendConfirmationEmail(resolution.booking);
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          const releaseLodgeId =
            resolution.booking.lodgeId ?? (await getDefaultLodgeId(tx));
          await acquireLodgeCapacityLock(tx, releaseLodgeId);

          const lockedBooking = await tx.booking.findUnique({
            where: { id: resolution.booking.id },
            select: { status: true },
          });
          if (lockedBooking?.status !== BookingStatus.CONFIRMED) {
            throw new Error(
              "Pending-hold charge release lost its CONFIRMED claim",
            );
          }

          await upsertPaymentIntentTransaction({
            paymentId: resolution.paymentId,
            kind: PaymentTransactionKind.PRIMARY,
            paymentIntentId: paymentIntent.id,
            amountCents: paymentIntent.amount,
            status: PaymentStatus.PROCESSING,
            paymentMethodId,
            reason: PENDING_HOLD_AUTO_CHARGE_REASON,
            store: tx,
          });

          const released = await tx.booking.updateMany({
            where: {
              id: resolution.booking.id,
              status: BookingStatus.CONFIRMED,
            },
            data: {
              status: BookingStatus.PENDING,
              nonMemberHoldUntil: resolution.previousHoldUntil,
            },
          });
          if (released.count === 0) {
            throw new Error(
              "Pending-hold charge release lost its CONFIRMED claim",
            );
          }
          await reconcileBedAllocationsForBookingWithLodgeLockHeld({
            bookingId: resolution.booking.id,
            db: tx,
            previousRange: {
              checkIn: resolution.booking.checkIn,
              checkOut: resolution.booking.checkOut,
            },
          });
        });

        logger.info(
          {
            bookingId: resolution.booking.id,
            paymentStatus: paymentIntent.status,
            job: "confirmPendingBookings",
          },
          "Booking payment processing"
        );
      }
    } catch (err) {
      logger.error(
        {
          err,
          bookingId: candidate.id,
          job: "confirmPendingBookings",
        },
        "Error processing pending booking"
      );

      // Only roll back the capacity claim when Stripe never confirmed a
      // successful charge. If Stripe succeeded, leave the booking in its
      // claimed state for webhook/admin recovery.
      if (claimForCharge && !paymentSucceeded) {
        await releaseChargeClaim(claimForCharge).catch((revertErr) =>
          logger.error(
            {
              err: revertErr,
              bookingId: claimForCharge?.booking.id,
              job: "confirmPendingBookings",
            },
            "Failed to release pending booking charge claim"
          )
        );
      } else if (paymentSucceeded) {
        logger.error(
          { bookingId: candidate.id, job: "confirmPendingBookings" },
          "Stripe charge succeeded but local booking reconciliation failed; leaving booking claimed for webhook recovery"
        );
      }

      result.failedBookingIds.push(candidate.id);

      // Only emit a payment-failure alert when the Stripe charge attempt itself failed.
      if (chargeAttempted && !paymentSucceeded) {
        sendAdminPaymentFailureAlert({
          memberName: `${candidate.member.firstName} ${candidate.member.lastName}`,
          checkIn: candidate.checkIn,
          checkOut: candidate.checkOut,
          amountCents: candidate.finalPriceCents,
          errorMessage: err instanceof Error ? err.message : String(err),
          paymentIntentId,
        }).catch((alertErr) =>
          logger.error(
            { err: alertErr, bookingId: candidate.id },
            "Failed to send admin payment failure alert"
          )
        );
      }
    }
  }

  // #2576 §8/§9: settle whatever the claims above queued, now that every charge has
  // either completed or been released. Once per cycle rather than once per booking —
  // the drain is bounded and idempotent, and the general cron sweep runs it again
  // anyway, so this is the "immediate" attempt and not the guarantee.
  // Unfiltered and generously limited: this is a cron cycle over many members'
  // bookings, not one member's request, so there is no owner to scope it to.
  await settleHostingCoverageAfterCommit({ limit: 25 });

  return result;
}
