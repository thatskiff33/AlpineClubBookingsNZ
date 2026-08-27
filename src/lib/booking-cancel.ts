import { prisma } from "./prisma";
import { cancelPaymentIntentIfCancellable, cancelSetupIntentIfCancellable } from "./stripe";
import { isXeroConnected } from "./xero";
import {
  calculateAppliedCreditRestore,
  calculateRefundAmount,
  daysUntilDate,
  loadCancellationPolicy,
} from "./cancellation";
import { sendAdminManualRefundTaskAlert, sendBookingCancelledEmail } from "./email";
import { logAudit } from "./audit";
import { recordBookingEvent } from "./booking-events";
import {
  BookingEventType,
  BookingStatus,
  ManualRefundTaskKind,
  type Prisma,
} from "@prisma/client";
import {
  createCancellationCredit,
  lockMemberCreditLedger,
  restoreCreditFromBooking,
} from "./member-credit";
import { processWaitlistForDates } from "./waitlist";
import {
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "./xero-operation-outbox";
import logger from "@/lib/logger";
import {
  applyLocalRefundAllocation,
  markPaymentIntentTransactionFailed,
  planStripeRefundAllocation,
  refundPaymentTransactions,
  PartialRefundError,
  type RefundAllocationSlice,
} from "@/lib/payment-transactions";
import {
  buildBookingCancellationRefundMetadata,
  enqueueBookingCancellationRefundRecovery,
  enqueuePaymentIntentCancellationRecovery,
  markBookingCancellationRefundRecoverySucceeded,
  recordBookingCancellationRefundRecoveryInlineError,
} from "@/lib/payment-recovery";
import { deletePromoRedemptionAndAdjustCount } from "@/lib/promo";
import {
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
} from "@/lib/booking-status";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { revokePaymentLinksForBooking } from "@/lib/payment-link";
import { settleGroupBookingOnOrganiserCancel } from "@/lib/group-cancel";
import { repairLegacyAppliedCreditNoteAllocationsForBooking } from "@/lib/xero-applied-credit-allocation-repair";
import { findUnconvergedAppliedCreditDeallocation } from "@/lib/xero-applied-credit-operation-serialization";
import {
  hostingCoverageActorOptions,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import type { HostingCoverageOverrideInput } from "@/lib/adult-member-hosting-same-owner";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { bookingStayHasStarted } from "@/lib/booking-edit-policy";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";

// Statuses a booking may be cancelled from. Shared by the outer validation
// guard and the tx1 single-flight re-check so the two can never drift (#1160).
const CANCELLABLE_BOOKING_STATUSES: readonly string[] = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "WAITLISTED",
  "WAITLIST_OFFERED",
  "AWAITING_REVIEW",
];

// The no-payment / holding statuses the shared cancel path may flip straight to
// CANCELLED with no refund and no external-provider (Stripe/Xero) work. A strict
// subset of CANCELLABLE_BOOKING_STATUSES. This is the exact WHERE set for the
// #1311 status-guarded claim-first: a booking that has left this set under the
// advisory lock (e.g. a concurrent quote-accept converting AWAITING_REVIEW ->
// PENDING) must NOT be clobbered to CANCELLED.
const NO_PAYMENT_CANCELLABLE_STATUSES: readonly string[] = [
  "WAITLISTED",
  "WAITLIST_OFFERED",
  "AWAITING_REVIEW",
];

interface CancelBookingResult {
  success: boolean;
  refundAmountCents: number;
  refundPercentage: number;
  // B5 (#2262): "manual" — the booking was settled in cash / by an off-Xero
  // bank transfer, so no card refund was planned and no account credit was
  // minted; a durable hand-back task was raised instead and its id is returned.
  refundMethod: "card" | "credit" | "manual";
  creditAmountCents?: number;
  creditRestoredCents?: number;
  stripeRefundId?: string;
  manualRefundTaskId?: string;
  message: string;
}

async function reconcileCancelledBookingBedAllocations(
  booking: { id: string; checkIn: Date; checkOut: Date },
  db: Prisma.TransactionClient,
) {
  await reconcileBedAllocationsForBookingWithLodgeLockHeld({
    bookingId: booking.id,
    db,
    previousRange: {
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    },
  });
}

type CancelBookingResponse =
  | { status: 401; error: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 400; error: string }
  | { status: 409; error: string }
  | { status: 200; data: CancelBookingResult };

/**
 * Shared cancellation service used by both cancel routes.
 *
 * Split bookings (#738): cancelling the member (parent) booking also cancels
 * its linked provisional non-member child (PENDING, holds nothing, no payment),
 * so a family is cancelled as one. Cancelling the non-member child on its own
 * leaves the member booking intact.
 *
 * `options.suppressCustomerNotification` (#1255): when `true`, skip the
 * customer-facing "booking cancelled" email. Currently honored on the
 * no-payment / AWAITING_REVIEW cancellation path only — used by the admin
 * "Release hold" action, which cancels a held (AWAITING_REVIEW) booking to
 * re-open owner mapping without telling the requester their reservation was
 * cancelled. Refund-path notifications are unaffected. Defaults to `false`, so
 * every existing caller is unchanged.
 *
 * `options.hasBookingsEditAccess` (#1313, option A2): when `true`, a non-owner
 * actor holding the `bookings:edit` permission (a Booking Officer) is authorized
 * to cancel exactly as a Full Admin does. This is an authorization widening
 * ONLY — `sessionUserRole` is still passed through honestly and the refund /
 * Stripe / email / audit logic never reads it beyond the gate below, so the
 * money outcome is independent of which authorized actor triggered the cancel.
 * Defaults to `false`, so every existing caller is unchanged.
 *
 * `options.requireRequestHold` (#1406): when `true`, the caller asserts it is
 * releasing a held booking-request slot that MUST still be AWAITING_REVIEW (the
 * admin "Release hold" route and `declineBookingRequest`). If the outer read
 * finds any other status — e.g. a concurrent quote-accept already flipped the
 * hold AWAITING_REVIEW -> PENDING — cancel refuses with a 409 BEFORE branch
 * dispatch and takes no side effect, so a just-accepted booking is never routed
 * into the generic PENDING branch and clobbered (its brand-new payment links
 * revoked). This guard stays ESSENTIAL even though the PENDING branch is now
 * itself status-guarded claim-first under lock(1) (#1547): that branch only
 * refuses a booking that has LEFT PENDING, but a just-accepted booking genuinely
 * IS PENDING, so it would pass the branch's own guard — the pre-dispatch 409
 * here is the only protection for that scenario. Defaults to `false`, so callers
 * cancelling genuine PENDING bookings (member self-cancel, deletion cleanup) are
 * unaffected.
 *
 * `options.notifyMember` (#1705, #1696 semantics): the admin's explicit
 * per-cancel choice of whether the member receives the cancellation email.
 * Honoured only for an admin-type actor (`sessionUserRole === "ADMIN"` or a
 * Booking Officer via `hasBookingsEditAccess` — the same pair the authorization
 * gate below accepts); any other actor always notifies, so a member can never
 * suppress their own cancellation confirmation. Absent means notify. The choice
 * covers the member-facing cancellation email on every branch — including the
 * linked provisional split children cancelled with the parent — and is recorded
 * in the audit metadata (`notifyMember: false`) whenever suppressed. Refund /
 * credit settlement, audit, booking events, and waitlist processing are
 * unaffected, and the Xero invoice/credit-note side stays untouched.
 */
export async function cancelBooking(
  bookingId: string,
  sessionUserId: string,
  sessionUserRole: string,
  ipAddress: string,
  refundMethod: "card" | "credit" = "card",
  options: {
    suppressCustomerNotification?: boolean;
    hasBookingsEditAccess?: boolean;
    requireRequestHold?: boolean;
    notifyMember?: boolean;
    // #2029: when true, block self-service (non-Full-Admin) cancellation of a
    // stay whose NZ check-in is on or before today. Only the member-facing
    // cancel route opts in; every internal/admin caller leaves it false, so
    // their behaviour is unchanged. See the guard in performBookingCancellation.
    enforceStartedStayBlock?: boolean;
    /**
     * #2576 §7: the officer's explicit confirmation and mandatory reason for
     * overriding a same-owner coverage refusal. Honoured only for an officer-type
     * actor (the same pair the authorization gate accepts) — the disposition helper
     * ignores it for anybody else, so a member cannot self-authorise past §6's
     * block by inventing a reason.
     */
    hostingCoverageOverride?: HostingCoverageOverrideInput;
  } = {}
): Promise<CancelBookingResponse> {
  // Issue #1705: resolve the honoured email choice once, so the main cancel and
  // the linked-children sweep below can never disagree. Non-admin actors are
  // forced to notify (the cancel route additionally 403s their flag).
  const notifyMember =
    sessionUserRole !== "ADMIN" && !(options.hasBookingsEditAccess ?? false)
      ? true
      : options.notifyMember !== false;
  const result = await performBookingCancellation(
    bookingId,
    sessionUserId,
    sessionUserRole,
    ipAddress,
    refundMethod,
    options.suppressCustomerNotification ?? false,
    options.hasBookingsEditAccess ?? false,
    options.requireRequestHold ?? false,
    notifyMember,
    options.enforceStartedStayBlock ?? false,
    options.hostingCoverageOverride ?? null
  );

  if (result.status === 200) {
    await cancelLinkedProvisionalChildBookings(
      bookingId,
      sessionUserId,
      ipAddress,
      notifyMember
    );
    // If this booking hosts a group, clean up the joiners the PENDING-only sweep
    // above never touches (ORGANISER_PAYS children, group closure). Best-effort:
    // the organiser's own cancel has already committed, so a failure here is
    // logged rather than surfaced, and the work is idempotent. A re-invoked
    // cancel 409s upstream (#1160) and never re-enters this path, so a crash
    // mid-cleanup is re-driven by the group-settlement-reaper resume phase
    // (#1236), not by cancelling again.
    await settleGroupBookingOnOrganiserCancel(
      bookingId,
      sessionUserId,
      ipAddress
    ).catch((err) =>
      logger.error(
        { err, bookingId },
        "Failed to clean up group booking on organiser cancel"
      )
    );

    // #2576 §7/§8. The cancellation reconciled the account's other bookings inside
    // its transaction and, where it was an officer's cancellation that took cover
    // away, recorded the bounded re-evaluation as a queue row that committed with
    // it. This is the "immediate re-evaluation" half: re-read the now-committed
    // facts, open or resolve the incident, and notify the owner once. Best-effort —
    // the cancellation is done, and the cron sweep is the authority on completion.
    await settleHostingCoverageAfterCommit({ bookingId });
  }

  return result;
}

/**
 * Cancel any provisional non-member child bookings linked to a cancelled
 * member booking. A child is only provisional while it remains PENDING: the
 * confirm-pending cron can concurrently claim and charge it. Each candidate is
 * therefore re-read and status-claimed under the same global -> per-lodge lock
 * order as the rest of the booking lifecycle. Only the successful claimant
 * runs the no-payment side effects (bed reconcile, promo cleanup, link
 * revocation, audit, event, email and waitlist processing).
 */
async function cancelLinkedProvisionalChildBookings(
  parentBookingId: string,
  sessionUserId: string,
  ipAddress: string,
  notifyMember = true
) {
  const children = await prisma.booking.findMany({
    where: {
      parentBookingId,
      status: "PENDING",
      deletedAt: null,
    },
    // lodgeId is immutable, so it is safe to use this pre-lock snapshot only
    // to choose the per-lodge lock key. All lifecycle fields are re-read below.
    select: { id: true, lodgeId: true },
  });

  for (const candidate of children) {
    const child = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, candidate.lodgeId);

      const fresh = await tx.booking.findUnique({
        where: { id: candidate.id },
        include: { member: true },
      });
      if (
        !fresh ||
        fresh.parentBookingId !== parentBookingId ||
        fresh.status !== BookingStatus.PENDING ||
        fresh.deletedAt !== null
      ) {
        return null;
      }

      const released = await tx.booking.updateMany({
        where: {
          id: candidate.id,
          parentBookingId,
          status: BookingStatus.PENDING,
          deletedAt: null,
        },
        data: {
          status: BookingStatus.CANCELLED,
          ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
          ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
        },
      });
      if (released.count === 0) {
        return null;
      }

      await reconcileCancelledBookingBedAllocations(fresh, tx);
      await revokePaymentLinksForBooking(fresh.id, tx);
      // Split children carry no promo/credit by construction (booking-create),
      // so this is the same auditable-invariant no-op (#1547). The guarded
      // PENDING -> CANCELLED claim makes every in-transaction side effect
      // single-flight even if another writer somehow misses the lock protocol.
      await restoreCreditFromBooking(fresh.memberId, fresh.id, tx);
      return fresh;
    });

    // The cron (or another cancel) won the child claim. Its transition and
    // side effects are authoritative; never emit a stale cancellation event,
    // email or waitlist wake-up for this loser.
    if (!child) {
      continue;
    }

    await cleanupPromoRedemption(child.id);

    logBookingCancellationAudit({
      booking: child,
      bookingId: child.id,
      sessionUserId,
      details:
        "Linked provisional non-member booking cancelled with its member booking",
      ipAddress,
      metadata: {
        linkedParentBookingId: parentBookingId,
        paymentTaken: false,
        ...(notifyMember ? {} : { notifyMember: false }),
      },
    });

    await recordBookingEvent({
      bookingId: child.id,
      type: BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      reason: "Cancelled with the linked member booking. No payment was taken.",
    });

    // Issue #1705: the admin's per-cancel email choice covers the linked child
    // too — "cancel without emailing" must not email the member about the
    // provisional child cancelled alongside their booking.
    if (notifyMember) {
      sendBookingCancelledEmail(
        { bookingId: child.id, recipientMemberId: child.memberId },
        child.member.email,
        child.member.firstName,
        child.checkIn,
        child.checkOut,
        0,
        "card",
        0,
        child.lodgeId
      ).catch((err) =>
        logger.error(
          { err, bookingId: child.id },
          "Failed to send cancellation email for linked provisional booking"
        )
      );
    }

    processWaitlistForDates({
      checkIn: child.checkIn,
      checkOut: child.checkOut,
      lodgeId: child.lodgeId,
    }).catch(
      (err) =>
        logger.error(
          { err, bookingId: child.id },
          "Failed to process waitlist after linked provisional cancellation"
        )
    );
  }
}

