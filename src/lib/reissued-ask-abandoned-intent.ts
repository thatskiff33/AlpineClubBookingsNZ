/**
 * #4052: THE INTENT A DOOR MINTED FOR A RE-ISSUE WHOSE RECOVERY MOVED MID-MINT.
 *
 * The door mints a reduction's smaller re-issued ask after commit, under its
 * recovery's Stripe key, and writes it only while that recovery is still
 * unclaimed (`writeReissuedAskUnderRecovery`). When the write loses that fence,
 * whoever moved the recovery owns the ask, and the door's intent is either
 * theirs or nobody's:
 *  - a runner still holding its claim (PROCESSING) that has not yet written
 *    an intent (the recovery still names the Stripe key the door read), or
 *    that wrote this very intent, owns it or may yet - left alone;
 *  - a runner still holding its claim that already wrote ANOTHER intent: its
 *    locked write repoints the recovery at that intent, with its row, before
 *    its Stripe cancels and invoice steps finish, and from then on it uses only
 *    that one (an amount-suffixed key, `planReissuedAskMint`) - the door's is
 *    nobody's (#4052 review);
 *  - a recovery that ended SUCCEEDED naming THIS intent: the runner minted
 *    under the same key, Stripe handed it the same intent, and it is the ask -
 *    left alone;
 *  - a recovery that ended SUCCEEDED naming no intent or another one: a later
 *    reduction netted the re-issue off, a later increase folded it into its own
 *    ask, or the runner minted under an amount-suffixed key
 *    (`planReissuedAskMint`) and wrote that intent instead. Nobody mints under
 *    the door's request again and no client secret was offered for it, so it
 *    can never be paid; it only clutters the club's Stripe account.
 *
 * Such an intent is cancelled at Stripe here, best-effort, with Stripe's
 * `abandoned` reason, after the door's transactions have committed - and only
 * on proof that nothing else owns it: no payment row and no recovery names it.
 * A failed read proves nothing and cancels nothing. Anything else (FAILED,
 * still PENDING) is left. The outcome is logged under one event name
 * (`ABANDONED_REISSUE_INTENT_LOG_EVENT`) so an operator can find an intent this
 * left; nothing is written locally - no transaction row is invented for it, and
 * an intent Stripe no longer lets us cancel (already cancelled, or captured) is
 * left as it is, never reported as cancelled. A second run finds it cancelled
 * and does nothing. The debt, any replacement ask and the late-capture refund
 * path are untouched.
 *
 * #4631: THE RUNNER'S SIDE, for any additional ask's recovery - an ordinary
 * ask's as well as a re-issue's. The recovery runner mints before it writes, and
 * writes only while it still holds its claim (`holdAdditionalIntentRecoveryClaim`).
 * When that hold loses, its intent is in the door's position: once the recovery
 * has ended SUCCEEDED without naming it, nobody writes under it again - the
 * hold, the door's write and a stale runner's are all fenced on a claimable
 * recovery, and nothing reopens a closed one but an officer's review-charge
 * re-arm (`rearmEditFinancialReviewChargeRecovery`), whose replay never reaches
 * this - so the door's proof, re-read after the
 * hold's transaction has ended, and the same cancel apply
 * (`settleLostRecoveryClaimHold`). #4652: that covers a net-off or fold
 * (`reissueClosedUnminted`) and a stale reclaim whose runner closed it with
 * another intent or none. Anything else - a recovery reset, or reclaimed by a
 * runner still PROCESSING (even one that wrote another intent), PENDING or
 * FAILED - may yet record it, and is left. So is an intent the runner ADOPTED
 * by matching (#4036) rather than minted under its own key: it is not the
 * runner's own, and another edit's stalled door or recovery may still record it
 * under that edit's key, which the owner check cannot see.
 *
 * #4652: THE CREDIT-RELEASE ASK (`processCreditReleaseAskOperation`) mints under
 * a Stripe key scoped to its release and writes under the same claim hold; its
 * recovery is never netted off or folded, so only a stale reclaim moves it. Its
 * lost hold takes the same proof: no door, no adoption and no other recovery
 * mints or matches under its key or reason, so a closed one is terminal.
 */
import { PaymentRecoveryOperationStatus } from "@prisma/client";

import {
  readReissuedAskRecovery,
  reissueClosedUnminted,
  type ReissuedAskRecovery,
} from "@/lib/additional-ask-reissue";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { cancelPaymentIntentIfCancellableWithResult } from "@/lib/stripe";

/** The `event` every outcome of this cleanup is logged under (#4052). */
export const ABANDONED_REISSUE_INTENT_LOG_EVENT = "reissued-ask.abandoned-intent-cleanup";

/**
 * After the door's write lost its fence: re-read the recovery (null when the
 * read fails), cancel the door's intent when that proves nobody owns it, and
 * return the re-read for the door's email decision (`reissueNotMinted`).
 */
export async function settleLostReissuedAskFence({
  stripeKey,
  ...call
}: {
  bookingId: string;
  bookingModificationId: string;
  /** The intent the door minted under the recovery's key. */
  paymentIntentId: string;
  /** That key, as the door read it on the recovery before minting. */
  stripeKey: string;
}): Promise<ReissuedAskRecovery | null> {
  const moved = await readReissuedAskRecovery(call.bookingModificationId).catch((err: unknown) => {
    logger.error({ err, bookingId: call.bookingId }, "Could not re-read a re-issued ask's recovery; the email names it (#3954)");
    return null;
  });
  if (!moved || moved.paymentIntentId === call.paymentIntentId) return moved;
  const closedBy = closedWithoutIntent(moved, call.paymentIntentId);
  if (closedBy) {
    await cancelAbandonedReissuedAskIntent({ ...call, closedBy });
  } else if (moved.status === PaymentRecoveryOperationStatus.PROCESSING && moved.paymentIntentId !== stripeKey) {
    await cancelAbandonedReissuedAskIntent({ ...call, closedBy: "runner-wrote-another" });
  }
  return moved;
}

