/**
 * #4316 (`INV-ADDPAY-044`): AN EDIT'S AFTER-COMMIT MINT NEVER LEAVES A LIVE ASK
 * ON A BOOKING THAT HAS ENDED.
 *
 * The edit doors decide to ask the card under `lock(1)`, but
 * `createModificationAdditionalPaymentIntent` creates the Stripe intent after
 * their commit, so a cancel can land in between - and so can it before the
 * recovery runner's replay of a failed mint
 * (`processCreateAdditionalPaymentIntentOperation`) and a currency re-issue
 * (`reissueAdditionalIntentInClubCurrency`), which run both guards too. The
 * cancel's claim retires only the intent it reads on the `Payment` mirror. Each
 * minter therefore re-reads the booking twice, against the statuses that retire every
 * ask on it (`ADDITIONAL_ASK_RETIRED_BOOKING_STATUSES`, the cancelled-booking
 * case of `INV-ADDPAY-023`):
 * before the provider call (`bookingEndedBeforeAskMint`) and after its row
 * write (`retireAskOnEndedBooking`). Both are plain reads: the order the second
 * one needs comes from the `Payment` row lock the row write takes.
 */
import { readBookingHasEnded } from "@/lib/booking-ended";
import {
  cancelSupersededAdditionalIntentsNow,
  failOutstandingAdditionalAskUnderRowLock,
} from "@/lib/booking-payment-cleanup";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { isOpenIntentTransactionStatus } from "@/lib/payment-transaction-status";
import { enqueuePaymentIntentCancellationRecovery } from "@/lib/payment-recovery";
import { prisma } from "@/lib/prisma";

/**
 * Before the provider call: has the booking ended (CANCELLED or BUMPED) since
 * its edit committed? Then it is asked nothing and owes nothing - no intent, no
 * row, no recovery. A re-issue's recovery, written with the edit, is closed by
 * its runner, which skips a cancelled booking. A failed read answers no and the
 * mint goes ahead; the check after the row write still stands.
 */
export async function bookingEndedBeforeAskMint(
  bookingId: string,
  bookingModificationId: string | null,
): Promise<boolean> {
  const ended = await readBookingHasEnded(bookingId).catch((err: unknown) => {
    logger.error({ err, bookingId }, "Could not re-read the booking before minting its additional ask (#4316)");
    return false;
  });
  if (ended) {
    logger.info(
      { bookingId, bookingModificationId },
      "The booking ended after its edit committed; no additional ask is minted (#4316)",
    );
  }
  return ended;
}

/**
 * Retire whatever additional ask the `Payment` mirror names as outstanding, as
 * the paid cancel's claim retires one: the same routine under the same row lock
 * (`failOutstandingAdditionalAskInClaim`) - the mirror and the row FAILED and a
 * durable `CANCEL_PAYMENT_INTENT` queued in that transaction - then the Stripe
 * cancel run now. One already retired is outstanding no longer and is left.
 * Throws when the transaction fails.
 */
async function retireOutstandingAsk({ format, bookingId, paymentId }: { format: ClubFormat; bookingId: string; paymentId: string }) {
  const queued = await prisma.$transaction((tx) => failOutstandingAdditionalAskUnderRowLock(tx, { bookingId, paymentId }));
  if (queued) await cancelSupersededAdditionalIntentsNow({ format, bookingId, paymentId, queued: [queued] });
  return queued;
}

/**
 * Review round 2: THE INTENT'S CANCELLATION IS DURABLE BEFORE ANYTHING ELSE. The
 * retirement transaction above writes the same `CANCEL_PAYMENT_INTENT` row, but
 * a transaction that fails (a deadlock, a timeout) writes nothing, and nothing
 * else would ever look for this intent. So its row, still outstanding, has its
 * cancellation queued first, on its own: the recovery cron then cancels it at
 * Stripe and marks its row FAILED even if every later step fails. Same key as
 * the claim's, so the transaction's own write lands on this row.
 */