async function performBookingCancellation(
  bookingId: string,
  sessionUserId: string,
  sessionUserRole: string,
  ipAddress: string,
  refundMethod: "card" | "credit" = "card",
  suppressCustomerNotification = false,
  hasBookingsEditAccess = false,
  requireRequestHold = false,
  // Issue #1705: already resolved by cancelBooking (forced true for non-admin
  // actors), so every branch below can honour it directly.
  notifyMember = true,
  // #2029: self-service started-stay block (see the guard below). Default false
  // so every internal/admin caller is unaffected.
  enforceStartedStayBlock = false,
  // #2576 §7: the officer's explicit confirmation and reason, or null. Null on
  // every internal caller, which is correct: they are §8 system changes and are
  // never asked to confirm anything.
  hostingCoverageOverride: HostingCoverageOverrideInput | null = null
): Promise<CancelBookingResponse> {
  // Issue #1705 (#1698 pattern): a suppressed admin cancel records the choice in
  // the audit metadata — notifyMember is false only when an authorized admin
  // opted out, so every suppressed cancellation email stays auditable.
  const notifyAuditFields = notifyMember ? {} : { notifyMember: false };
  // #3123 — the CLUB's day, from its persisted `ClubTimeSettings.timeZone`
  // (`INV-CONFIG-002`), resolved ONCE here for the whole cancellation and read
  // BEFORE any transaction below opens.
  //
  // Two decisions on this path need it and they must not be able to disagree:
  // the started-stay gate below, which refuses a member's own cancellation, and
  // the REFUND TIER inside the paid-path claim, which is `daysUntilDate`
  // against the cancellation policy's day thresholds. `INV-LOCK-004` names the
  // club timezone as one of only two reads that cannot take a transaction
  // client, and that claim holds `pg_advisory_xact_lock(1)` — so this cannot be
  // read where it is used.
  //
  // The runtime reader rather than the `server-only` binding: this module is
  // reachable from `instrumentation.node.ts` through `general-cron-runner` ->
  // `booking-request.ts`, and `club-time/server` is a bare throw outside the
  // `react-server` condition.
  const todayAtClub = clubToday(await readClubTimeZoneOutsideRequest());
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking) {
    return { status: 404, error: "Booking not found" };
  }

  // Authorization (issue #1313, option A2): the booking owner, a Full Admin
  // (sessionUserRole === "ADMIN"), OR a Booking Officer (bookings:edit, passed
  // as hasBookingsEditAccess by the member-facing cancel route) may cancel.
  // Adding the officer is an authorization widening ONLY — `sessionUserRole` and
  // `hasBookingsEditAccess` are read nowhere below this gate, so the refund
  // amount, refund method/destination, Stripe path, cancellation email, and
  // audit are all identical regardless of which authorized actor triggered it.
  if (
    booking.memberId !== sessionUserId &&
    sessionUserRole !== "ADMIN" &&
    !hasBookingsEditAccess
  ) {
    return { status: 403, error: "Forbidden" };
  }

  // ── #2029: self-service started-stay cancellation block ──────────────────
  //
  // Before #2029 the completion cron flipped a PAID booking to COMPLETED on its
  // first stay day (checkIn <= today), and COMPLETED is NOT in
  // CANCELLABLE_BOOKING_STATUSES — so a started stay was implicitly
  // non-self-cancellable. #2029 correctly widened the PAID window to run through
  // the whole check-out day, which silently removed that implicit guard: a
  // member (or Booking Officer) could otherwise irreversibly cancel an
  // in-progress, checkout-day, or finished-but-not-yet-swept stay — releasing
  // beds while guests are present, sending a cancellation email, and dropping
  // the stay from roster / stay-night / nomination counts. Restore the invariant
  // for self-service actors only: a Full Admin (sessionUserRole === "ADMIN")
  // keeps full cancellation capability, and a member who needs to leave early
  // shrinks their remaining future nights via the (policy-retained) edit path.
  // Gated behind enforceStartedStayBlock so ONLY the member-facing cancel route
  // opts in; every internal/admin caller (decline, release-hold, review-reject,
  // account-deletion) is byte-for-byte unaffected.
  if (
    enforceStartedStayBlock &&
    sessionUserRole !== "ADMIN" &&
    bookingStayHasStarted(
      booking.checkIn,
      // #3123 — the CLUB's day, resolved once at the top of this function. This
      // gate refuses a member's own cancellation, so a day early is a member
      // told they cannot cancel a stay they are still entitled to cancel.
      dateOnlyInstantOf(todayAtClub),
    )
  ) {
    return {
      status: 400,
      error:
        "This stay has already started, so it can no longer be cancelled online. To leave early, edit the booking to shorten your remaining nights, or contact the club for help.",
    };
  }

  if (!CANCELLABLE_BOOKING_STATUSES.includes(booking.status)) {
    return {
      status: 400,
      error: "Only PENDING, PAYMENT_PENDING, CONFIRMED, PAID, WAITLISTED, WAITLIST_OFFERED, or AWAITING_REVIEW bookings can be cancelled",
    };
  }

  // ── #1406: opt-in caller guard for the two "release a held request" paths ──
  //
  // The admin "Release hold" route and `declineBookingRequest` release a held
  // booking-request slot they expect to still be AWAITING_REVIEW. This OUTER
  // read is UN-locked, so a concurrent quote-accept
  // (`convertBookingRequestToBooking`) can flip the hold AWAITING_REVIEW ->
  // PENDING before it runs. Without this guard the PENDING snapshot would be
  // dispatched straight into the generic PENDING branch below and clobber the
  // just-accepted booking to CANCELLED and revoke its brand-new payment links.
  // The PENDING branch is now itself status-guarded claim-first under lock(1)
  // (#1547), but that only rejects a booking that has LEFT PENDING; a
  // just-accepted booking genuinely IS PENDING, so it passes the branch's own
  // under-lock guard. This pre-dispatch check therefore remains the ONLY
  // protection for the accept-then-release race. Refuse with a 409 loser (NO
  // side effect) BEFORE branch dispatch so a now-PENDING booking is never
  // cancelled by a hold-release. An accept that commits AFTER this read but
  // BEFORE the AWAITING_REVIEW branch takes pg_advisory_xact_lock(1) is caught
  // by that branch's under-lock re-read (the NO_PAYMENT_CANCELLABLE_STATUSES
  // guard) — the two together fully close the race. Opt-in only: callers
  // cancelling genuine member-created PENDING bookings (member self-cancel,
  // deletion cleanup) never pass this option and reach the generic PENDING
  // branch exactly as before.
  if (requireRequestHold && booking.status !== "AWAITING_REVIEW") {
    return {
      status: 409,
      error:
        "This hold can no longer be released (it may have just been accepted).",
    };
  }

  // Bookings awaiting admin review have no payment yet; same no-payment
  // shape as waitlisted/offered. Reuse that path.
  if (NO_PAYMENT_CANCELLABLE_STATUSES.includes(booking.status)) {
    // ── #1311: status-guarded claim-first under the booking advisory lock ──
    //
    // This branch has NO payment and makes NO external-provider (Stripe/Xero)
    // call, so the only hazard is a state CLOBBER, not a double money-move —
    // the "claim-first without durable recovery inverts a crash into money
    // LOSS" caveat does not apply here. The clobber: a held AWAITING_REVIEW
    // booking can be converted to PENDING by a concurrent quote-accept
    // (`approveBookingRequest` in booking-request.ts). Under the two-tier lock
    // protocol (#1881) that accept takes the GLOBAL `pg_advisory_xact_lock(1)`
    // FIRST (then the per-lodge lock) and status-guards its AWAITING_REVIEW →
    // PENDING flip. This branch takes the SAME global lock(1) and both the
    // under-lock re-read gate below AND a status-guarded `updateMany` on the
    // CANCELLED flip, so cancel and accept mutually exclude on the shared key
    // and neither can clobber the other: the race loser observes a
    // non-cancellable status (re-read gate or count 0) and aborts cleanly with a
    // 409, running none of the side effects below. This mirrors the paid
    // single-flight claim (#1160) further down.
    const claim = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      // Re-read the FULL row under the lock (same `include`s as the outer read
      // above and the paid #1160 claim below) so the winner path sources its
      // downstream reconcile, audit, cancellation email, and waitlist re-process
      // from this authoritative under-lock read rather than the pre-lock
      // `booking` snapshot. Dates/member are immutable while the booking is in
      // the no-payment set, so this is defensive — it removes any reliance on
      // that invariant and matches the paid path (#1311 follow-up to #1334).
      const fresh = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { payment: true, member: true },
      });
      // Race loser / retry: under the lock the booking has left the no-payment
      // set (a concurrent quote-accept converted it, or another cancel already
      // claimed it). Do NOT flip status, detach, reconcile, or run any side
      // effects.
      if (!fresh || !NO_PAYMENT_CANCELLABLE_STATUSES.includes(fresh.status)) {
        return { claimed: false as const };
      }
      if (fresh.lodgeId) await acquireLodgeCapacityLock(tx, fresh.lodgeId);

      const wasOffered = fresh.status === "WAITLIST_OFFERED";
      const wasAwaitingReview = fresh.status === "AWAITING_REVIEW";

      // Status-guarded release (#1881): flip only while the booking is still in
      // the no-payment cancellable set. Redundant with the under-lock re-read
      // under lock(1), but it makes the "no clobber" guarantee structural rather
      // than lock-dependent.
      const released = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: { in: [...NO_PAYMENT_CANCELLABLE_STATUSES] as BookingStatus[] },
        },
        data: {
          status: "CANCELLED",
          ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
          ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
          waitlistPosition: null,
          // Clear the cross-lodge offer residue too (ADR-004): a cancelled
          // WAITLIST_OFFERED entry must not keep a stale offered lodge/price.
          // Inert for non-offered statuses (already null), but keeps the row
          // honest.
          waitlistOfferedLodgeId: null,
          waitlistOfferedPriceCents: null,
        },
      });
      if (released.count === 0) {
        return { claimed: false as const };
      }
      if (wasAwaitingReview) {
        // Detach any booking-request pointer to this hold so a later re-quote
        // creates a fresh hold instead of reusing this now-cancelled row
        // (#1254 stale-pointer fix). holdBookingRequestSlots also re-validates
        // defensively, but detaching at the source keeps the pointer honest.
        await tx.bookingRequest.updateMany({
          where: { heldBookingId: bookingId },
          data: { heldBookingId: null, version: { increment: 1 } },
        });
      }
      // Bed release is now ATOMIC with the status flip under the lock, sourced
      // from the under-lock `fresh` read.
      await reconcileCancelledBookingBedAllocations(fresh, tx);

      // No-op today for these statuses — kept so "every cancel branch restores
      // applied credit" is an auditable invariant (#1547). Runs inside the
      // existing claim tx, so the claim's atomic status flip remains the
      // exactly-once guarantee for the (guardless) restore.
      const creditRestoredCents = await restoreCreditFromBooking(
        fresh.memberId,
        bookingId,
        tx
      );

      // #2576 §6. Cancellation is the first change class the owner names, and it
      // is the one that removes attendance outright: cancelling the booking a
      // qualifying adult member is staying on can leave ANOTHER booking on the same
      // account without cover for the exact nights its non-member guests are there.
      // Reconciling inside the claim transaction is what makes the refusal real —
      // the throw rolls the cancellation back, so a member cannot strand their own
      // other booking, while an officer's cancellation is allowed and escalated to
      // an urgent compliance incident instead (§7, §8). Also clears this booking's
      // own hosting review, since a cancelled stay has no hazard.
      await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
        ...hostingCoverageActorOptions({
          actorRole: sessionUserRole,
          hasBookingsEditAccess,
          actorMemberId: sessionUserId,
          ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
        }),
      });

      return {
        claimed: true as const,
        fresh,
        wasOffered,
        wasAwaitingReview,
        priorStatus: fresh.status,
        creditRestoredCents,
      };
    });

    // Loser contract (mirrors the paid single-flight path, #1160): a concurrent
    // quote-accept / cancel that transitioned the row out of the no-payment set
    // gets a real 409. This MUST be non-200 so a caller never treats a clobbered
    // accept as a successful cancel. Every cancelBooking caller forwards this
    // 409 (release-hold, member cancel, admin review-reject) or aborts safely
    // (deletion-requests, which never passes a no-payment-holding status).
    if (!claim.claimed) {
      return {
        status: 409,
        error:
          "This booking was concurrently accepted or cancelled and can no longer be cancelled",
      };
    }

    const { fresh, wasOffered, wasAwaitingReview, priorStatus, creditRestoredCents } =
      claim;

    // cleanupPromoRedemption opens its own $transaction, so it runs AFTER the
    // claim commits — never nested under the advisory lock.
    await cleanupPromoRedemption(bookingId);

    // Audit/email/waitlist below all source from the under-lock `fresh` row.
    // `statusBefore` therefore reads `fresh.status` (the pre-cancel status the
    // locked read observed — the `tx.booking.update` above returns a new row and
    // never mutates `fresh`), consistent with priorStatus/wasOffered/wasAwaiting.
    logBookingCancellationAudit({
      booking: fresh,
      bookingId,
      sessionUserId,
      details: wasAwaitingReview
        ? "Booking awaiting admin review cancelled"
        : `Waitlisted booking cancelled (was ${wasOffered ? "WAITLIST_OFFERED" : "WAITLISTED"})`,
      ipAddress,
      metadata: {
        wasOffered,
        priorStatus,
        creditRestoredCents,
        ...notifyAuditFields,
      },
    });

    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      reason: wasAwaitingReview
        ? "Cancelled while awaiting admin review. No payment was taken."
        : "Cancelled before payment. No payment was taken.",
    });

    // #1255: the admin "Release hold" action cancels this held booking to
    // re-open owner mapping and passes suppressCustomerNotification, so the
    // requester is not emailed a cancellation for a hold being administratively
    // released. The detach/reconcile/audit above still run. #1705: the admin's
    // per-cancel email choice suppresses the same email.
    if (!suppressCustomerNotification && notifyMember) {
      sendBookingCancelledEmail(
        { bookingId: fresh.id, recipientMemberId: fresh.memberId },
        fresh.member.email,
        fresh.member.firstName,
        fresh.checkIn,
        fresh.checkOut,
        0,
        "card",
        creditRestoredCents,
        fresh.lodgeId
      ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email for no-payment booking"));
    }

    // If the booking was WAITLIST_OFFERED, re-process waitlist for these dates
    if (wasOffered) {
      processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut, lodgeId: fresh.lodgeId })
        .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after offer cancellation"));
    }

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card" as const,
        creditRestoredCents: creditRestoredCents || undefined,
        message: wasAwaitingReview
          ? "Booking awaiting review cancelled successfully"
          : "Waitlisted booking cancelled successfully",
      },
    };
  }

  // Handle PENDING bookings (no payment taken yet)
  if (booking.status === "PENDING") {
    if (booking.payment?.stripeSetupIntentId) {
      try {
        await cancelSetupIntentIfCancellable(booking.payment.stripeSetupIntentId);
      } catch (err) {
        logger.error(
          { err, bookingId, setupIntentId: booking.payment.stripeSetupIntentId },
          "Failed to cancel Stripe SetupIntent for cancelled pending booking"
        );
      }
    }

    // ── #1547: status-guarded claim-first under the booking advisory lock ──
    const claim = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const fresh = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { payment: true, member: true },
      });
      // A capture (markBookingPaymentSucceeded pays PENDING bookings) or a
      // concurrent cancel can transition the row before the lock is taken; the
      // loser must not clobber it. Closes the "PENDING branch is UNLOCKED, no
      // status re-guard" caveat documented in the #1406 comment.
      if (!fresh || fresh.status !== "PENDING") {
        return { claimed: false as const };
      }
      if (fresh.lodgeId) await acquireLodgeCapacityLock(tx, fresh.lodgeId);
      if (fresh.payment) {
        await tx.payment.update({
          where: { id: fresh.payment.id },
          data: { stripeSetupIntentId: null },
        });
      }
      // Status-guarded release (#1881): flip only while still PENDING. Also
      // release the exclusive whole-lodge hold (#1911) alongside the admin
      // capacity hold so a cancelled PENDING booking never leaves a stale hold.
      const released = await tx.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.PENDING },
        data: {
          status: "CANCELLED",
          ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
          ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
        },
      });
      if (released.count === 0) {
        return { claimed: false as const };
      }
      await reconcileCancelledBookingBedAllocations(fresh, tx);
      await revokePaymentLinksForBooking(bookingId, tx);
      // No-op today (credit is only applied at PAYMENT_PENDING create) — kept
      // so "every cancel branch restores applied credit" is an auditable
      // invariant (#1547). restoreCreditFromBooking has no internal replay
      // guard; this claim's atomic status flip is its exactly-once guarantee.
      const creditRestoredCents = await restoreCreditFromBooking(
        fresh.memberId,
        bookingId,
        tx
      );
      // #2576 §6. Cancellation is the first change class the owner names, and it
      // is the one that removes attendance outright: cancelling the booking a
      // qualifying adult member is staying on can leave ANOTHER booking on the same
      // account without cover for the exact nights its non-member guests are there.
      // Reconciling inside the claim transaction is what makes the refusal real —
      // the throw rolls the cancellation back, so a member cannot strand their own
      // other booking, while an officer's cancellation is allowed and escalated to
      // an urgent compliance incident instead (§7, §8). Also clears this booking's
      // own hosting review, since a cancelled stay has no hazard.
      await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
        ...hostingCoverageActorOptions({
          actorRole: sessionUserRole,
          hasBookingsEditAccess,
          actorMemberId: sessionUserId,
          ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
        }),
      });

      return { claimed: true as const, fresh, creditRestoredCents };
    });

    if (!claim.claimed) {
      return {
        status: 409,
        error:
          "This booking was concurrently paid or cancelled and can no longer be cancelled",
      };
    }

    const { fresh, creditRestoredCents } = claim;

    await cleanupPromoRedemption(bookingId);

    logBookingCancellationAudit({
      booking: fresh,
      bookingId,
      sessionUserId,
      details: "Pending booking cancelled, no payment taken",
      ipAddress,
      metadata: {
        paymentTaken: false,
        setupIntentCancelled: Boolean(fresh.payment?.stripeSetupIntentId),
        creditRestoredCents,
        ...notifyAuditFields,
      },
    });

    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      reason: appendReturnedCreditSentence(
        "Cancelled before payment. No payment was taken.",
        creditRestoredCents
      ),
    });

    if (notifyMember) {
      sendBookingCancelledEmail(
        { bookingId: fresh.id, recipientMemberId: fresh.memberId },
        fresh.member.email,
        fresh.member.firstName,
        fresh.checkIn,
        fresh.checkOut,
        0,
        "card",
        creditRestoredCents,
        fresh.lodgeId
      ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));
    }

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut, lodgeId: fresh.lodgeId })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after pending cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card",
        creditRestoredCents: creditRestoredCents || undefined,
        message: "Pending booking cancelled. No payment was taken.",
      },
    };
  }

  // #1491 (owner decision, Option 1): a genuinely CAPTURED
  // PARTIALLY_REFUNDED payment takes the paid path below — the member gets
  // the cancellation-policy tier of the REMAINING captured value
  // (paidAmountCents already nets out refundedAmountCents). Eligibility is
  // ledger-only (see the helper), so the folded-mirror never-captured IB
  // population and mirror-only legacy rows stay out of the refund path.
  const paidRefundPathEligible = await paymentEligibleForPaidCancelPath(
    booking.payment
  );

  // Handle PAYMENT_PENDING/CONFIRMED/PAID bookings without a payment the
  // paid refund path can claim: never-captured payments (including the
  // folded-mirror shape) and fully-REFUNDED ones (#1473).
  if (!paidRefundPathEligible) {
    // #1473: a payment that CAPTURED money can land in this branch too
    // (fully REFUNDED, or a flattened legacy mirror), and its aggregate
    // status is money truth that must survive the cancel — only
    // never-captured payments flip to FAILED. See paymentHasCaptureEvidence
    // for why the ledger decides, never the aggregate mirror alone.
    const paymentCaptured = booking.payment
      ? await paymentHasCaptureEvidence(booking.payment)
      : false;

    if (booking.payment) {
      await cancelOutstandingPaymentIntents({
        primaryPaymentIntentId: booking.payment.stripePaymentIntentId,
        additionalPaymentIntentId: booking.payment.additionalPaymentIntentId,
        // A captured primary intent is not cancellable; skip the Stripe call
        // instead of relying on the downstream captured-status guards.
        cancelPrimary: !paymentCaptured,
        cancelAdditional: hasOutstandingAdditionalPaymentIntent(booking.payment),
      });
    }

    // ── #1547: claim-first restore under the booking advisory lock ─────
    //
    // Mirrors the paid path (tx1) below: take pg_advisory_xact_lock(1),
    // re-read the booking under the lock, gate out the race losers, then do
    // ALL DB writes — including the applied-credit restore — inside the tx.
    // Capture (markBookingPaymentSucceeded) and the inbound Xero reconcile
    // both take lock(1), so this serializes cancel-vs-capture and
    // cancel-vs-reconcile. restoreCreditFromBooking has no internal replay
    // guard, so it MUST only run inside a claim that guarantees exactly-once;
    // the atomic status flip is that claim.
    const claim = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const fresh = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { payment: true, member: true },
      });
      // Loser gates. Statuses: this branch is only dispatched for
      // PAYMENT_PENDING/CONFIRMED/PAID; anything else under the lock means a
      // concurrent transition already claimed the booking.
      if (
        !fresh ||
        !["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(fresh.status)
      ) {
        return { claimed: false as const };
      }
      // A capture landed between the outer read and this lock: refuse with the
      // standard 409 so a retry routes into the paid path and gets the tiered
      // refund (never flatten a now-captured payment here).
      if (await paymentEligibleForPaidCancelPath(fresh.payment, tx)) {
        return { claimed: false as const };
      }
      if (fresh.lodgeId) await acquireLodgeCapacityLock(tx, fresh.lodgeId);

      // #1881 lock topology: this path already holds global lock(1); take the
      // member-ledger lock second before inspecting deallocation state or
      // repairing/reading precise allocation slices. Inbound Xero repair and
      // allocation/deallocation workers use this same member key.
      await lockMemberCreditLedger(fresh.memberId, tx);

      if (
        fresh.payment &&
        (await findUnconvergedAppliedCreditDeallocation(fresh.payment.id, tx))
      ) {
        return {
          claimed: false as const,
          blockedByAppliedCreditDeallocation: true as const,
        };
      }

      const freshPaymentCaptured = fresh.payment
        ? await paymentHasCaptureEvidence(fresh.payment, tx)
        : false;

      const paymentUpdateData: {
        status?: "FAILED";
        additionalPaymentStatus?: string;
      } = {};
      if (!freshPaymentCaptured) {
        paymentUpdateData.status = "FAILED";
      }
      if (hasOutstandingAdditionalPaymentIntent(fresh.payment)) {
        paymentUpdateData.additionalPaymentStatus = "FAILED";
      }
      if (fresh.payment && Object.keys(paymentUpdateData).length > 0) {
        await tx.payment.update({
          where: { id: fresh.payment.id },
          data: paymentUpdateData,
        });
      }
      // Status-guarded release (#1881): claim only while still in the
      // never-captured cancellable set. The loser gate above plus lock(1)
      // already single-flight this, but the guard makes it structural. Also
      // release the exclusive whole-lodge hold (#1911) alongside the admin
      // capacity hold.
      const released = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: {
            in: [
              BookingStatus.PAYMENT_PENDING,
              BookingStatus.CONFIRMED,
              BookingStatus.PAID,
            ],
          },
        },
        data: {
          status: "CANCELLED",
          ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
          ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
        },
      });
      if (released.count === 0) {
        return { claimed: false as const };
      }
      await reconcileCancelledBookingBedAllocations(fresh, tx);

      // 100% restore — ledger truth, NO override argument (owner decision:
      // nothing was captured, so no cancellation-policy tiering).
      const creditRestoredCents = await restoreCreditFromBooking(
        fresh.memberId,
        bookingId,
        tx
      );

      // Applied-credit rows the inbound reconcile linked to a real Xero
      // credit-note allocation against this booking's invoice: the invoice's
      // outstanding balance in Xero is already reduced by these, so the
      // clearing note below must not re-credit them (Xero rejects
      // over-allocation and the outbox op would poison). Read under lock(1) —
      // the inbound reconcile serializes on the same lock.
      // Use the precise allocation-slice ledger. The MemberCredit Xero-note
      // stamp is historical and remains on the original row after a partial
      // deallocation, so it would understate the invoice clearing amount.
      if (fresh.payment?.xeroInvoiceId) {
        await repairLegacyAppliedCreditNoteAllocationsForBooking(
          bookingId,
          fresh.payment.xeroInvoiceId,
          tx,
        );
      }
      const xeroAllocated = await tx.memberCreditNoteAllocation.aggregate({
        where: {
          appliedToBookingId: bookingId,
        },
        _sum: { amountCents: true },
      });
      const xeroAllocatedAppliedCreditCents = Math.max(
        0,
        xeroAllocated._sum.amountCents ?? 0
      );

      // #2576 §6. Cancellation is the first change class the owner names, and it
      // is the one that removes attendance outright: cancelling the booking a
      // qualifying adult member is staying on can leave ANOTHER booking on the same
      // account without cover for the exact nights its non-member guests are there.
      // Reconciling inside the claim transaction is what makes the refusal real —
      // the throw rolls the cancellation back, so a member cannot strand their own
      // other booking, while an officer's cancellation is allowed and escalated to
      // an urgent compliance incident instead (§7, §8). Also clears this booking's
      // own hosting review, since a cancelled stay has no hazard.
      await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
        ...hostingCoverageActorOptions({
          actorRole: sessionUserRole,
          hasBookingsEditAccess,
          actorMemberId: sessionUserId,
          ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
        }),
      });

      return {
        claimed: true as const,
        fresh,
        freshPaymentCaptured,
        creditRestoredCents,
        xeroAllocatedAppliedCreditCents,
      };
    });

    // Loser contract (mirrors the paid single-flight path, #1160): a
    // concurrent capture / cancel that transitioned the row gets a real 409,
    // never a false 200. A capture win routes the retry into the paid path.
    if (!claim.claimed) {
      if ("blockedByAppliedCreditDeallocation" in claim) {
        return {
          status: 409,
          error:
            "Applied credit is still being reconciled with Xero; retry cancellation after it completes",
        };
      }
      return {
        status: 409,
        error: "This booking is already being cancelled or has been cancelled",
      };
    }

    const {
      fresh,
      freshPaymentCaptured,
      creditRestoredCents,
      xeroAllocatedAppliedCreditCents,
    } = claim;

    if (creditRestoredCents > 0) {
      logger.info(
        { bookingId, creditRestoredCents },
        "Restored previously applied credit on never-captured cancellation"
      );
    }

    await cleanupPromoRedemption(bookingId);

    // Clear the outstanding balance on an unpaid issued invoice. The true
    // amount owed is the current finalPrice plus any billed change fee: a
    // prior reduction issues a modification credit note against the primary
    // invoice but never reissues it, so the invoice's outstanding balance is
    // originalTotal minus those credit notes = finalPrice. Reading
    // `amountCents - refundedAmountCents` instead over-credits during the
    // window before async Xero reconciliation folds the modification credit
    // note into refundedAmountCents (the mirror stays at the original total),
    // issuing a clearing credit note larger than the invoice (#1015). The old
    // `Math.max` only ever picked that stale term in exactly that leak window;
    // for price increases (billed via a separate supplementary invoice) and
    // for unchanged bookings finalPrice already equals the true outstanding.
    // #1473: that reasoning only holds for a NEVER-captured payment. For
    // captured money, finalPrice+changeFee is not the invoice's open balance:
    // normally the invoice is settled Xero-side, and in the one window where
    // it is not (the capture's Xero payment-record op failed and is retrying)
    // a clearing note would close the invoice underneath that retry and
    // permanently poison it — recording the payment then fails against a
    // zeroed invoice. Enqueue nothing; the op retry stack owns the recording,
    // and the operator repair pass owns anything else.
    // #1547 (verified): the booking invoice is issued at the FULL
    // finalPriceCents (guest line items + promo adjustment line — see
    // createXeroInvoiceForBooking / buildInvoiceLineItems in
    // src/lib/xero-booking-invoices.ts), NEVER at the credit-reduced
    // effectivePriceCents, so finalPrice + changeFee matches the invoice's
    // nominal outstanding. The only reduction needed is any credit-note
    // allocations already applied to the invoice in Xero, mirrored locally as
    // BOOKING_APPLIED rows carrying xeroCreditNoteId (see
    // src/lib/xero-inbound/credit-note-repairs.ts). Subtract exactly those
    // (floored at 0) so the clearing note never over-allocates the invoice.
    const xeroClearingAmountCents =
      fresh.payment?.xeroInvoiceId && !freshPaymentCaptured
        ? Math.max(
            0,
            fresh.finalPriceCents +
              fresh.payment.changeFeeCents -
              xeroAllocatedAppliedCreditCents
          )
        : 0;

    if (fresh.payment?.id && xeroClearingAmountCents > 0) {
      try {
        const queuedCreditNote = await enqueueXeroModificationCreditNoteOperation(
          {
            bookingId,
            refundAmountCents: xeroClearingAmountCents,
          },
          {
            createdByMemberId: sessionUserId,
          }
        );

        if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
          void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
            logger.error(
              { err: xeroErr, bookingId, paymentId: fresh.payment?.id },
              "Failed to kick Xero invoice-clearing credit note outbox worker"
            );
          });
        }
      } catch (xeroErr) {
        logger.error(
          {
            err: xeroErr,
            bookingId,
            paymentId: fresh.payment.id,
            xeroClearingAmountCents,
          },
          "Failed to queue Xero invoice-clearing credit note for cancelled unpaid booking"
        );
      }
    }

    logBookingCancellationAudit({
      booking: fresh,
      bookingId,
      sessionUserId,
      details: freshPaymentCaptured
        ? "Confirmed booking cancelled; previously captured payment keeps its refund history (status preserved, no Xero clearing note queued)"
        : xeroClearingAmountCents > 0
          ? `Confirmed booking cancelled before payment capture; queued Xero credit note for ${xeroClearingAmountCents} cents to clear the outstanding invoice`
          : "Confirmed booking cancelled, no payment to refund",
      ipAddress,
      metadata: {
        paymentTaken: freshPaymentCaptured,
        capturedPaymentStatusPreserved: freshPaymentCaptured,
        xeroClearingAmountCents,
        xeroAllocatedAppliedCreditCents,
        queuedXeroClearingCreditNote: xeroClearingAmountCents > 0,
        creditRestoredCents,
        ...notifyAuditFields,
      },
    });

    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: sessionUserId,
      reason: appendReturnedCreditSentence(
        freshPaymentCaptured
          ? "Cancelled. The previously captured payment keeps its refund history; this cancellation issued no additional refund."
          : "Cancelled before payment was captured. Nothing was charged.",
        creditRestoredCents
      ),
    });

    if (notifyMember) {
      sendBookingCancelledEmail(
        { bookingId: fresh.id, recipientMemberId: fresh.memberId },
        fresh.member.email,
        fresh.member.firstName,
        fresh.checkIn,
        fresh.checkOut,
        0,
        "card",
        creditRestoredCents,
        fresh.lodgeId
      ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));
    }

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut, lodgeId: fresh.lodgeId })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after confirmed cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card",
        creditRestoredCents: creditRestoredCents || undefined,
        message: freshPaymentCaptured
          ? "Booking cancelled. The payment's existing refund history is unchanged; no additional refund was issued."
          : xeroClearingAmountCents > 0
            ? "Booking cancelled. Any outstanding Xero invoice balance is being cleared."
            : "Booking cancelled. No refund applicable.",
      },
    };
  }

  // #1491 (review): a captured Internet Banking payment has no Stripe intent
  // to refund — "card" would plan zero Stripe slices yet still record a
  // REFUNDED event, email "refund processed", and book a Xero cash-refund
  // credit note for money that never moved. Bank-transfer money always
  // refunds as account credit, so the method is coerced BEFORE the tier is
  // computed (credit and card tiers can differ) and everything downstream —
  // policy math, branches, events, emails, audit — sees one consistent
  // method. The cancel-preview surface returns both methods' figures, so
  // preview parity holds.
  if (booking.payment?.source === "INTERNET_BANKING") {
    refundMethod = "credit";
  }

  // ── PAID PATH: single-flight claim-first (#1160) ──────────────────
  //
  // Phase 1 (tx1) is a DB-only critical section under the global booking
  // advisory lock. It re-reads the booking under the lock, freezes the refund
  // plan from that locked read, flips status to CANCELLED, and — atomically
  // with that flip — writes the refund-allocation + credit ledger entries
  // (credit path) or the refund-recovery operation with its frozen allocation
  // plan (card path, F2 #1349). NO Stripe/Xero calls happen inside tx1.
  //
  // The atomic status flip is the single-flight CLAIM and the only
  // idempotency guarantee this path needs. The credit writers
  // (restoreCreditFromBooking / applyLocalRefundAllocation /
  // createCancellationCredit) run exactly once per successful claim; a retry
  // or a concurrent cancel re-reads a non-cancellable/non-paid booking here
  // (or trips the pre-existing status-400 guard above) and returns 409 without
  // moving any money. That is why we deliberately do NOT add
  // description-string idempotency guards to the credit writers: restore and
  // cancellation-credit both legitimately write
  // CANCELLATION_REFUND/sourceBookingId for one booking, so no
  // (sourceBookingId,type) unique key is possible, and a description match
  // would be fragile in money code.
  //
  // #1547: restoreCreditFromBooking is NOT paid-path-only anymore. Every cancel
  // branch now restores applied credit inside its own lock(1) claim — this paid
  // path at the cancellation tier (#1164/D7), and the never-captured / PENDING /
  // no-payment branches above at 100% (nothing was captured). Each claim's
  // atomic status flip is that branch's exactly-once guarantee for the
  // (guardless) restore writer.
  const claim = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const fresh = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true, member: true },
    });

    // Single-flight gate: the race loser / a retry lands here.
    if (
      !fresh ||
      !CANCELLABLE_BOOKING_STATUSES.includes(fresh.status) ||
      !fresh.payment
    ) {
      return { claimed: false as const };
    }
    if (fresh.lodgeId) await acquireLodgeCapacityLock(tx, fresh.lodgeId);
    // #1491: the same paid-path eligibility as the outer gate, re-derived
    // under the lock (the outer read is stale by definition here). A
    // genuinely captured PARTIALLY_REFUNDED payment claims; the folded-mirror
    // never-captured shape never reaches this transaction (outer gate), and
    // if racing writes degrade the payment between the reads, refusing the
    // claim (409) is the safe outcome.
    const freshPaidPathEligible = await paymentEligibleForPaidCancelPath(
      fresh.payment,
      tx
    );
    if (!freshPaidPathEligible) {
      return { claimed: false as const };
    }
    const payment = fresh.payment;

    // #1491 (review): materialize any folded (mirror-only) refund into the
    // capture ledger BEFORE executing new refunds. The inbound reconcile
    // folds invoice-applied modification credit notes into the payment
    // mirror's refundedAmountCents without touching transaction rows; the
    // refund writers below end by recomputing the mirror from the ledger sum
    // (reconcilePaymentAggregates), which would silently erase that folded
    // history — and the allocation planners would treat the folded money as
    // still refundable. Attributing the fold to the captured rows (oldest
    // first, capped at each row's headroom) keeps mirror and ledger telling
    // the same story and tightens the planners' caps.
    if (payment.status === "PARTIALLY_REFUNDED") {
      const capturedRows = await tx.paymentTransaction.findMany({
        where: {
          paymentId: payment.id,
          status: {
            in: ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"],
          },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, amountCents: true, refundedAmountCents: true },
      });
      const ledgerRefundedCents = capturedRows.reduce(
        (sum, row) => sum + row.refundedAmountCents,
        0
      );
      let foldedCents = payment.refundedAmountCents - ledgerRefundedCents;
      for (const row of capturedRows) {
        if (foldedCents <= 0) {
          break;
        }
        const headroomCents = row.amountCents - row.refundedAmountCents;
        if (headroomCents <= 0) {
          continue;
        }
        const bumpCents = Math.min(headroomCents, foldedCents);
        await tx.paymentTransaction.update({
          where: { id: row.id },
          data: { refundedAmountCents: row.refundedAmountCents + bumpCents },
        });
        foldedCents -= bumpCents;
      }
    }

    // Freeze the refund plan from the LOCKED read. Change fees (from prior
    // booking modifications) are non-refundable (INV-PAY-018). The refundable
    // base is capped at the booking's current value (#1031): a stale Payment
    // mirror (credit-settled reductions, IB invoices paid at a reduced amount,
    // penalty-window retentions) would otherwise pay out more than the booking
    // is worth. Paid-path twin of the #1015/#1029 unpaid-invoice clearing rule.
    // Computed BEFORE the credit restore so the applied-credit slice can be
    // tiered off the same base/tier as the card slice (#1164 / D7).
    const paidAmountCents = payment.amountCents - payment.refundedAmountCents;
    const refundableBaseCents =
      Math.min(paidAmountCents, fresh.finalPriceCents + payment.changeFeeCents) -
      payment.changeFeeCents;
    // #3123 — THE REFUND TIER. The club's day, resolved before this
    // transaction opened (`INV-LOCK-004`); it used to be the container's,
    // projected out of `APP_TIME_ZONE`, which tiered every club behind
    // Greenwich one day short of its own published cancellation policy.
    const days = daysUntilDate(fresh.checkIn, todayAtClub);
    const policy = await loadCancellationPolicy(fresh.checkIn, fresh.lodgeId, tx);

    // Idempotent-by-claim credit restore: only reached once per claim. The
    // applied-credit slice is now tiered by the SAME card tier as the card
    // slice (#1164 / D7) rather than restored at 100%. Tier off the mirror
    // payment.creditAppliedCents (NOT the ledger sum) so the actual restore
    // matches the preview input; restoreCreditFromBooking caps the override at
    // the ledger sum in the SAFE (never over-restore) direction.
    //
    // #2397 (F8), DECIDED, not accidental. When a cash settlement recorded LESS
    // than the booking's price because the money did not cover an outstanding
    // addition, `payment.amountCents` is the smaller figure, so
    // `refundableBaseCents` above is smaller too. Inside
    // calculateAppliedCreditRestore that shrinks `cardGross`, which raises
    // `feeRemainder` (the tier's fixed fee is charged ONCE per cancellation,
    // card-first), which can reduce the restored credit by up to that fixed
    // fee. That is the intended behaviour on all three counts:
    //
    //  * the card slice must be tiered off what the member ACTUALLY paid — the
    //    club cannot refund a percentage of money it never received;
    //  * the fixed cancellation fee is a fee for cancelling, not a share of
    //    what was handed over, so it must not shrink or vanish because the
    //    member paid less. Letting it fall through to the credit slice is
    //    exactly the "fee once, card-first" rule already in force; and
    //  * the member is not out of pocket overall — they still hold the
    //    uncollected addition, which is strictly larger than the extra fee
    //    absorption (capped at the tier's fixed fee), and the club stops
    //    chasing it on cancellation.
    //
    // The alternative — tiering the credit slice off the booking's PRICE rather
    // than the amount paid — would charge a member who paid in full more
    // cancellation fee than one who underpaid, which is worse.
    let creditRestoredCents = 0;
    if (payment.creditAppliedCents > 0) {
      const { creditRestoredCents: creditToRestore } = calculateAppliedCreditRestore(
        payment.creditAppliedCents,
        refundableBaseCents,
        days,
        policy,
      );
      creditRestoredCents = await restoreCreditFromBooking(
        fresh.memberId,
        bookingId,
        tx,
        creditToRestore,
      );
    }

    const { refundAmountCents, refundPercentage } = calculateRefundAmount(
      refundableBaseCents,
      days,
      policy,
      refundMethod
    );
    const shouldFailAdditionalPayment =
      hasOutstandingAdditionalPaymentIntent(payment);

    // CLAIM: the atomic single-flight commit.
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: "CANCELLED",
        ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
        ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
      },
    });

    // Fail the additional-payment DB state in-tx; the Stripe cancellation of
    // the additional intent is external and runs best-effort in Phase 2.
    if (shouldFailAdditionalPayment) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { additionalPaymentStatus: "FAILED" },
      });
      if (payment.additionalPaymentIntentId) {
        await markPaymentIntentTransactionFailed({
          paymentIntentId: payment.additionalPaymentIntentId,
          store: tx,
        });
        // F1 (#1350): persist a durable CANCEL_PAYMENT_INTENT recovery
        // operation ATOMICALLY with the claim. The Phase-2 Stripe cancel of
        // this intent is best-effort only, so without this row a member
        // confirming the additional payment in a stale tab as/after the
        // cancel commits was charged for a CANCELLED booking with no refund
        // and no alert. With the row, the recovery cron cancels the intent
        // (or, if Stripe already captured, hands it off to a full refund),
        // and the payment_intent.succeeded webhook's superseded-intent hook
        // routes a racing capture straight to refund recovery.
        const additionalTransaction = await tx.paymentTransaction.findFirst({
          where: {
            paymentId: payment.id,
            stripePaymentIntentId: payment.additionalPaymentIntentId,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, amountCents: true },
        });
        if (additionalTransaction) {
          await enqueuePaymentIntentCancellationRecovery({
            bookingId,
            paymentId: payment.id,
            paymentTransactionId: additionalTransaction.id,
            paymentIntentId: payment.additionalPaymentIntentId,
            amountCents: additionalTransaction.amountCents,
            store: tx,
          });
        } else {
          // No ledger row for the outstanding intent (legacy mirror-only
          // payment): the webhook status guard (#1350 part 1) remains the
          // backstop for a late capture.
          logger.warn(
            {
              bookingId,
              paymentId: payment.id,
              additionalPaymentIntentId: payment.additionalPaymentIntentId,
            },
            "No payment transaction row for outstanding additional intent; skipping durable cancellation recovery enqueue"
          );
        }
      }
    }

    await reconcileCancelledBookingBedAllocations(fresh, tx);

    // Credit-path ledger writes, ATOMIC with the claim (fixes hazard #3):
    // consumed refundable value and the credit entry commit together with the
    // status flip, so a crash can never leave one without the other.
    // B5 (#2262): a CASH / off-Xero settlement is handed back by a person, not
    // by Stripe and not as account credit. Disposition is keyed on the
    // payment's manual PROVENANCE, never on its source — a genuine
    // Xero-reconciled internet-banking payment still credits as before.
    //
    // Deliberately NOT applyLocalRefundAllocation here: the ledger must not
    // claim money was returned before it was. The allocation is written when
    // the task is COMPLETED. Deliberately NOT createCancellationCredit either:
    // minting credit alongside a cash payout is a double refund. The policy
    // MATH is unchanged — refundMethod is already coerced to "credit" for an
    // internet-banking payment above, which is the owner-decided tier (28 Jul).
    const manualDisposition = Boolean(payment.manuallyMarkedPaidAt);
    let manualRefundTaskId: string | null = null;
    if (manualDisposition && refundAmountCents > 0) {
      const task = await tx.manualRefundTask.create({
        data: {
          bookingId,
          paymentId: payment.id,
          amountCents: refundAmountCents,
          // #2797: the typed reason replaces reason-string sniffing. This is the
          // cash/off-Xero cancellation hand-back (B5, #2262). `raisedAmountCents`
          // mirrors the amount it was raised with so the row itself records that
          // this task's amount is not admin-amendable — it was fixed at creation.
          kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
          raisedAmountCents: refundAmountCents,
          reason: `Booking ${bookingId} cancelled — cash/manual settlement, refund by hand (${refundPercentage}% under the policy in effect at the time).`.slice(
            0,
            500
          ),
        },
        select: { id: true },
      });
      manualRefundTaskId = task.id;
    } else if (refundMethod === "credit" && refundAmountCents > 0) {
      await applyLocalRefundAllocation({
        paymentId: payment.id,
        amountCents: refundAmountCents,
        store: tx,
      });
      await createCancellationCredit(
        fresh.memberId,
        refundAmountCents,
        bookingId,
        undefined,
        tx
      );
    }

    // Card-path refund debt, ATOMIC with the claim (F2, #1349): persist the
    // recovery operation — with the refund allocation frozen from this locked
    // read — BEFORE any external call, mirroring group-cancel's
    // persist-the-plan-first pattern. A process death anywhere between this
    // commit and the Stripe refund (a window that includes the Phase-2
    // best-effort Stripe cancel of any additional intent, i.e. a network
    // call) now leaves a PENDING operation the recovery cron replays instead
    // of a silently lost refund; a re-invoked cancel 409s by design and could
    // never re-drive it. The frozen plan makes inline-vs-cron replay
    // exactly-once by construction: both execute the identical slices, so
    // they mint identical `booking_cancel_refund_<bookingId>_<txn>_<amount>`
    // Stripe keys, Stripe answers repeats with the original refunds, and the
    // ledger dedupes on refund id.
    let cardRefundPlan: RefundAllocationSlice[] | null = null;
    let plannedCardRefundCents = 0;
    if (refundMethod === "card" && refundAmountCents > 0) {
      const { slices, plannedAmountCents } = await planStripeRefundAllocation({
        paymentId: payment.id,
        amountCents: refundAmountCents,
        store: tx,
      });
      cardRefundPlan = slices;
      plannedCardRefundCents = plannedAmountCents;
      if (plannedCardRefundCents > 0) {
        await enqueueBookingCancellationRefundRecovery({
          bookingId,
          paymentId: payment.id,
          amountCents: plannedCardRefundCents,
          allocationPlan: slices,
          store: tx,
        });
      }
    }

    // #2576 §6. Cancellation is the first change class the owner names, and it
    // is the one that removes attendance outright: cancelling the booking a
    // qualifying adult member is staying on can leave ANOTHER booking on the same
    // account without cover for the exact nights its non-member guests are there.
    // Reconciling inside the claim transaction is what makes the refusal real —
    // the throw rolls the cancellation back, so a member cannot strand their own
    // other booking, while an officer's cancellation is allowed and escalated to
    // an urgent compliance incident instead (§7, §8). Also clears this booking's
    // own hosting review, since a cancelled stay has no hazard.
    await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
      ...hostingCoverageActorOptions({
        actorRole: sessionUserRole,
        hasBookingsEditAccess,
        actorMemberId: sessionUserId,
        ...(hostingCoverageOverride ? { override: hostingCoverageOverride } : {}),
      }),
    });

    return {
      claimed: true as const,
      fresh,
      payment,
      creditRestoredCents,
      refundAmountCents,
      refundPercentage,
      refundableBaseCents,
      paidAmountCents,
      days,
      shouldFailAdditionalPayment,
      cardRefundPlan,
      plannedCardRefundCents,
      manualDisposition,
      manualRefundTaskId,
    };
  });

  // Loser contract: a concurrent cancel / retry that failed to claim gets a
  // real 409. This MUST be non-200 so the outer cancelBooking does not re-run
  // the group/child cleanup and does not report a false refundAmountCents:0.
  if (!claim.claimed) {
    return {
      status: 409,
      error: "This booking is already being cancelled or has been cancelled",
    };
  }

  const {
    fresh,
    payment,
    creditRestoredCents,
    refundAmountCents,
    refundPercentage,
    refundableBaseCents,
    paidAmountCents,
    days,
    shouldFailAdditionalPayment,
    cardRefundPlan,
    plannedCardRefundCents,
    manualDisposition,
    manualRefundTaskId,
  } = claim;
  const paymentId = payment.id;

  if (creditRestoredCents > 0) {
    logger.info(
      { bookingId, creditRestoredCents },
      "Restored previously applied credit on cancellation"
    );
  }

  // ── Phase 2 — external work, AFTER tx1 committed ──────────────────
  // The claim already stands; no failure below may abort it.

  // Additional-payment-intent Stripe cancel (best-effort). The DB state was
  // already flipped to FAILED in tx1; a Stripe cancel failure here is logged,
  // not rethrown (behaviour change vs pre-#1160, which re-threw and aborted
  // the whole cancel). Durability no longer rests on this call: tx1 persisted
  // a CANCEL_PAYMENT_INTENT recovery operation (F1, #1350), so a failure here
  // is retried by the recovery cron, and a capture that wins the race is
  // handed off to a full refund by the cron or the webhook's
  // superseded-intent hook.
  if (shouldFailAdditionalPayment) {
    try {
      await cancelOutstandingPaymentIntents({
        primaryPaymentIntentId: null,
        additionalPaymentIntentId: payment.additionalPaymentIntentId,
        cancelPrimary: false,
        cancelAdditional: true,
      });
    } catch (err) {
      logger.error(
        {
          err,
          bookingId,
          additionalPaymentIntentId: payment.additionalPaymentIntentId,
        },
        "Failed to cancel additional payment intent after cancellation claim committed"
      );
    }
  }

  // ── B5 (#2262) manual branch: a cash / off-Xero settlement handed back ──
  // The durable ManualRefundTask committed in tx1. Nothing here touches Xero
  // (this feature never does), nothing mints member credit, and no Stripe
  // refund is planned — a cash settlement has no card slice to plan against.
  if (manualDisposition && refundAmountCents > 0) {
    await cleanupPromoRedemption(bookingId);

    logBookingCancellationAudit({
      booking: fresh,
      bookingId,
      sessionUserId,
      details:
        payment.changeFeeCents > 0
          ? `Manual refund task for ${refundPercentage}% of ${refundableBaseCents} cents (excluding ${payment.changeFeeCents} cents change fee) = ${refundAmountCents} cents`
          : `Manual refund task for ${refundPercentage}% = ${refundAmountCents} cents`,
      ipAddress,
      metadata: {
        refundMethod: "manual",
        refundAmountCents,
        refundPercentage,
        refundableBaseCents,
        changeFeeCents: payment.changeFeeCents,
        creditRestoredCents,
        manualRefundTaskId,
        ...notifyAuditFields,
      },
    });

    await recordCancellationEvent({
      bookingId,
      actorMemberId: sessionUserId,
      policySummary: `Cancelled ${days} day(s) before check-in: ${refundPercentage}% refund under the policy in effect at the time, to be paid back by the club by hand (cash / off-Xero settlement).`,
      refundMethod: "manual",
      refundPercentage,
      paidAmountCents,
      settledAmountCents: refundAmountCents,
      changeFeeCents: payment.changeFeeCents,
    });

    // Deliberately NO BookingEventType.REFUNDED here: nothing has been refunded
    // yet. That event is written when the hand-back task is COMPLETED, which is
    // also when the ledger allocation is applied.

    if (notifyMember) {
      sendBookingCancelledEmail(
        { bookingId: fresh.id, recipientMemberId: fresh.memberId },
        fresh.member.email,
        fresh.member.firstName,
        fresh.checkIn,
        fresh.checkOut,
        refundAmountCents,
        "manual",
        creditRestoredCents,
        fresh.lodgeId
      ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));
    }

    // Admin audience, so exempt from the per-booking "No emails" switch (#2258
    // rule 2): the switch silences the MEMBER, and somebody still has to be
    // told there is cash to hand back.
    sendAdminManualRefundTaskAlert({
      memberName: `${fresh.member.firstName} ${fresh.member.lastName}`,
      checkIn: fresh.checkIn,
      checkOut: fresh.checkOut,
      refundAmountCents,
      bookingId,
      reason: `Cash/manual settlement cancelled ${days} day(s) before check-in (${refundPercentage}% under the policy in effect at the time).`,
    }).catch((err) =>
      logger.error(
        { err, bookingId, manualRefundTaskId },
        "Failed to alert admins about a manual refund task"
      )
    );

    processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut, lodgeId: fresh.lodgeId })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after manual-refund cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents,
        refundPercentage,
        refundMethod: "manual",
        creditRestoredCents: creditRestoredCents || undefined,
        manualRefundTaskId: manualRefundTaskId ?? undefined,
        message: `Booking cancelled. This booking was settled in cash, so a manual refund task for $${(refundAmountCents / 100).toFixed(2)} has been raised for an admin to pay back by hand.`,
      },
    };
  }

  // ── Credit branch: ledger writes already happened in tx1 ──────────
  if (refundMethod === "credit" && refundAmountCents > 0) {
    try {
      const queuedCreditNote = await enqueueXeroAccountCreditNoteOperation(
        paymentId,
        refundAmountCents,
        {
          createdByMemberId: sessionUserId,
        }
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
          logger.error(
            { err: xeroErr, bookingId, paymentId },
            "Failed to kick Xero account-credit note outbox worker"
          );
        });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId, paymentId },
        "Failed to queue unapplied Xero credit note"
      );
    }

    await cleanupPromoRedemption(bookingId);

    logBookingCancellationAudit({
      booking: fresh,
      bookingId,
      sessionUserId,
      details: payment.changeFeeCents > 0
        ? `Credit ${refundPercentage}% of ${refundableBaseCents} cents (excluding ${payment.changeFeeCents} cents change fee) = ${refundAmountCents} cents as account credit`
        : `Credit ${refundPercentage}% = ${refundAmountCents} cents as account credit`,
      ipAddress,
      metadata: {
        refundMethod: "credit",
        refundAmountCents,
        refundPercentage,
        refundableBaseCents,
        changeFeeCents: payment.changeFeeCents,
        creditRestoredCents,
        ...notifyAuditFields,
      },
    });

    // CANCELLED (post-payment) — the CREDITED settlement event is written by
    // createCancellationCredit (member-credit.ts) inside tx1.
    await recordCancellationEvent({
      bookingId,
      actorMemberId: sessionUserId,
      policySummary: `Cancelled ${days} day(s) before check-in: ${refundPercentage}% credit refund under the policy in effect at the time.`,
      refundMethod: "credit",
      refundPercentage,
      paidAmountCents,
      settledAmountCents: refundAmountCents,
      changeFeeCents: payment.changeFeeCents,
    });

    if (notifyMember) {
      sendBookingCancelledEmail(
        { bookingId: fresh.id, recipientMemberId: fresh.memberId },
        fresh.member.email,
        fresh.member.firstName,
        fresh.checkIn,
        fresh.checkOut,
        refundAmountCents,
        "credit",
        creditRestoredCents,
        fresh.lodgeId
      ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));
    }

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut, lodgeId: fresh.lodgeId })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after credit cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents,
        refundPercentage,
        refundMethod: "credit",
        creditAmountCents: refundAmountCents,
        creditRestoredCents: creditRestoredCents || undefined,
        message: `Booking cancelled. ${refundPercentage}% credit of $${(refundAmountCents / 100).toFixed(2)} added to your account.`,
      },
    };
  }

  // ── Card branch: Stripe refund ────────────────────────────────────
  if (refundAmountCents > 0) {
    let stripeRefundId: string | undefined;

    // The refund debt was persisted INSIDE the claim transaction (F2, #1349):
    // a recovery operation carrying the frozen per-transaction plan committed
    // atomically with the CANCELLED flip, so nothing below can silently lose
    // the member's refund. The mirror-vs-ledger drift case where the plan
    // covers less than the policy-due amount is logged here and refunds what
    // the ledger actually shows refundable — the same net outcome the old
    // inline derive reached via its recovery path.
    if (plannedCardRefundCents < refundAmountCents) {
      logger.error(
        { bookingId, paymentId, refundAmountCents, plannedCardRefundCents },
        "Cancellation refund plan covers less than the policy-due amount; refunding what the payment ledger shows refundable"
      );
    }

    if (cardRefundPlan && plannedCardRefundCents > 0) {
      try {
        const refundResult = await refundPaymentTransactions({
          paymentId,
          amountCents: plannedCardRefundCents,
          allocation: cardRefundPlan,
          // #1494: shared with the recovery cron's replay so the two send a
          // byte-identical request body under the same
          // `booking_cancel_refund_<bookingId>` idempotency key. The metadata
          // deliberately no longer carries refundPercentage — a per-cancellation
          // value the cron cannot reconstruct from the persisted operation,
          // which is what made a lost-recording replay diverge and hit Stripe's
          // idempotency_error. refundPercentage still drives the audit/event/
          // email narrative below; it just no longer rides in the Stripe body.
          metadata: buildBookingCancellationRefundMetadata(bookingId),
          idempotencyKeyPrefix: `booking_cancel_refund_${bookingId}`,
        });
        stripeRefundId = refundResult.refunds[0]?.refundId;
        // Happy-path close of the pre-persisted operation. Best-effort: if
        // this write is lost the cron replays the frozen plan, Stripe answers
        // the repeated keys with the original refunds, and the operation
        // completes with no second money movement.
        await markBookingCancellationRefundRecoverySucceeded({
          bookingId,
        }).catch((markErr) =>
          logger.error(
            { err: markErr, bookingId, paymentId },
            "Failed to mark booking cancellation refund recovery succeeded; the cron will replay the frozen plan idempotently"
          )
        );
      } catch (err) {
        // The claim already committed and the recovery operation already
        // exists with the frozen plan, so there is nothing to enqueue here
        // (pre-#1349 this catch was the ONLY place the debt was recorded —
        // and its own failure was swallowed). A partial success has recorded
        // its completed slices; the cron replays the SAME plan and keys, so
        // completed slices are replayed by Stripe, not repeated, and only the
        // remainder moves money. Do NOT rethrow.
        const completedRefundCents =
          err instanceof PartialRefundError ? err.completedRefundCents : 0;
        await recordBookingCancellationRefundRecoveryInlineError({
          bookingId,
          message: err instanceof Error ? err.message : String(err),
        }).catch((recordErr) =>
          logger.error(
            { err: recordErr, bookingId, paymentId },
            "Failed to record inline cancellation refund failure on the recovery operation"
          )
        );
        logger.error(
          { err, bookingId, paymentId, refundAmountCents, completedRefundCents },
          "Booking cancellation card refund failed; booking stays CANCELLED and the pre-persisted recovery operation replays the remainder"
        );
      }
    }

    // Queue the Xero credit note durably (allocated against the original invoice).
    try {
      const queuedCreditNote = await enqueueXeroRefundCreditNoteOperation(
        paymentId,
        refundAmountCents,
        {
          createdByMemberId: sessionUserId,
        }
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
          logger.error(
            { err: xeroErr, bookingId, paymentId },
            "Failed to kick Xero refund credit note outbox worker"
          );
        });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId, paymentId },
        "Failed to queue Xero credit note"
      );
    }

    await cleanupPromoRedemption(bookingId);

    logBookingCancellationAudit({
      booking: fresh,
      bookingId,
      sessionUserId,
      details: payment.changeFeeCents > 0
        ? `Refund ${refundPercentage}% of ${refundableBaseCents} cents (excluding ${payment.changeFeeCents} cents change fee) = ${refundAmountCents} cents`
        : `Refund ${refundPercentage}% = ${refundAmountCents} cents`,
      ipAddress,
      metadata: {
        refundMethod: "card",
        refundAmountCents,
        refundPercentage,
        refundableBaseCents,
        changeFeeCents: payment.changeFeeCents,
        creditRestoredCents,
        stripeRefundId: stripeRefundId ?? null,
        ...notifyAuditFields,
      },
    });

    await recordCancellationEvent({
      bookingId,
      actorMemberId: sessionUserId,
      policySummary: `Cancelled ${days} day(s) before check-in: ${refundPercentage}% card refund under the policy in effect at the time.`,
      refundMethod: "card",
      refundPercentage,
      paidAmountCents,
      settledAmountCents: refundAmountCents,
      changeFeeCents: payment.changeFeeCents,
    });
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.REFUNDED,
      actorMemberId: sessionUserId,
      amountCents: refundAmountCents,
      reason: `${refundPercentage}% refunded to the original payment method.`,
    });

    if (notifyMember) {
      sendBookingCancelledEmail(
        { bookingId: fresh.id, recipientMemberId: fresh.memberId },
        fresh.member.email,
        fresh.member.firstName,
        fresh.checkIn,
        fresh.checkOut,
        refundAmountCents,
        "card",
        creditRestoredCents,
        fresh.lodgeId
      ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));
    }

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut, lodgeId: fresh.lodgeId })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after card refund cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents,
        refundPercentage,
        refundMethod: "card",
        creditRestoredCents: creditRestoredCents || undefined,
        stripeRefundId,
        message: `Booking cancelled. ${refundPercentage}% refund of $${(refundAmountCents / 100).toFixed(2)} processed.`,
      },
    };
  }

  // ── Zero-refund branch (0% policy) ────────────────────────────────
  // The status flip and additionalPaymentStatus:"FAILED" already committed in
  // tx1, so there is no money movement left here — only the narrative work.
  await cleanupPromoRedemption(bookingId);

  logBookingCancellationAudit({
    booking: fresh,
    bookingId,
    sessionUserId,
    details: "No refund per cancellation policy",
    ipAddress,
    metadata: {
      refundAmountCents: 0,
      refundPercentage,
      refundMethod: "card",
      creditRestoredCents,
      failedOutstandingAdditionalPayment: shouldFailAdditionalPayment,
      ...notifyAuditFields,
    },
  });

  await recordCancellationEvent({
    bookingId,
    actorMemberId: sessionUserId,
    policySummary: `Cancelled ${days} day(s) before check-in: no refund was due under the policy in effect at the time.`,
    refundMethod: "card",
    refundPercentage,
    paidAmountCents,
    settledAmountCents: 0,
    changeFeeCents: payment.changeFeeCents,
  });

  if (notifyMember) {
    sendBookingCancelledEmail(
      { bookingId: fresh.id, recipientMemberId: fresh.memberId },
      fresh.member.email,
      fresh.member.firstName,
      fresh.checkIn,
      fresh.checkOut,
      0,
      "card",
      creditRestoredCents,
      fresh.lodgeId
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));
  }

  // Trigger waitlist processing for freed dates
  processWaitlistForDates({ checkIn: fresh.checkIn, checkOut: fresh.checkOut, lodgeId: fresh.lodgeId })
    .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after no-refund cancellation"));

  return {
    status: 200,
    data: {
      success: true,
      refundAmountCents: 0,
      refundPercentage: 0,
      refundMethod: "card",
      creditRestoredCents: creditRestoredCents || undefined,
      message:
        "Booking cancelled. No refund applicable per cancellation policy.",
    },
  };
}

