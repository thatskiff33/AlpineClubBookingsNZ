/**
 * The admin repair for a stranded zero-dollar waitlist confirm (#2649).
 *
 * #2648 made the strand VISIBLE — the member is told plainly that their offer
 * was used up and not to retry, and a `critical`
 * `waitlist.confirm_offer_release_failed` audit row names the booking in
 * Admin -> Audit log — but it left the booking unrepairable from the admin UI.
 * The waitlist screen lists only `WAITLISTED` / `WAITLIST_OFFERED`, Force
 * Confirm refuses any other status, and Record payment deliberately refuses a
 * booking with nothing owing, so putting the member's place back needed direct
 * database access.
 *
 * This module holds the strings that repair shares with its tests, its runbook
 * entry in `docs/MAINTENANCE.md` and the audit-writer census, so there is one
 * spelling of each rather than four — plus the provenance test that decides
 * whether a booking IS the strand at all.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION } from "@/lib/waitlist-confirm-recovery-contract";

/**
 * The audit action the repair writes. Its metadata carries the id of the
 * `waitlist.confirm_offer_release_failed` row it resolves, so an operator
 * reading either row can find the other and the trail closes.
 */
export const RETURN_TO_WAITLIST_AUDIT_ACTION = "waitlist.returned_to_waitlist";

/**
 * Refused because the booking is not sitting in `PAYMENT_PENDING`. Says where
 * to look rather than naming an internal status the operator cannot act on.
 */
export const RETURN_TO_WAITLIST_STATUS_MESSAGE =
  "Only a booking still sitting in Payment pending can be returned to the waitlist. This one has moved on — reload the page to see where it is now.";

/**
 * Refused because the booking has a price. A priced booking has a payment path,
 * so it is not the stranded shape and this is not an "un-confirm" tool
 * (#2649 owner decision: `PAYMENT_PENDING` at zero only).
 */
export const RETURN_TO_WAITLIST_PRICED_MESSAGE =
  "This booking has a balance to pay, so it still has a payment path and is not a stranded free confirm. Cancel it instead if the member should leave the queue.";

/**
 * Refused because a `Payment` row exists. A free confirm mints its own $0
 * payment only AFTER it reaches `PAID` (#2623), so a payment row means the
 * confirm finished and this booking is not stranded.
 */
export const RETURN_TO_WAITLIST_PAYMENT_PRESENT_MESSAGE =
  "This booking already has a payment record, so its confirmation completed and it is not stranded. Nothing was changed.";

/**
 * Refused because nothing on this booking says a waitlist confirmation stranded
 * it. See {@link findUnresolvedWaitlistStrandReport} for why the shape alone is
 * not evidence.
 */
export const RETURN_TO_WAITLIST_NO_STRAND_EVIDENCE_MESSAGE =
  "Nothing on this booking records a waitlist confirmation that got stuck, so this is not the failure this repair fixes — a free booking can sit in Payment pending for several ordinary reasons. Nothing was changed. Check Admin -> Audit log for a 'waitlist.confirm_offer_release_failed' entry on this booking before using any other tool.";

/** Db handle for {@link findUnresolvedWaitlistStrandReport}: the live client or a transaction. */
type WaitlistStrandAuditReader = Prisma.TransactionClient | PrismaClient;

