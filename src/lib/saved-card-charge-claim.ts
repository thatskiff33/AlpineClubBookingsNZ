import "server-only";

import { BookingStatus, PaymentSource, PaymentStatus, type Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import logger from "@/lib/logger";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { isTransactionContention } from "@/lib/prisma-errors";

/*
 * The durable side of the saved-card charge claim (#4993, `INV-PAY-055`).
 *
 * Every off-session saved-card charge claims its booking PENDING -> CONFIRMED
 * under the locks, then calls Stripe outside any transaction (#1418). The claim
 * stamps `Booking.savedCardClaimAt`; a release back to PENDING or a promotion to
 * PAID clears it. A booking still CONFIRMED with a marker older than
 * `SAVED_CARD_CLAIM_RECOVERY_AGE_MS` lost its in-memory compensation — the
 * process stopped mid-charge, or the release itself failed — and the next
 * `confirmPendingBookings` run hands it back to PENDING so the ordinary pass
 * replays the attempt by its own key.
 */

/**
 * Longer than any live claimer holds a claim: a Stripe request with its retries
 * and the superseded-intent cancels before it. Well inside the attempt ledger's
 * 23-hour key replay window, so a recovered claim replays rather than re-mints.
 */
export const SAVED_CARD_CLAIM_RECOVERY_AGE_MS = 30 * 60 * 1000;

/**
 * `docs/CONCURRENCY_AND_LOCKING.md` rule 1: a compensating transaction gets its
 * own budget. Two of the three releasers have a person waiting, so these match
 * waitlist-confirm's release (5s / 10s, two attempts).
 */
const RELEASE_BUDGET = { maxWait: 5_000, timeout: 10_000 } as const;
const RELEASE_ATTEMPTS = 2;
const RELEASE_RETRY_DELAY_MS = 250;

export const SAVED_CARD_CLAIM_RELEASE_FAILED_AUDIT_ACTION =
  "booking.saved_card_claim_release_failed";
export const SAVED_CARD_CLAIM_RECOVERED_AUDIT_ACTION =
  "booking.saved_card_claim_recovered";

type ClaimLockContext = { bookingId: string; lodgeId: string | null };

/**
 * Hands a claimed booking back: CONFIRMED -> PENDING with its hold restored and
 * the marker cleared, then its beds reconciled. The caller holds global then
 * lodge (`runSavedCardClaimRelease`). A booking no longer CONFIRMED — settled
 * PAID by the webhook, or cancelled — is reported, not touched. `expectedMarker`
 * narrows the guard to one claim, so recovery cannot release a newer one.
 */
export async function releaseSavedCardChargeClaim(
  tx: Prisma.TransactionClient,
  input: {
    bookingId: string;
    restoreHoldUntil: Date | null;
    previousRange: { checkIn: Date; checkOut: Date };
    expectedMarker?: Date;
  },
): Promise<{ released: boolean; statusFound: BookingStatus | null }> {
  const current = await tx.booking.findUnique({
    where: { id: input.bookingId },
    select: { status: true },
  });
  const statusFound = current?.status ?? null;
  if (statusFound !== BookingStatus.CONFIRMED) return { released: false, statusFound };
  const changed = await tx.booking.updateMany({
    where: {
      id: input.bookingId,
      status: BookingStatus.CONFIRMED,
      ...(input.expectedMarker ? { savedCardClaimAt: input.expectedMarker } : {}),
    },
    data: {
      status: BookingStatus.PENDING,
      nonMemberHoldUntil: input.restoreHoldUntil,
      savedCardClaimAt: null,
    },
  });
  if (changed.count === 0) return { released: false, statusFound };
  await reconcileBedAllocationsForBookingWithGlobalLockHeld({
    bookingId: input.bookingId,
    db: tx,
    previousRange: input.previousRange,
  });
  return { released: true, statusFound };
}

/**
 * Runs one release or recovery under global `lock(1)` then the booking's lodge
 * key (`INV-LOCK-001`/`002`), so it excludes the webhook's PAID promotion and
 * cancellation. Explicit budget, one retry on P2028/P2034, and never throws: a
 * final failure is logged, recorded as an awaited critical audit row, and
 * returned as `{ ok: false }`. The booking keeps its marker, so the next
 * `recoverStaleSavedCardClaims` picks it up.
 */
export async function runSavedCardClaimRelease<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  context: ClaimLockContext,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let failure: unknown;
  for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
    try {
      const value = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await acquireLodgeCapacityLock(tx, context.lodgeId ?? (await getDefaultLodgeId(tx)));
        return work(tx);
      }, RELEASE_BUDGET);
      return { ok: true, value };
    } catch (err) {
      failure = err;
      if (!isTransactionContention(err) || attempt === RELEASE_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_DELAY_MS));
    }
  }
  logger.error(
    { err: failure, ...context },
    "Failed to release a saved-card charge claim; its marker stays for automatic recovery (#4993)",
  );
  try {
    await createAuditLog({
      action: SAVED_CARD_CLAIM_RELEASE_FAILED_AUDIT_ACTION,
      targetId: context.bookingId,
      entityType: "Booking",
      entityId: context.bookingId,
      category: "payment",
      severity: "critical",
      outcome: "failure",
      summary: "Saved-card charge claim could not be released",
      details:
        "A saved-card charge did not capture and handing the booking back to Pending failed. The booking stays Confirmed and unpaid, holding its beds, until the confirm-pending job's recovery returns it to Pending and charges it again by replaying the same attempt.",
      metadata: {
        lodgeId: context.lodgeId,
        errorCode: (failure as { code?: unknown } | null)?.code ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, ...context }, "Failed to write the saved-card claim release-failed audit row");
  }
  return { ok: false };
}