async function queueAskCancellationFirst({ bookingId, paymentId, paymentIntentId }: { bookingId: string; paymentId: string; paymentIntentId: string }) {
  const row = await prisma.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true, paymentId: true, amountCents: true, status: true },
  });
  if (!row || row.paymentId !== paymentId) return;
  if (!isOpenIntentTransactionStatus(row.status)) return;
  await enqueuePaymentIntentCancellationRecovery({
    bookingId,
    paymentId,
    paymentTransactionId: row.id,
    paymentIntentId,
    amountCents: row.amountCents,
  });
}

/** What the check after the row write found. */
type EndedAskCheck = "live" | "retired" | "unretired";

async function checkAndRetireAfterWrite({
  format,
  bookingId,
  paymentId,
  paymentIntentId,
}: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
}): Promise<EndedAskCheck> {
  const ended = await readBookingHasEnded(bookingId).catch((err: unknown) => {
    logger.error(
      { err, bookingId, paymentIntentId },
      "Could not re-read the booking after writing its additional ask; it is offered as live (#4316)",
    );
    return false;
  });
  if (!ended) return "live";
  try {
    await queueAskCancellationFirst({ bookingId, paymentId, paymentIntentId });
    const queued = await retireOutstandingAsk({ format, bookingId, paymentId });
    logger.warn(
      { bookingId, paymentId, paymentIntentId, retiredHere: queued !== null },
      "The booking ended while its edit's additional ask was minted; the ask is retired, not offered (#4316)",
    );
    return "retired";
  } catch (err) {
    logger.error(
      { err, bookingId, paymentId, paymentIntentId },
      "Could not retire an additional ask minted on a booking that has ended; its queued cancellation, if written, still runs (#4316)",
    );
    return "unretired";
  }
}

/**
 * After the row write: THE OTHER HALF OF THE RACE. A cancel that committed after
 * the check above, but before this ask's row was written, read a `Payment`
 * mirror with no such intent on it, so it left this one live at Stripe on a
 * cancelled booking.
 *
 * The two writers cannot both miss: the row write takes the `Payment` row lock,
 * as both cancel claims do before they read the mirror. A cancel that held it
 * first committed before the row was written, so this read sees it; one that
 * took it after reads this intent on the mirror and retires it itself. When the
 * booking has ended, the intent's cancellation is queued durably first, then
 * the ask retired as the claim retires one (`retireOutstandingAsk`).
 *
 * Returns whether the booking has ended; the minter then offers no secret and
 * returns no intent id. A failed status read answers no, as the code did before
 * #4316; a failed retirement is logged and still answers yes - the cancellation
 * queued first finishes it, if it was written.
 */
export async function retireAskOnEndedBooking(params: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
}): Promise<boolean> {
  return (await checkAndRetireAfterWrite(params)) !== "live";
}

/**
 * The recovery runner's form of the check after its row write: as above, but a
 * failed retirement THROWS, so the runner's own row backs off and retries -
 * where its check before the mint retires what is left
 * (`retireOutstandingAskOnEndedBooking`).
 */
export async function replayRetiresAskOnEndedBooking(params: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
}): Promise<boolean> {
  const check = await checkAndRetireAfterWrite(params);
  if (check === "unretired") {
    throw new Error(
      `Could not retire additional ask ${params.paymentIntentId} on ended booking ${params.bookingId}; leaving the recovery to retry (#4316)`,
    );
  }
  return check === "retired";
}

/**
 * The recovery runner's check before its mint, on a booking that has ended: a
 * retry after a failed retirement finds the ask it wrote still outstanding on
 * the mirror, so it retires it here before closing. Throws when it cannot, so
 * the row retries again.
 */
export async function retireOutstandingAskOnEndedBooking(params: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
}): Promise<void> {
  await retireOutstandingAsk(params);
}