/**
 * The waitlist PROVENANCE test, and the reason this repair is safe to offer.
 *
 * `PAYMENT_PENDING` + `finalPriceCents === 0` + no `Payment` row is NOT "the
 * stranded shape". It is a shape SIX other producers reach, none of them a
 * waitlist confirmation:
 *
 *  1. the `20260511113000` backfill migration — `CONFIRMED -> PAYMENT_PENDING`
 *     wherever no `SUCCEEDED` payment exists, with no price predicate and no
 *     "has a payment row at all" predicate, and its companion promote migration
 *     only touches rows that DO have one, so nothing cleans the residue up;
 *  2. `modifyBookingDates` (`booking-date-modification-service.ts`) — its $0
 *     auto-settle is nested inside `if (appliedBeforeClamp > 0)`, so a date
 *     change that reprices to zero with NO credit applied never reaches the
 *     payment upsert. Its sibling `booking-modify-settlement.ts` computes
 *     `effectivePriceCents` OUTSIDE the credit gate and settles the same case
 *     to `PAID`, which is what makes this one a defect rather than a policy;
 *  3. `adminShiftBookingDates` (same file) — no $0 settle at all, and it
 *     releases a free `PENDING` non-member hold with every price field left as
 *     booked;
 *  4. `admin/bookings/[id]/review/route.ts` — an `AWAITING_REVIEW` approval
 *     with no price check, and `booking-create.ts` deliberately skips the $0
 *     auto-`PAID` settle under `review.blockForReview`, so the booking it
 *     releases provably has no payment row;
 *  5. `cron-group-settlement-reaper.ts` — a price-blind `CONFIRMED ->
 *     PAYMENT_PENDING` revert of an `ORGANISER_PAYS` group child, which is
 *     never billed and never gets a payment row of its own;
 *  6. `bookings/[id]/guests/route.ts` — a guest ADD releasing a free `PENDING`
 *     non-member hold once the hold window elapses; the file mints no payment.
 *
 * Two near-misses are deliberately NOT on that list, because both were checked
 * and refuted: guest REMOVAL settles the same case to `PAID`
 * (`booking-guest-removal-service.ts` reaches the un-nested settle, since no
 * caller can supply the `ADMIN` actor role its skip arm needs), and the guest-add
 * route once carried an `AWAITING_REVIEW -> PAYMENT_PENDING` arm that its own
 * edit door made unreachable — #3500 deleted it; only the officer review route
 * writes that transition.
 *
 * On any of those, returning the booking to `WAITLISTED` would un-confirm a
 * booking that was never on a waitlist, prune its bed allocations and email its
 * member. So the shape is necessary and nowhere near sufficient, and the guard
 * asks for the one piece of positive evidence that exists: #2648's
 * `waitlist.confirm_offer_release_failed` audit row, written by exactly the code
 * path that strands a confirm, naming this booking, at `critical` severity
 * (seven-year retention). `confirmWaitlistOffer`'s phase-one claim nulls
 * `waitlistPosition`, `waitlistOfferedAt` and `waitlistOfferExpiresAt` before a
 * strand can exist, and `waitlistOfferedLodgeId`/`waitlistOfferedPriceCents` are
 * cross-lodge-only (a path that never parks in `PAYMENT_PENDING`), so the
 * booking row itself retains no waitlist provenance at all.
 *
 * "Unresolved" is load-bearing, not decoration. A strand report is permanent, so
 * a booking repaired once carries one forever; without the resolution test, a
 * booking that was stranded, repaired, successfully re-confirmed and later
 * repriced to zero by one of the producers above would look eligible again on
 * the strength of a closed incident. The newest of the two actions therefore has
 * to be the strand rather than the repair, which is one indexed read.
 *
 * Returns the strand row to record in the repair's own audit metadata, or null
 * when there is no unresolved report — which the route and the booking page both
 * treat as "not this tool's business".
 */
export async function findUnresolvedWaitlistStrandReport(
  db: WaitlistStrandAuditReader,
  bookingId: string,
): Promise<{ id: string; createdAt: Date } | null> {
  const latest = await db.auditLog.findFirst({
    where: {
      targetId: bookingId,
      action: {
        in: [
          WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION,
          RETURN_TO_WAITLIST_AUDIT_ACTION,
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, action: true, createdAt: true },
  });

  if (
    latest?.action !== WAITLIST_CONFIRM_OFFER_RELEASE_FAILED_AUDIT_ACTION
  ) {
    return null;
  }
  return { id: latest.id, createdAt: latest.createdAt };
}

/**
 * The status-guarded claim matched no row: another writer moved the booking
 * between the re-read and the claim. Nothing was written, and the operator is
 * told exactly that rather than being left to guess.
 */
export const RETURN_TO_WAITLIST_CLAIM_LOST_MESSAGE =
  "The booking changed while it was being returned to the waitlist, so nothing was written. Reload the page and check where it ended up.";

/**
 * Prisma's transaction contention codes: P2028 (transaction API error, which
 * covers an exhausted `maxWait`/`timeout`) and P2034 (write conflict/deadlock,
 * retryable by definition). Same set and same 503 answer as
 * `waitlist-confirm/route.ts`, `admin-bed-allocation-routes.ts`,
 * `admin/site-style/route.ts` and `deletion-request-decision.ts`, for the reason
 * `docs/CONCURRENCY_AND_LOCKING.md` gives: a counterpart writer legitimately
 * holds `lock(1)` or the lodge key for the length of a whole transaction, so an
 * exhausted wait is contention rather than a fault, nothing was committed, and
 * the real remedy is "again shortly", not "differently".
 *
 * This route needs the distinction more than most: it exists precisely BECAUSE
 * lock contention broke the confirm's compensating release (#2623 T4). Reporting
 * its own contention as an opaque 500 would tell the operator the repair is
 * broken when the honest answer is that something else is holding the booking.
 */
const RETURN_TO_WAITLIST_CONTENTION_CODES: ReadonlySet<string> = new Set([
  "P2028",
  "P2034",
]);

export function isReturnToWaitlistTransactionContention(
  error: unknown,
): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETURN_TO_WAITLIST_CONTENTION_CODES.has(code);
}

/**
 * Refused because the locked transaction could not take its locks in time.
 * Nothing was written, so the operator is told to retry rather than to escalate.
 */
export const RETURN_TO_WAITLIST_CONTENDED_MESSAGE =
  "Something else is holding this booking right now, so it could not be returned to the waitlist in time. Nothing was changed — try again in a moment.";
