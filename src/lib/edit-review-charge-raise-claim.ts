import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";

/**
 * #3402 (`INV-PAY-111`): the lease that makes RAISING one booking edit's
 * review-charge request single-flight.
 *
 * ## The defect
 *
 * `syncEditFinancialReviewChargeRequest` reads the edit's one request, derives
 * the new ask, calls Stripe and writes the row. Two settlements of one edit used
 * to do that side by side: both read the stored $50, one derived $60 and the
 * other $100, both raised the intent, and the LAST provider call and the LAST row
 * write won. When that was the $60 run, $40 was never asked for and nothing
 * recorded it. A predicate on the row write cannot repair it - both runs derive a
 * figure above the stored one, so both pass any `amountCents < raised` test, and
 * the money has already moved at Stripe before the row is written.
 *
 * ## The claim
 *
 * So the claim is taken BEFORE the provider call, on its own row (one per
 * `BookingModification`, created on first use): a guarded `updateMany` writes a
 * fresh opaque token only where no live token is held. Under READ COMMITTED a
 * second concurrent claim re-checks that predicate against the winner's committed
 * row and matches nothing, so exactly one run proceeds to Stripe.
 *
 * It is a LEASE, not a lock. Every statement here autocommits; nothing is held
 * across the provider call, which `docs/CONCURRENCY_AND_LOCKING.md` forbids, and
 * no advisory key is taken. A holder that dies leaves a token that simply ages
 * out: after {@link EDIT_REVIEW_CHARGE_RAISE_LEASE_MS} the next run takes it over.
 * Taking over is safe because the derived share total only grows and a raise is
 * an ABSOLUTE amount: the new holder's figure is at least anything the dead one
 * meant to ask for.
 *
 * Every write after the claim matches the EXACT token, the rule the hosting
 * drain's leases use, so a holder whose lease was taken over can neither record
 * an intent nor release its successor's claim.
 */

/**
 * How long a claim protects its holder before another run may take it over.
 *
 * It has to outlast any LIVE holder, because a holder that is merely slow and
 * then lands an older, smaller absolute amount after its successor would undo the
 * successor's raise. The Stripe client runs with its defaults - an 80 second
 * timeout and two network retries - so one call can take about four minutes, and
 * a holder makes at most a handful (the currency check, then an update or a
 * re-issue or a mint). Thirty minutes is well clear of that and still short
 * against the recovery cron's backoff (5, 15, 60, 240, 720 minutes), so a run
 * that deferred to a dead holder is retried after the lease has expired.
 */
export const EDIT_REVIEW_CHARGE_RAISE_LEASE_MS = 30 * 60 * 1000;

/** Proof that this run holds the edit's raise claim: pass it to every later write. */
export type EditReviewChargeRaiseClaim = {
  readonly bookingModificationId: string;
  readonly token: string;
};

/**
 * Try to take the edit's raise claim. Returns the claim, or `null` when another
 * run holds a live one - in which case the caller must NOT call Stripe.
 */
export async function claimEditReviewChargeRaise(
  bookingModificationId: string,
): Promise<EditReviewChargeRaiseClaim | null> {
  // The row exists from the first claim on; creating it is idempotent, and
  // creating it is not claiming it - the guarded update below decides that.
  await prisma.editReviewChargeRaiseClaim.createMany({
    data: [{ bookingModificationId }],
    skipDuplicates: true,
  });
  const now = new Date();
  const token = randomUUID();
  const claimed = await prisma.editReviewChargeRaiseClaim.updateMany({
    where: {
      bookingModificationId,
      OR: [
        { claimToken: null },
        { claimedAt: { lt: new Date(now.getTime() - EDIT_REVIEW_CHARGE_RAISE_LEASE_MS) } },
      ],
    },
    data: { claimToken: token, claimedAt: now, intendedAmountCents: null },
  });
  return claimed.count === 1 ? { bookingModificationId, token } : null;
}

/**
 * Record what the holder is about to ask Stripe for, and renew its lease.
 *
 * Returns false when the claim is no longer this run's - its lease expired and
 * another run took it over - and the caller must then make no provider call.
 * The recorded figure is a diagnostic trail, never money: the request row stays
 * what the member is asked for.
 */
export async function recordEditReviewChargeRaiseIntent(
  claim: EditReviewChargeRaiseClaim,
  intendedAmountCents: number,
): Promise<boolean> {
  const recorded = await prisma.editReviewChargeRaiseClaim.updateMany({
    where: {
      bookingModificationId: claim.bookingModificationId,
      claimToken: claim.token,
    },
    data: { intendedAmountCents, claimedAt: new Date() },
  });
  return recorded.count === 1;
}

/**
 * Give the claim up. Exact-token, so a holder whose lease was taken over cannot
 * clear its successor's. Returns whether this run still held it; a release that
 * fails outright costs nothing but a wait, because the token then ages out.
 */
export async function releaseEditReviewChargeRaise(
  claim: EditReviewChargeRaiseClaim,
): Promise<boolean> {
  const released = await prisma.editReviewChargeRaiseClaim.updateMany({
    where: {
      bookingModificationId: claim.bookingModificationId,
      claimToken: claim.token,
    },
    data: { claimToken: null, claimedAt: null, intendedAmountCents: null },
  });
  return released.count === 1;
}