type CancellationAuditBooking = {
  memberId: string;
  status: string;
  checkIn: Date;
  checkOut: Date;
  // Pre-cancel exclusive whole-lodge hold state (#177). The cancellation audit
  // funnel reads these from the pre-update snapshot so it can emit a
  // `booking.exclusiveHold.released` entry when the terminal transition
  // auto-released a hold. Optional: not every snapshot handed to this helper
  // carries them (e.g. provisional child bookings never hold), and a bare
  // `false`/undefined simply means "no hold to release".
  wholeLodgeHold?: boolean | null;
  wholeLodgeHoldAt?: Date | null;
  wholeLodgeHoldByMemberId?: string | null;
  payment?: {
    id?: string | null;
    status?: string | null;
    amountCents?: number | null;
    refundedAmountCents?: number | null;
    changeFeeCents?: number | null;
    creditAppliedCents?: number | null;
  } | null;
};

function logBookingCancellationAudit({
  booking,
  bookingId,
  sessionUserId,
  details,
  ipAddress,
  metadata,
}: {
  booking: CancellationAuditBooking;
  bookingId: string;
  sessionUserId: string;
  details: string;
  ipAddress: string;
  metadata?: Record<string, unknown>;
}) {
  logAudit({
    action: "booking.cancel",
    memberId: sessionUserId,
    targetId: bookingId,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: bookingId,
    category: "booking",
    severity: "critical",
    outcome: "success",
    summary: "Booking cancelled",
    details,
    metadata: {
      statusBefore: booking.status,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
      paymentId: booking.payment?.id ?? null,
      paymentStatus: booking.payment?.status ?? null,
      paidAmountCents: booking.payment?.amountCents ?? null,
      refundedAmountCents: booking.payment?.refundedAmountCents ?? null,
      creditAppliedCents: booking.payment?.creditAppliedCents ?? null,
      ...metadata,
    },
    ipAddress,
  });

  // Exclusive whole-lodge hold auto-release (ADR-001, issue #177). Terminal
  // transitions spread RELEASE_WHOLE_LODGE_HOLD_UPDATE, clearing the hold in the
  // same update as the status flip. When the pre-cancel snapshot shows a hold
  // was actually present, record a distinct `booking.exclusiveHold.released`
  // entry (sibling to `booking.exclusiveHold.set`/`.cleared` on the admin route)
  // so the trail says the cancel released it — not that an officer cleared it —
  // and a later reinstatement cannot be mistaken for a still-armed hold. This is
  // the audited half of the release; the cron/group-cancel bulk transitions
  // clear the field best-effort without this context (see the fragment's doc).
  if (booking.wholeLodgeHold) {
    logAudit({
      action: "booking.exclusiveHold.released",
      memberId: sessionUserId,
      targetId: bookingId,
      subjectMemberId: booking.memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "booking",
      severity: "important",
      outcome: "success",
      summary: "Exclusive whole-lodge hold auto-released on cancellation",
      details:
        "A booking carrying an exclusive whole-lodge hold reached a terminal state; the hold was auto-released so the cancelled booking cannot re-arm it if reinstated.",
      metadata: {
        statusBefore: booking.status,
        previouslyHeldAt: booking.wholeLodgeHoldAt?.toISOString() ?? null,
        previouslyHeldByMemberId: booking.wholeLodgeHoldByMemberId ?? null,
      },
      ipAddress,
    });
  }
}

