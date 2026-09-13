import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import {
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
} from "@/lib/booking-status";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { sendWaitlistPlaceRestoredEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  RETURN_TO_WAITLIST_AUDIT_ACTION,
  RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE,
  RETURN_TO_WAITLIST_CONTENDED_MESSAGE,
  RETURN_TO_WAITLIST_NO_STRAND_EVIDENCE_MESSAGE,
  RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE,
  RETURN_TO_WAITLIST_PRICED_MESSAGE,
  RETURN_TO_WAITLIST_STATUS_MESSAGE,
  findUnresolvedWaitlistStrandReport,
  isReturnToWaitlistTransactionContention,
} from "@/lib/waitlist-return-contract";
import { processWaitlistForDates } from "@/lib/waitlist";

/**
 * #2649 review — the repair's own lock budget.
 *
 * Prisma's defaults are 2s `maxWait` / 5s `timeout`, and the advisory wait
 * counts against them. This route exists BECAUSE an exhausted lock wait broke
 * the confirm's compensating release, and that compensation was deliberately
 * given 5s/10s for the same reason (`waitlist-confirm/route.ts`). Running the
 * repair on the defaults would mean the button 503s during exactly the
 * contention that creates strands: the longest-lived holder of `lock(1)` in the
 * tree is `assignBedRange`, inside a 30s transaction.
 *
 * So this takes the ADMIN precedent rather than the member one — the same
 * `{ maxWait: 10_000, timeout: 30_000 }` as `assignBedRange`
 * (`bed-allocation-range-assign.ts`), above `saveClubTheme`'s 10s/15s. The member
 * budget is tighter on purpose (a member is watching the request); an officer
 * pressing a recovery button can wait out the worst contender, and a repair that
 * fails safely is still a repair that did not happen.
 */
const RETURN_TO_WAITLIST_MAX_WAIT_MS = 10_000;
const RETURN_TO_WAITLIST_TIMEOUT_MS = 30_000;