/**
 * Returns stale saved-card claims to PENDING (#4993). Population: CONFIRMED, a
 * marker older than the recovery age, a Stripe payment still PENDING with no
 * captured row. A CONFIRMED booking without a marker — Internet Banking holds,
 * group and school bookings, claims by older code — is never touched. No Stripe
 * call and no attempt-row write: the ordinary pass's `beginSavedCardChargeAttempt`
 * replays or refuses (`INV-PAY-089`). The hold becomes the marker time, so the
 * same run's pending pass selects the booking.
 */
export async function recoverStaleSavedCardClaims(now: Date) {
  const cutoff = new Date(now.getTime() - SAVED_CARD_CLAIM_RECOVERY_AGE_MS);
  const candidates = await prisma.booking.findMany({
    where: {
      status: BookingStatus.CONFIRMED,
      savedCardClaimAt: { lte: cutoff },
      payment: { source: PaymentSource.STRIPE, status: PaymentStatus.PENDING },
    },
    select: { id: true, lodgeId: true },
    orderBy: { savedCardClaimAt: "asc" },
  });
  const result = { recoveredBookingIds: [] as string[], failedBookingIds: [] as string[] };
  for (const candidate of candidates) {
    const context = { bookingId: candidate.id, lodgeId: candidate.lodgeId };
    const outcome = await runSavedCardClaimRelease(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: candidate.id },
        select: {
          status: true,
          savedCardClaimAt: true,
          checkIn: true,
          checkOut: true,
          payment: {
            select: { source: true, status: true, transactions: { select: { status: true } } },
          },
        },
      });
      const marker = booking?.savedCardClaimAt;
      if (
        !booking ||
        !marker ||
        marker > cutoff ||
        booking.status !== BookingStatus.CONFIRMED ||
        booking.payment?.source !== PaymentSource.STRIPE ||
        booking.payment.status !== PaymentStatus.PENDING ||
        booking.payment.transactions.some((row) => isCapturedTransactionStatus(row.status))
      ) {
        return null;
      }
      const release = await releaseSavedCardChargeClaim(tx, {
        bookingId: candidate.id,
        restoreHoldUntil: marker,
        expectedMarker: marker,
        previousRange: { checkIn: booking.checkIn, checkOut: booking.checkOut },
      });
      return release.released ? marker : null;
    }, context);
    if (!outcome.ok) {
      result.failedBookingIds.push(candidate.id);
      continue;
    }
    if (!outcome.value) continue;
    result.recoveredBookingIds.push(candidate.id);
    const markerAgeMs = now.getTime() - outcome.value.getTime();
    logger.warn({ ...context, markerAgeMs }, "Recovered a stale saved-card charge claim (#4993)");
    try {
      await createAuditLog({
        action: SAVED_CARD_CLAIM_RECOVERED_AUDIT_ACTION,
        targetId: candidate.id,
        entityType: "Booking",
        entityId: candidate.id,
        category: "payment",
        severity: "critical",
        outcome: "success",
        summary: "Interrupted saved-card charge returned to Pending",
        details:
          "The booking was claimed Confirmed for a saved-card charge that never finished. It is back to Pending and the confirm-pending job charges it again in the same run, replaying the original attempt so a card is never charged twice.",
        metadata: { lodgeId: candidate.lodgeId, markerAgeMs },
      });
    } catch (err) {
      logger.error({ err, ...context }, "Failed to write the saved-card claim recovery audit row");
    }
  }
  return result;
}