/**
 * Write the durable CANCELLED BookingEvent (issue #740). For a cancellation
 * after a captured payment, the policy snapshot + settled/retained amounts are
 * frozen here so the narrative can be rebuilt exactly later, even after the
 * AuditLog has been retention-pruned. Pre-payment cancellations carry no
 * snapshot. Call after the cancellation has committed.
 */
async function recordCancellationEvent(params: {
  bookingId: string;
  actorMemberId: string;
  policySummary: string;
  refundMethod: "card" | "credit" | "manual";
  refundPercentage: number;
  paidAmountCents: number;
  settledAmountCents: number;
  changeFeeCents: number;
}): Promise<void> {
  const retainedAmountCents = Math.max(
    params.paidAmountCents - params.settledAmountCents,
    0
  );
  await recordBookingEvent({
    bookingId: params.bookingId,
    type: BookingEventType.CANCELLED,
    actorMemberId: params.actorMemberId,
    amountCents: params.paidAmountCents,
    snapshot: {
      policySummary: params.policySummary,
      refundMethod: params.refundMethod,
      refundPercentage: params.refundPercentage,
      paidAmountCents: params.paidAmountCents,
      settledAmountCents: params.settledAmountCents,
      retainedAmountCents,
      changeFeeCents: params.changeFeeCents,
    },
  });
}