/**
 * Return a stranded zero-dollar waitlist confirm to the waitlist (#2649).
 *
 * The repair the failed compensation in `waitlist-confirm` would have made.
 * #2648 left exactly one recoverable state behind: a free booking committed to
 * `PAYMENT_PENDING` with its offer consumed, whose `PAID` claim failed AND
 * whose compensating release back to `WAITLISTED` could not run either. It
 * blocks nobody else's nights, owes nothing, and has no offer to replay, so no
 * cron clears it and the member cannot retry. Until now the only way to put
 * their place back was direct database access.
 *
 * ## What it accepts, and why so narrowly
 *
 * Four conditions, all re-read under the locks:
 *
 *  1. an unresolved `waitlist.confirm_offer_release_failed` report on this
 *     booking (`findUnresolvedWaitlistStrandReport`), which is the ONLY
 *     evidence that a waitlist confirmation is what stranded it. The three
 *     conditions below are a shape SIX other producers reach — see that
 *     function's note, which names all six and refutes two near-misses — so
 *     without this the button would un-confirm ordinary free bookings,
 *     including any the `20260511113000` backfill migration left in this shape;
 *  2. `status === PAYMENT_PENDING`;
 *  3. `finalPriceCents === 0` — a priced booking has a payment path and is none
 *     of this tool's business;
 *  4. no `Payment` row — a free confirm mints its $0 payment strictly AFTER
 *     reaching `PAID` (#2623), so a payment row means the confirm finished.
 *
 * Conditions 2 and 3 are re-asserted in the claim itself, so neither can be true
 * at check time and false at write time. Condition 4 is a pre-read under both
 * locks rather than part of the claim (Prisma's `updateMany` filter is scalar),
 * and condition 1 is about a permanent audit row that nothing races.
 *
 * ## Locking
 *
 * Global booking/money `lock(1)` FIRST, then this booking's own immutable lodge
 * capacity key — the order `docs/CONCURRENCY_AND_LOCKING.md` mandates for a
 * writer that moves booking status AND bed allocations, and the same order the
 * two releases in `waitlist-confirm/route.ts` take. `PAYMENT_PENDING` is
 * BED-ALLOCATABLE and `WAITLISTED` is not (`bed-allocation-lifecycle.ts`), so
 * this write prunes real `BedAllocation` rows and must serialise against every
 * per-lodge writer. It is NOT capacity-holding by status: `booking-status.ts`
 * holds `PAYMENT_PENDING` capacity only while `adminCapacityHoldAt` is set,
 * which is exactly the hold this route releases below.
 *
 * The claim is a status-guarded `updateMany`. A lost claim returns before the
 * allocation reconcile, before the audit row, and before the transaction does
 * anything else; the caller's post-commit block runs no email and no waitlist
 * processing on any refusal, so a lost claim has no side effect at all.
 *
 * ## Hosting coverage
 *
 * Deliberately none — byte-for-byte parity with the two existing
 * `PAYMENT_PENDING -> WAITLISTED` releases (`waitlist-confirm/route.ts`, the
 * capacity-lost branch and the compensation), neither of which touches adult
 * member hosting coverage. `enqueueOwnHostingCoverageReevaluation` is for
 * CONFIRMING transitions that add attendance; this one removes it. Whether a
 * release should re-evaluate cover the way a cancellation does is a question
 * about all three release sites at once and is carried forward as its own
 * issue rather than answered differently here for one of them.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;
  const auditRequest = getAuditRequestContext(request);

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

        // Immutable identity only. `Booking.lodgeId` is the lock key and never
        // changes, and `createdAt` is the queue's FIFO ordering — reading either
        // before the lodge lock is safe, and nothing else is read here.
        const key = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { lodgeId: true, memberId: true, createdAt: true },
        });
        if (!key) return { error: "Booking not found", status: 404 } as const;

        await acquireLodgeCapacityLock(tx, key.lodgeId);

        // Everything mutable is read only now, under both locks.
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          select: {
            status: true,
            finalPriceCents: true,
            checkIn: true,
            checkOut: true,
            // #2649 review S3. An admin may set a capacity hold on ANY
            // `PAYMENT_PENDING` booking from this same Admin tools card
            // (`capacity-hold/route.ts`), so "hold the beds, then repair" is a
            // plausible order of operations. Read the two hold fragments so the
            // repair can release them WITH the transition and say in its audit
            // row what it released, the way every other release in the tree does
            // (`booking-cancel.ts`, `group-cancel.ts`, the settlement crons).
            // Left alone, the flag would survive to `WAITLISTED` — inert there,
            // because enforcement is scoped to `PAYMENT_PENDING` — and then
            // silently RE-ARM under a different episode's admin and date the
            // moment the booking was re-offered and confirmed back.
            adminCapacityHoldAt: true,
            adminCapacityHoldByMemberId: true,
            wholeLodgeHold: true,
            wholeLodgeHoldAt: true,
            wholeLodgeHoldByMemberId: true,
            member: { select: { email: true, firstName: true } },
            payment: { select: { id: true } },
          },
        });
        if (!booking) return { error: "Booking not found", status: 404 } as const;

        if (booking.status !== BookingStatus.PAYMENT_PENDING) {
          return {
            error: RETURN_TO_WAITLIST_STATUS_MESSAGE,
            status: 409,
          } as const;
        }
        if (booking.finalPriceCents !== 0) {
          return { error: RETURN_TO_WAITLIST_PRICED_MESSAGE, status: 409 } as const;
        }
        if (booking.payment) {
          return {
            error: RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE,
            status: 409,
          } as const;
        }

        // #2649 review BLOCKER — waitlist provenance, checked BEFORE the claim.
        // The three conditions above are a shape ordinary bookings reach; this
        // is the one that says a waitlist confirmation stranded THIS booking.
        const strandedRow = await findUnresolvedWaitlistStrandReport(
          tx,
          bookingId,
        );
        if (!strandedRow) {
          return {
            error: RETURN_TO_WAITLIST_NO_STRAND_EVIDENCE_MESSAGE,
            status: 409,
          } as const;
        }

        // The same field set the three in-tree reverts write, plus
        // `waitlistPosition` and the two hold fragments. The confirm's first
        // phase already nulled the position on its way out of the queue, so
        // nulling it here is a no-op on the stranded shape — but it makes the
        // documented outcome ("back of the queue by the ordinary rule") true by
        // construction rather than by inheritance. `finalPriceCents` is
        // re-asserted in the guard so a concurrent re-price cannot turn this
        // into an un-confirm of a priced booking.
        const restored = await tx.booking.updateMany({
          where: {
            id: bookingId,
            status: BookingStatus.PAYMENT_PENDING,
            finalPriceCents: 0,
          },
          data: {
            status: BookingStatus.WAITLISTED,
            waitlistPosition: null,
            waitlistOfferedAt: null,
            waitlistOfferExpiresAt: null,
            waitlistOfferedLodgeId: null,
            waitlistOfferedPriceCents: null,
            ...RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
            ...RELEASE_WHOLE_LODGE_HOLD_UPDATE,
          },
        });
        if (restored.count !== 1) {
          // Returning here COMMITS, so a lost claim must have written nothing:
          // the reconcile, the audit row, the email and the waitlist sweep all
          // sit below this guard.
          return { error: RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE, status: 409 } as const;
        }

        await reconcileBedAllocationsForBookingWithLodgeLockHeld({
          bookingId,
          db: tx,
          previousRange: { checkIn: booking.checkIn, checkOut: booking.checkOut },
        });

        // The place the member is told they hold. Same rule as the offer-expiry
        // email quotes (`waitlist.ts` `expireStaleOffers`): per-lodge queue,
        // overlapping nights, FIFO on `createdAt`. Counted under the locks, so it
        // cannot be quoted from a queue that moved.
        const ahead = await tx.booking.count({
          where: {
            status: BookingStatus.WAITLISTED,
            lodgeId: key.lodgeId,
            checkIn: { lt: booking.checkOut },
            checkOut: { gt: booking.checkIn },
            createdAt: { lt: key.createdAt },
          },
        });
        const waitlistPosition = ahead + 1;

        await createAuditLog(
          {
            action: RETURN_TO_WAITLIST_AUDIT_ACTION,
            memberId: session.user.id,
            actorMemberId: session.user.id,
            subjectMemberId: key.memberId,
            targetId: bookingId,
            entityType: "Booking",
            entityId: bookingId,
            category: "booking",
            severity: "important",
            outcome: "success",
            summary: "Stranded zero-dollar waitlist confirm returned to the waitlist",
            details:
              "Admin returned a free booking stranded in PAYMENT_PENDING to WAITLISTED, clearing the consumed offer so the ordinary offer worker can replay it. This is the repair the failed compensating release would have made.",
            metadata: {
              lodgeId: key.lodgeId,
              checkIn: booking.checkIn.toISOString(),
              checkOut: booking.checkOut.toISOString(),
              finalPriceCents: booking.finalPriceCents,
              previousStatus: BookingStatus.PAYMENT_PENDING,
              nextStatus: BookingStatus.WAITLISTED,
              waitlistPosition,
              // Closes the trail in both directions, and — because the guard
              // above requires it — is the row that PROVED this booking was the
              // strand rather than an ordinary free booking. It carries the
              // lodge, the dates, the price and both error codes, which is where
              // the offer detail now lives: the four offer columns are already
              // null on every reachable strand (nulled by the phase-one claim,
              // or cross-lodge-only), so snapshotting them here recorded four
              // nulls and claimed they were evidence (#2649 review S1).
              resolvesAuditLogId: strandedRow.id,
              resolvesAuditLogAt: strandedRow.createdAt.toISOString(),
              // #2649 review S3: what this transition released alongside the
              // status, so the freed capacity is never a silent side effect.
              releasedAdminCapacityHold: booking.adminCapacityHoldAt
                ? {
                    heldAt: booking.adminCapacityHoldAt.toISOString(),
                    heldByMemberId: booking.adminCapacityHoldByMemberId,
                  }
                : null,
              releasedWholeLodgeHold: booking.wholeLodgeHold
                ? {
                    heldAt: booking.wholeLodgeHoldAt?.toISOString() ?? null,
                    heldByMemberId: booking.wholeLodgeHoldByMemberId,
                  }
                : null,
            },
            requestId: auditRequest?.id,
            ipAddress: auditRequest?.ipAddress,
            userAgent: auditRequest?.userAgent,
          },
          tx,
        );

        return {
          success: true as const,
          memberId: key.memberId,
          lodgeId: key.lodgeId,
          email: bookingOwner(booking).member.email,
          firstName: bookingOwner(booking).member.firstName,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          waitlistPosition,
        };
      },
      {
        maxWait: RETURN_TO_WAITLIST_MAX_WAIT_MS,
        timeout: RETURN_TO_WAITLIST_TIMEOUT_MS,
      },
    );

    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    // #2649 owner decision 4 (Recommended) was "reuse the offer-expiry mailer",
    // described in the issue as the email that already says "you are back on the
    // waitlist at position N". That is its THIRD line: its subject and heading
    // say "Waitlist Offer Expired" and its first line says the offer "has
    // expired", which is false here and contradicts what #2648 already told this
    // member — they confirmed inside the window and the club's code failed. The
    // review's recommended option, taken on the owner's behalf and recorded in
    // the PR body, is a `restored` variant of the same template: identical
    // arguments, tokens and wiring, honest copy. It routes through
    // `bookingOwnerEmailContext`, so the per-booking "No emails" switch
    // withholds it without this route branching on it.
    sendWaitlistPlaceRestoredEmail(
      { bookingId, recipientMemberId: bookingOwner(result).memberId },
      result.email,
      result.firstName,
      result.checkIn,
      result.checkOut,
      result.waitlistPosition,
      result.lodgeId,
    ).catch((err) =>
      logger.error(
        { err, bookingId },
        "Failed to tell the member their waitlist place was restored",
      ),
    );

    // The booking left a bed-allocatable status and any admin capacity hold it
    // carried has been released, so its nights are free. Offer them the way
    // every other release does (`expireStaleOffers`, every cancel path): after
    // commit, never inside the locks, and never allowed to turn a completed
    // repair into a failure.
    //
    // The lodge is the BOOKING's own, never `waitlistOfferedLodgeId`. This is
    // where `expireStaleOffers` deliberately differs and must: there the entry
    // is still WAITLIST_OFFERED, holding a bed at the OFFERED lodge, so that is
    // what its revert frees. Here the booking is PAYMENT_PENDING, whose
    // allocations, the lodge key held above, and the reconcile that just pruned
    // them are all keyed on `lodgeId`. Sweeping any other lodge would process a
    // queue whose beds this repair did not free and leave the ones it did free
    // unoffered. (`confirmWaitlistOffer` sends every offer carrying
    // `waitlistOfferedLodgeId` down the cross-lodge path, which replaces the
    // entry rather than parking it in PAYMENT_PENDING, so the field is null on
    // every reachable stranded booking today. The rule is written from where
    // the beds are, not from that reachability.)
    processWaitlistForDates({
      checkIn: result.checkIn,
      checkOut: result.checkOut,
      lodgeId: result.lodgeId,
    }).catch((err) =>
      logger.error(
        { err, bookingId },
        "Failed to process the waitlist after returning a stranded confirm",
      ),
    );

    return NextResponse.json({
      success: true,
      status: BookingStatus.WAITLISTED,
      waitlistPosition: result.waitlistPosition,
    });
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to return a stranded zero-dollar waitlist confirm to the waitlist",
    );
    // Contention is not a fault. Nothing was committed either way — the claim,
    // the reconcile and the audit row share one transaction — so the only
    // question is what the operator should do next, and for an exhausted lock
    // wait that is "again shortly", not "escalate". 503 for the same reason
    // `waitlist-confirm/route.ts` uses it on the release this repair finishes.
    if (isReturnToWaitlistTransactionContention(err)) {
      return NextResponse.json(
        { error: RETURN_TO_WAITLIST_CONTENDED_MESSAGE },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "Failed to return the booking to the waitlist" },
      { status: 500 },
    );
  }
}
