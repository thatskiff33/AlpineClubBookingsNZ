import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { HOSTING_COVERAGE_RETRY_CODE } from "@/lib/adult-member-hosting-queue-participants";
import { auth } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import { confirmWaitlistOffer } from "@/lib/waitlist";
import {
  sendBookingConfirmedEmail,
  sendBookingPendingEmail,
} from "@/lib/email";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueOwnHostingCoverageReevaluation } from "@/lib/adult-member-hosting-review";
import {
  WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY,
  WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION,
  WAITLIST_CONFIRM_RELEASED_UNAVAILABLE_BODY,
  WAITLIST_CONFIRM_STATUS_MOVED_BODY,
  WAITLIST_OFFER_CONSUMED_STATUS_MOVED_FLAGS,
  WAITLIST_OFFER_RELEASED_CAPACITY_BODY,
  WAITLIST_OFFER_RELEASED_FLAGS,
} from "@/lib/waitlist-confirm-recovery-contract";

/**
 * #2623 T4 — budgets for the compensating offer release.
 *
 * The release runs precisely when contention is highest: the thing that
 * triggered it is a participant `NOWAIT` conflict or a lost/timed-out phase-two
 * transaction. On Prisma's defaults (2s `maxWait`, 5s `timeout`) the
 * compensation was therefore the likeliest step in the whole route to fail, and
 * its failure is what leaves a $0 booking parked in `PAYMENT_PENDING` with the
 * offer already consumed.
 *
 * These are deliberately generous against those defaults but TIGHTER than the
 * admin precedents (`saveClubTheme` 10s/15s, `assignBedRange` 10s/30s), because
 * a member is watching this request rather than an officer: two attempts cap the
 * member-visible wait at roughly 30s. Going higher would buy little — the
 * longest-lived holder of `lock(1)` in the tree is `assignBedRange`, which takes
 * it inside a `timeout: 30_000` transaction — so a budget that always beat the
 * worst contender would mean a member waiting a minute for a failure they cannot
 * act on. That is why the guard and the operator door below exist instead of a
 * bigger number.
 */
const OFFER_RELEASE_MAX_WAIT_MS = 5_000;
const OFFER_RELEASE_TIMEOUT_MS = 10_000;
const OFFER_RELEASE_ATTEMPTS = 2;
const OFFER_RELEASE_RETRY_DELAY_MS = 250;

/**
 * Prisma's transaction contention codes: P2028 (transaction API error, which
 * covers an exhausted `maxWait`/`timeout`) and P2034 (write conflict/deadlock,
 * retryable by definition). Mapped to 503 for the same reason
 * `admin/site-style/route.ts` and `admin-bed-allocation-routes.ts` map them
 * there — nothing was committed and the actionable advice is "later", not
 * "differently" (`docs/CONCURRENCY_AND_LOCKING.md`).
 */
const TRANSACTION_CONTENTION_CODES = new Set(["P2028", "P2034"]);

function transactionErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function isTransactionContentionError(error: unknown): boolean {
  const code = transactionErrorCode(error);
  return code !== null && TRANSACTION_CONTENTION_CODES.has(code);
}