// #1491: paid-cancel-path eligibility, shared with the cancel-preview route
// so the preview can never contradict the executed money outcome. A
// PARTIALLY_REFUNDED payment is eligible only on LEDGER evidence (a captured
// transaction row) — never the mirror fallback below — because the paid
// path's refund executors allocate against ledger rows: a mirror-only legacy
// payment would claim and then throw (credit method) or plan zero slices
// (card method). Mirror-only rows stay in the preserve branch (#1473).
export async function paymentEligibleForPaidCancelPath(
  payment: { id: string; status: string } | null | undefined,
  db: Prisma.TransactionClient | typeof prisma = prisma
) {
  if (!payment) {
    return false;
  }
  if (payment.status === "SUCCEEDED") {
    return true;
  }
  if (payment.status !== "PARTIALLY_REFUNDED") {
    return false;
  }
  const capturedTransaction = await db.paymentTransaction.findFirst({
    where: {
      paymentId: payment.id,
      status: {
        in: ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"],
      },
    },
    select: { id: true },
  });
  return Boolean(capturedTransaction);
}

// #1473/#1491: capture evidence for cancel-time decisions. Ledger truth
// first — any transaction row that holds/held money — because the aggregate
// mirror lies in both directions: the inbound reconcile folds invoice-applied
// modification credit notes into refundedAmountCents/PARTIALLY_REFUNDED on
// never-captured IB payments (pure bookkeeping, zero cash), and the pre-#1473
// cancel flow used to flatten captured statuses to FAILED. For STRIPE rows
// with no ledger rows (pre-ledger data) the refund mirror IS trustworthy:
// Stripe refunds require a captured charge, and the invoice-side fold cannot
// reach an uncaptured Stripe booking (its Xero invoice is only issued
// at/after capture).
async function paymentHasCaptureEvidence(
  payment: {
    id: string;
    source: string;
    status: string;
    refundedAmountCents: number;
  },
  db: Prisma.TransactionClient | typeof prisma = prisma
) {
  const capturedTransaction = await db.paymentTransaction.findFirst({
    where: {
      paymentId: payment.id,
      status: {
        in: ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"],
      },
    },
    select: { id: true },
  });
  return Boolean(
    capturedTransaction ||
      (payment.source === "STRIPE" &&
        (payment.status === "REFUNDED" ||
          payment.status === "PARTIALLY_REFUNDED" ||
          payment.refundedAmountCents > 0))
  );
}

