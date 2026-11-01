/**
 * #4052: THE INTENT A DOOR MINTED FOR A RE-ISSUE THAT WAS RETIRED MID-MINT.
 *
 * The door mints a reduction's smaller re-issued ask after commit, under its
 * recovery's Stripe key, and writes it only while that recovery is still
 * unclaimed (`writeReissuedAskUnderRecovery`). When the write loses that fence,
 * whoever moved the recovery owns the ask. A runner that claimed it mints under
 * the same key, so Stripe hands it this same intent: that intent is the
 * runner's, and is never touched here. But a later reduction that netted the
 * re-issue off, or a later increase that folded it into its own ask, closed the
 * recovery without a mint (`reissueClosedUnminted`). Nobody mints under that key
 * again, no row names the intent, and no client secret was offered - so it can
 * never be paid, and only clutters the club's Stripe account.
 *
 * Such an intent is cancelled at Stripe here, best-effort, with Stripe's
 * `abandoned` reason, after the door's transactions have committed. Only on
 * proof: the recovery re-read says reduction or fold, it does not carry this
 * intent's id, and no payment transaction row names the intent. A failed read
 * proves nothing and cancels nothing. The outcome is logged; nothing is written
 * locally - no transaction row is invented for it, and an intent Stripe no
 * longer lets us cancel (already cancelled, or captured) is left as it is and
 * logged as such, never reported as cancelled. A second run finds it cancelled
 * and does nothing. The debt, any replacement ask and the late-capture refund
 * path are untouched.
 */
import {
  readReissuedAskRecovery,
  reissueClosedUnminted,
  type ReissuedAskRecovery,
} from "@/lib/additional-ask-reissue";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { cancelPaymentIntentIfCancellableWithResult } from "@/lib/stripe";

/**
 * After the door's write lost its fence: re-read the recovery (null when the
 * read fails), cancel the door's intent when that proves nobody owns it, and
 * return the re-read for the door's email decision (`reissueNotMinted`).
 */
export async function settleLostReissuedAskFence(call: {
  bookingId: string;
  bookingModificationId: string;
  /** The intent the door minted under the recovery's key. */
  paymentIntentId: string;
}): Promise<ReissuedAskRecovery | null> {
  const moved = await readReissuedAskRecovery(call.bookingModificationId).catch((err: unknown) => {
    logger.error({ err, bookingId: call.bookingId }, "Could not re-read a re-issued ask's recovery; the email names it (#3954)");
    return null;
  });
  const closedBy = reissueClosedUnminted(moved);
  if (moved && closedBy && moved.paymentIntentId !== call.paymentIntentId) {
    await cancelAbandonedReissuedAskIntent({ ...call, closedBy });
  }
  return moved;
}

async function cancelAbandonedReissuedAskIntent(call: {
  bookingId: string;
  bookingModificationId: string;
  paymentIntentId: string;
  closedBy: "netted" | "folded";
}): Promise<void> {
  const context = { ...call };
  try {
    const row = await prisma.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: call.paymentIntentId },
      select: { id: true },
    });
    if (row) {
      logger.warn(
        { ...context, paymentTransactionId: row.id },
        "A re-issued ask's intent has a payment row although its recovery was closed without a mint; left to that row's own lifecycle (#4052)",
      );
      return;
    }
  } catch (err) {
    logger.error({ err, ...context }, "Could not check an abandoned re-issued ask's intent for a payment row; it is not cancelled (#4052)");
    return;
  }

  try {
    const result = await cancelPaymentIntentIfCancellableWithResult(call.paymentIntentId, {
      // The member never declined it: the club retired the ask before offering it.
      cancellationReason: "abandoned",
    });
    const outcome = { ...context, canceled: result.canceled, intentStatus: result.paymentIntent.status };
    if (result.canceled) {
      logger.info(outcome, "Cancelled the unused intent a door minted for a re-issued ask retired mid-mint (#4052)");
    } else {
      logger.warn(outcome, "Left an abandoned re-issued ask's intent alone: Stripe no longer lets it be cancelled (#4052)");
    }
  } catch (err) {
    logger.error(
      { err, ...context },
      "Could not cancel the unused intent a door minted for a re-issued ask retired mid-mint; it was never offered, so it cannot be paid, and stays in Stripe (#4052)",
    );
  }
}