function contendedStatus(error: unknown): 503 | 500 {
  return isTransactionContentionError(error) ? 503 : 500;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;

  const result = await confirmWaitlistOffer(bookingId, session.user.id);

  if (!result.success) {
    const status = result.error === "Forbidden" ? 403
      : result.error === "Booking not found" ? 404
      // #2363: the offer changed between the service's unlocked pre-read and
      // its locked claim, so it refused without writing anything rather than
      // claim an offer whose minimum-stay policy was never evaluated. 409 for
      // the same reason the group-join verify route uses one — the request was
      // fine when it was made and the club's state moved under it — and it is
      // retryable: confirming again re-reads everything and runs the guard.
      : result.code === "CONFIRM_RETRY" ? 409
      // #2543: 409, not 400 — the booking IS permitted, by a Booking Officer,
      // through the exception-request workflow; it is the state of the party that
      // conflicts. Same status and same body as the five booking write paths, and
      // it keeps the code out of the hard-stop family that may not enter review.
      : result.code === "PAID_UP_ADULT_MEMBER_REQUIRED" ? 409
      // #2569: 409 for the same reasons — the booking IS permitted by a Booking
      // Officer through the exception-request workflow, so this is the state of the
      // party conflicting rather than a bad request, and the code stays out of the
      // hard-stop family that may not enter review.
      : result.code === "ADULT_MEMBER_HOSTING_REQUIRED" ? 409
      : result.code === HOSTING_COVERAGE_RETRY_CODE ? 409
      : 400;
    return NextResponse.json(
      {
        // #2543 — the shared refusal body (frozen violation, HOLD promise, and
        // the path to ask a Booking Officer), spread so this path answers the
        // paid-up-adult refusal in exactly the shape the five booking write paths
        // do. Present on that refusal only.
        ...(result.paidUpAdultRefusal ?? {}),
        // #2569 — the same treatment for the ENFORCED hosting refusal. Mutually
        // exclusive with the spread above in practice (the hosting reconciler runs
        // inside the claiming transaction, which the paid-up refusal returns before
        // ever opening), and spread in the same position for the same reason: the
        // path's own sentence below must win over the body's `error`.
        ...(result.adultMemberHostingRefusal ?? {}),
        // AFTER the spread, and the order is load-bearing. The shared body carries
        // its own `error` — the frozen violation's message — and spreading it last
        // silently discarded whatever this path had put there. Both waitlist paths
        // refuse with a sentence the booking paths cannot use (they reject the offer
        // without consuming it, so the member is told they kept their waitlist
        // place), and that sentence is the one the member must read. The body's
        // remaining fields are unaffected: `details`, `violations` and
        // `exceptionReview` still carry the policy's own wording for the officer.
        error: result.error,
        // Price drift on a cross-lodge offer (ADR-004): the client shows
        // the refreshed figure so the member can re-confirm knowingly.
        ...(result.updatedPriceCents !== undefined
          ? { updatedPriceCents: result.updatedPriceCents, code: "OFFER_PRICE_CHANGED" }
          : {}),
        // Other structured rejection codes (e.g. DUPLICATE_STAY): forwarded so
        // the client can distinguish them. Mutually exclusive with the
        // price-drift path above, so there is no code collision.
        ...(result.code ? { code: result.code } : {}),
      },
      { status },
    );
  }

  // Cross-lodge accept (ADR-004): the entry was replaced by a fresh booking
  // at the offered lodge. The standard creation path already handled
  // payment status, emails, and zero-dollar logic for the new booking, so
  // just point the client at it.
  if (result.newBookingId) {
    const newBooking = await prisma.booking.findUnique({
      where: { id: result.newBookingId },
      select: { finalPriceCents: true, status: true },
    });
    return NextResponse.json({
      success: true,
      status: result.newStatus,
      newBookingId: result.newBookingId,
      requiresPayment:
        result.newStatus === BookingStatus.PAYMENT_PENDING &&
        (newBooking?.finalPriceCents ?? 0) > 0,
      requiresSetup: result.newStatus === BookingStatus.PENDING,
      // #2543 — the same "why" the two same-lodge branches below return. This
      // branch is the one it matters most on: a cross-lodge quote can differ from
      // the member's own lodge by the whole member/non-member spread, and the
      // promotion has just charged them the non-member side of it.
      // `confirmCrossLodgeWaitlistOffer` computes the sentence and puts it on the
      // success result, and DOMAIN_INVARIANTS records that it rides that result —
      // dropping it here made the field dead on the one path that earns it, and
      // made the cross-lodge answer differ from the same-lodge answer for no
      // reason. The sentence the member actually reads before deciding is in the
      // OFFER email (both flavours go through one send site in `waitlist.ts`), so
      // this is the API contract being consistent rather than the only channel.
      subscriptionMemberRateNotice: result.subscriptionMemberRateNotice ?? null,
    });
  }

  // Handle zero-dollar bookings — auto-create payment and set PAID
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      member: true,
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
      guests: { include: { nights: true } }, // per-night sets (issue #713)
      promoRedemption: { include: { promoCode: true } },
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.finalPriceCents === 0 && result.newStatus === BookingStatus.PAYMENT_PENDING) {
    // #1881 — flipping a $0 booking PAYMENT_PENDING -> PAID is a net-new
    // capacity claim to a capacity-holding status. confirmWaitlistOffer above
    // committed the PAYMENT_PENDING flip in a SEPARATE transaction under its own
    // per-lodge lock, so this claim ran wholly unserialised before: no lock, no
    // re-check, a bare id-only update. Bring it under the two-tier protocol —
    // global lock(1) first (mutual exclusion with cancel/settlement), then the
    // per-lodge lock (serialise the capacity claim against per-lodge creators),
    // re-read under the locks, re-check capacity, and status-guard the flip.
    const runZeroDollarFlip = () => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, booking.lodgeId);

      const locked = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { guests: { include: { nights: true } } },
      });
      if (!locked || locked.status !== BookingStatus.PAYMENT_PENDING) {
        // Another writer owns this booking now. Phase one already consumed the
        // offer, so this is NOT a "capacity is gone" answer and must not be
        // reported as one (#2623 T8): where the booking landed is not this
        // request's to claim, and the member is sent to canonical state.
        return { ok: false as const, reason: "status-moved" as const };
      }

      const { available } = await checkCapacityForGuestRanges(
        locked.lodgeId,
        locked.checkIn,
        locked.checkOut,
        locked.guests,
        bookingId,
        tx
      );
      if (!available) {
        // PAYMENT_PENDING does not hold capacity. Revert the failed second-stage
        // $0 claim to WAITLISTED inside this locked transaction so ordinary
        // waitlist offering can retry it instead of stranding a booking that
        // owns no bed.
        const restored = await tx.booking.updateMany({
          where: { id: bookingId, status: BookingStatus.PAYMENT_PENDING },
          data: {
            status: BookingStatus.WAITLISTED,
            waitlistOfferedAt: null,
            waitlistOfferExpiresAt: null,
            waitlistOfferedLodgeId: null,
            waitlistOfferedPriceCents: null,
          },
        });
        if (restored.count === 1) {
          await reconcileBedAllocationsForBookingWithLodgeLockHeld({
            bookingId,
            db: tx,
            previousRange: {
              checkIn: locked.checkIn,
              checkOut: locked.checkOut,
            },
          });
        }
        return {
          ok: false as const,
          reason:
            restored.count === 1
              ? ("capacity-released" as const)
              : ("status-moved" as const),
        };
      }

      const claimed = await tx.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.PAYMENT_PENDING },
        data: { status: BookingStatus.PAID },
      });
      if (claimed.count === 0) {
        // Lost the claim to a concurrent writer despite the lock (defense in
        // depth). Returning here COMMITS the transaction — a lost claim must
        // therefore have written nothing, which is why the $0 Payment row is
        // created below this guard rather than above it (#2623). `Payment
        // .bookingId` is unique, so a SUCCEEDED $0 row committed onto a booking
        // that never reached PAID would both read as paid and permanently block
        // the booking's real payment row.
        return { ok: false as const, reason: "status-moved" as const };
      }
      await tx.payment.create({
        data: {
          bookingId,
          amountCents: 0,
          status: "SUCCEEDED",
        },
      });
      // The final PAYMENT_PENDING -> PAID claim is the transition that makes this
      // booking a live coverage source. Reconcile the committed shape without
      // trying to unwind an already-consumed offer, and durably enqueue any
      // incident/restoration work in this same transaction.
      await enqueueOwnHostingCoverageReevaluation(bookingId, tx, {
        cause: "SYSTEM_CHANGE",
        actorMemberId: session.user.id,
      });
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });
      return { ok: true as const };
    });

    // Phase one already consumed the offer and committed PAYMENT_PENDING. Any
    // phase-two failure rolls phase two back, so compensate under the same
    // global -> lodge protocol used by capacity loss. Leaving PAYMENT_PENDING
    // would strand a free booking in a state with neither a payment path nor an
    // offer; WAITLISTED lets the ordinary offer worker replay it safely. The
    // update is status-guarded, so a phase two that did in fact commit (a commit
    // whose acknowledgement was lost) matches no row and nothing is undone.
    const runOfferRelease = () =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          await acquireLodgeCapacityLock(tx, booking.lodgeId);
          const restored = await tx.booking.updateMany({
            where: { id: bookingId, status: BookingStatus.PAYMENT_PENDING },
            data: {
              status: BookingStatus.WAITLISTED,
              waitlistOfferedAt: null,
              waitlistOfferExpiresAt: null,
              waitlistOfferedLodgeId: null,
              waitlistOfferedPriceCents: null,
            },
          });
          if (restored.count === 1) {
            await reconcileBedAllocationsForBookingWithLodgeLockHeld({
              bookingId,
              db: tx,
              previousRange: {
                checkIn: booking.checkIn,
                checkOut: booking.checkOut,
              },
            });
          }
          return restored.count === 1;
        },
        { maxWait: OFFER_RELEASE_MAX_WAIT_MS, timeout: OFFER_RELEASE_TIMEOUT_MS },
      );

    // #2623 T4 — the compensation is itself a locked transaction under known
    // contention, so it gets a bounded retry and, crucially, is never allowed to
    // throw past this function. Before this it ran unguarded inside the catch:
    // its own lock-wait exhaustion replaced the mapped retry with an unhandled
    // 500 AND left the $0 booking parked in PAYMENT_PENDING with no offer.
    const releaseConsumedOffer = async (): Promise<
      | { released: true; placeRestored: boolean }
      | { released: false; cause: unknown }
    > => {
      let cause: unknown;
      for (let attempt = 1; attempt <= OFFER_RELEASE_ATTEMPTS; attempt += 1) {
        try {
          // `false` means the status guard matched nothing: the booking had
          // already left PAYMENT_PENDING under another writer, so it is not
          // stranded — but this request did not put the waitlist place back and
          // must not claim it did.
          return { released: true, placeRestored: await runOfferRelease() };
        } catch (releaseErr) {
          cause = releaseErr;
          if (
            attempt >= OFFER_RELEASE_ATTEMPTS ||
            !isTransactionContentionError(releaseErr)
          ) {
            break;
          }
          logger.warn(
            {
              err: releaseErr,
              bookingId,
              attempt,
              attempts: OFFER_RELEASE_ATTEMPTS,
            },
            "Waitlist offer release contended; retrying once before reporting",
          );
          await new Promise((resolve) =>
            setTimeout(resolve, OFFER_RELEASE_RETRY_DELAY_MS),
          );
        }
      }
      return { released: false, cause };
    };

    let flip: Awaited<ReturnType<typeof runZeroDollarFlip>>;
    try {
      flip = await runZeroDollarFlip();
    } catch (err) {
      const release = await releaseConsumedOffer();

      if (!release.released) {
        // The compensation could not run. This is the ONE waitlist-confirm
        // outcome that neither the member nor any cron can clear: a $0 booking
        // sitting in PAYMENT_PENDING with the offer consumed has no payment path
        // and nothing to replay. Raise it where an operator looks — a critical
        // Booking audit row (filterable by action/severity in Admin -> Audit
        // log) plus an error log for Sentry — and answer with copy that tells
        // the member the truth instead of inviting a retry that cannot work.
        logger.error(
          {
            err,
            releaseErr: release.cause,
            bookingId,
            memberId: bookingOwner(booking).memberId,
            lodgeId: booking.lodgeId,
          },
          "Zero-dollar waitlist confirm is stranded in PAYMENT_PENDING: the consumed offer could not be released and needs operator recovery",
        );
        // AWAITED, not fire-and-forget (#2649 review). `logAudit` is
        // `void createAuditLog(...).catch(log)`, which was fine while this row
        // was only a notification. It is now the ADMIN REPAIR'S ENTRY
        // CONDITION: `return-to-waitlist` refuses any booking without an
        // unresolved report, because the shape alone is reached by producers
        // that were never on a waitlist. A report lost to process teardown
        // would leave a genuinely stranded member repairable only from a
        // database session — the thing #2649 exists to remove. The `.catch`
        // keeps the previous failure semantics exactly: a failed write is
        // logged and the operator-door response below is still returned.
        await createAuditLog({
          action: WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION,
          memberId: session.user.id,
          targetId: bookingId,
          subjectMemberId: bookingOwner(booking).memberId,
          entityType: "Booking",
          entityId: bookingId,
          category: "booking",
          severity: "critical",
          outcome: "failure",
          summary: "Zero-dollar waitlist confirm stranded in PAYMENT_PENDING",
          details:
            "The waitlist offer was consumed and the booking committed to PAYMENT_PENDING, then the zero-dollar PAID claim failed and the compensating release back to WAITLISTED could not run. The booking holds no capacity, has no payment path and has no offer to replay: open it from Admin -> Bookings and press Return to waitlist in the Admin tools card (#2649), or cancel it and ask the member to rejoin.",
          metadata: {
            lodgeId: booking.lodgeId,
            checkIn: booking.checkIn.toISOString(),
            checkOut: booking.checkOut.toISOString(),
            finalPriceCents: booking.finalPriceCents,
            claimErrorCode: transactionErrorCode(err),
            releaseErrorCode: transactionErrorCode(release.cause),
          },
        }).catch((auditErr) =>
          logger.error(
            { err: auditErr, bookingId },
            "Failed to record the stranded zero-dollar waitlist confirm; the admin repair button will not appear for this booking",
          ),
        );
        return NextResponse.json(WAITLIST_CONFIRM_AWAITING_OPERATOR_BODY, {
          status: contendedStatus(release.cause),
        });
      }

      // The booking is out of PAYMENT_PENDING, so nothing is stranded. The
      // participant fence keeps its one public sentence (byte-identical across
      // every writer that maps it) and carries the consumed-offer flags so the
      // card stops offering a confirm for an offer that no longer exists
      // (#2623 T8).
      const hostingRetry = hostingCoverageParticipantRetryResponse(
        err,
        release.placeRestored
          ? WAITLIST_OFFER_RELEASED_FLAGS
          : WAITLIST_OFFER_CONSUMED_STATUS_MOVED_FLAGS,
      );
      if (hostingRetry) return hostingRetry;

      logger.error(
        { err, bookingId, placeRestored: release.placeRestored },
        "Zero-dollar waitlist confirm failed after the offer was consumed; the offer is no longer held by this booking",
      );
      return release.placeRestored
        ? NextResponse.json(WAITLIST_CONFIRM_RELEASED_UNAVAILABLE_BODY, {
            status: contendedStatus(err),
          })
        : NextResponse.json(WAITLIST_CONFIRM_STATUS_MOVED_BODY, { status: 409 });
    }

    if (!flip.ok) {
      // Phase one consumed the offer, so neither outcome may answer in the
      // enabled-CTA shape (#2623 T8) and neither may claim "capacity is gone"
      // when that is not what happened. `capacity-released` restored WAITLISTED
      // under the locks, so the ordinary offer worker replays it;
      // `status-moved` wrote nothing and sends the member to canonical state.
      return NextResponse.json(
        flip.reason === "capacity-released"
          ? WAITLIST_OFFER_RELEASED_CAPACITY_BODY
          : WAITLIST_CONFIRM_STATUS_MOVED_BODY,
        { status: 409 },
      );
    }

    await settleHostingCoverageAfterCommit({ bookingId });

    sendBookingConfirmedEmail(
      { bookingId: booking.id, recipientMemberId: bookingOwner(booking).memberId },
      bookingOwner(booking).member.email,
      bookingOwner(booking).member.firstName,
      booking.checkIn,
      booking.checkOut,
      booking.guests.length,
      booking.finalPriceCents,
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
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send confirmation email after waitlist confirm"));

    void enqueueXeroBookingInvoiceOperation(bookingId, {
      invoiceEmailDelivery: null,
    })
      .then(async (queuedInvoice) => {
        if (!queuedInvoice.queueOperationId) {
          return;
        }

        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      })
      .catch((err) =>
        logger.error(
          { err, bookingId },
          "Failed to queue Xero invoice after waitlist confirm"
        )
      );

    return NextResponse.json({
      success: true,
      status: "PAID",
      requiresPayment: false,
      // #2543 — why the confirmed figure is what it is, when somebody on this
      // booking is priced as a non-member for an unpaid subscription.
      subscriptionMemberRateNotice: result.subscriptionMemberRateNotice ?? null,
    });
  }

  // For PENDING bookings, send pending email
  if (result.newStatus === BookingStatus.PENDING && booking.nonMemberHoldUntil) {
    sendBookingPendingEmail(
      { bookingId: booking.id, recipientMemberId: bookingOwner(booking).memberId },
      bookingOwner(booking).member.email,
      bookingOwner(booking).member.firstName,
      booking.checkIn,
      booking.checkOut,
      booking.guests.length,
      booking.nonMemberHoldUntil,
      booking.lodgeId
    ).catch((err) => logger.error({ err }, "Failed to send pending email after waitlist confirm"));
  }

  return NextResponse.json({
    success: true,
    status: result.newStatus,
    requiresPayment: result.newStatus === BookingStatus.PAYMENT_PENDING && booking.finalPriceCents > 0,
    requiresSetup: result.newStatus === BookingStatus.PENDING,
    // #2543 — see the $0 branch above.
    subscriptionMemberRateNotice: result.subscriptionMemberRateNotice ?? null,
  });
}