// #1547: every cancel branch that restores applied credit appends this line to
// the CANCELLED narrative event when a positive amount was returned, so the
// member/admin story reflects the restore. Money stays in cents internally; the
// sentence renders NZ dollars for humans.
function appendReturnedCreditSentence(
  reason: string,
  creditRestoredCents: number
): string {
  return creditRestoredCents > 0
    ? `${reason} NZ$${(creditRestoredCents / 100).toFixed(2)} of applied account credit was returned.`
    : reason;
}

function hasOutstandingAdditionalPaymentIntent(
  payment:
    | {
        additionalPaymentIntentId?: string | null;
        additionalPaymentStatus?: string | null;
      }
    | null
    | undefined
) {
  return Boolean(
    payment?.additionalPaymentIntentId &&
      payment.additionalPaymentStatus !== "SUCCEEDED" &&
      payment.additionalPaymentStatus !== "FAILED"
  );
}

async function cancelOutstandingPaymentIntents({
  primaryPaymentIntentId,
  additionalPaymentIntentId,
  cancelPrimary,
  cancelAdditional,
}: {
  primaryPaymentIntentId?: string | null;
  additionalPaymentIntentId?: string | null;
  cancelPrimary: boolean;
  cancelAdditional: boolean;
}) {
  const paymentIntentIds = new Set<string>();

  if (cancelPrimary && primaryPaymentIntentId) {
    paymentIntentIds.add(primaryPaymentIntentId);
  }

  if (cancelAdditional && additionalPaymentIntentId) {
    paymentIntentIds.add(additionalPaymentIntentId);
  }

  for (const paymentIntentId of paymentIntentIds) {
    try {
      await cancelPaymentIntentIfCancellable(paymentIntentId);
      await markPaymentIntentTransactionFailed({ paymentIntentId });
    } catch (err) {
      logger.error(
        { err, paymentIntentId },
        "Failed to cancel Stripe PaymentIntent for cancelled booking"
      );
      throw err;
    }
  }
}

/**
 * Clean up promo redemption if booking used a promo code.
 */
async function cleanupPromoRedemption(bookingId: string) {
  const redemption = await prisma.promoRedemption.findUnique({
    where: { bookingId },
  });
  if (redemption) {
    await prisma.$transaction(async (tx) => {
      await deletePromoRedemptionAndAdjustCount(tx, redemption);
    });
  }
}