/**
 * #4052's proof, one rule for the door and the runner: the recovery ended
 * SUCCEEDED without naming this intent - a net-off or fold (`reissueClosedUnminted`),
 * or its own runner closed it with another intent or none ("minted-elsewhere").
 * Null for anything else, which may yet record it.
 */
function closedWithoutIntent(
  moved: Pick<ReissuedAskRecovery, "status" | "lastError" | "paymentIntentId"> | null,
  paymentIntentId: string,
): ClosedBy | null {
  if (moved?.status !== PaymentRecoveryOperationStatus.SUCCEEDED || moved.paymentIntentId === paymentIntentId) return null;
  return reissueClosedUnminted(moved) ?? "minted-elsewhere";
}

/**
 * #4631, #4652: after a runner's claim hold lost (its transaction ended, nothing
 * written) - the recovery runner's or the credit-release ask's: re-read the
 * recovery, and cancel the intent the runner minted when the recovery ended
 * without it (`closedWithoutIntent`) and no row or recovery names that intent.
 * Never throws: an unread or unproven recovery cancels nothing, and the run
 * ends as before.
 */
export async function settleLostRecoveryClaimHold(call: {
  operationId: string;
  bookingId: string;
  /** The intent the runner minted and could not write. */
  paymentIntentId: string;
  /** Found by matching (`mintOrdinaryAskIntent`, #4036), not minted under this recovery's key: never cancelled. */
  adopted: boolean;
}): Promise<void> {
  const moved = await prisma.paymentRecoveryOperation
    .findUnique({ where: { id: call.operationId }, select: { status: true, lastError: true, paymentIntentId: true } })
    .catch((err: unknown) => {
      logger.error({ err, ...call, event: ABANDONED_REISSUE_INTENT_LOG_EVENT, outcome: "unread" }, "Could not re-read a recovery whose claim was lost; its minted intent is not cancelled (#4631)");
      return null;
    });
  const { adopted, ...intent } = call;
  const closedBy = closedWithoutIntent(moved, call.paymentIntentId);
  if (closedBy && adopted) {
    logger.warn(
      { ...intent, event: ABANDONED_REISSUE_INTENT_LOG_EVENT, closedBy, outcome: "adopted" },
      "Additional intent recovery lost its claim on an intent it adopted by matching (#4036); not its own, so it is left in Stripe (#4631)",
    );
    return;
  }
  logger.warn(
    { ...call, status: moved?.status, recoveryPaymentIntentId: moved?.paymentIntentId, closedBy },
    "Additional intent recovery lost its claim before writing its row; nothing written - the minted intent was never offered to anyone, and is cancelled at Stripe only when its recovery ended without it (#3954, #4631, #4652)",
  );
  if (closedBy) await cancelAbandonedReissuedAskIntent({ ...intent, closedBy });
}

type ClosedBy = "netted" | "folded" | "minted-elsewhere";

async function cancelAbandonedReissuedAskIntent(call: {
  bookingId: string;
  /** Who minted it: the door names its edit, the runner its recovery (#4631). */
  bookingModificationId?: string;
  operationId?: string;
  paymentIntentId: string;
  closedBy: ClosedBy | "runner-wrote-another";
}): Promise<void> {
  const context = { event: ABANDONED_REISSUE_INTENT_LOG_EVENT, ...call };
  try {
    const [row, recovery] = await Promise.all([
      prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: call.paymentIntentId }, select: { id: true } }),
      prisma.paymentRecoveryOperation.findFirst({ where: { paymentIntentId: call.paymentIntentId }, select: { id: true } }),
    ]);
    if (row || recovery) {
      logger.warn(
        { ...context, outcome: "owned", paymentTransactionId: row?.id, ownerOperationId: recovery?.id },
        "An ask's minted intent is named by a payment row or recovery although its own recovery ended without it; left to that owner (#4052)",
      );
      return;
    }
  } catch (err) {
    logger.error({ err, ...context, outcome: "unread" }, "Could not check an abandoned ask's intent for an owner; it is not cancelled (#4052)");
    return;
  }

  try {
    const result = await cancelPaymentIntentIfCancellableWithResult(call.paymentIntentId, {
      // The member never declined it: the club retired the ask before offering it.
      cancellationReason: "abandoned",
    });
    const outcome = { ...context, outcome: result.canceled ? "cancelled" : "uncancellable", canceled: result.canceled, intentStatus: result.paymentIntent.status };
    if (result.canceled) {
      logger.info(outcome, "Cancelled the unused intent minted for an ask whose recovery moved mid-mint (#4052)");
    } else {
      logger.warn(outcome, "Left an abandoned ask's intent alone: Stripe no longer lets it be cancelled (#4052)");
    }
  } catch (err) {
    logger.error(
      { err, ...context, outcome: "cancel-failed" },
      "Could not cancel the unused intent minted for an ask whose recovery moved mid-mint; it was never offered, so it cannot be paid, and stays in Stripe (#4052)",
    );
  }
}
