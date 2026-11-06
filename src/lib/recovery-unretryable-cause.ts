/**
 * #4081: A RECOVERY FAILURE A RETRY CANNOT FIX STOPS THE RECOVERY AT ONCE.
 *
 * The recovery runner retries a failed attempt on a backoff (5, 15, 60 and 240
 * minutes between five attempts, about 5h20m) and alerts an officer only when
 * the attempts run out. That suits a provider outage, which passes. It does not suit a refusal
 * the next attempt will meet again, which only burns the backoff before anyone
 * hears of it.
 *
 * Three such refusals today. The first: an edit's ask write that finds its intent already
 * recorded for another edit (`AdditionalAskAttributionConflictError`,
 * `INV-MOD-060`). Edit X's recovery adopted edit Y's intent, Y's write was
 * refused, and Y's retry that re-derives the same figure (the frozen fallback,
 * say) is handed the same intent by Stripe and refused again on every attempt.
 *
 * The second (#4217): an ask write that finds its intent's ledger row on a
 * different payment from the one it locked
 * (`IntentLedgerRowOnAnotherPaymentError`). The row write is pinned to its
 * payment, so every retry meets the same row and is refused again.
 *
 * The third (#4015 review): a replay that has waited its longest on a carried
 * ask Stripe is still taking money on (`CarriedAskPaymentWaitExpiredError`).
 *
 * So the runner's failure path (`failPaymentRecoveryOperation`) ends the
 * recovery on the first such failure, through the one terminal transition
 * (`markPaymentRecoveryOperationFailed`, `INV-PAY-056`): FAILED with no retry,
 * at the attempt ceiling, the cause below on `lastError` and in the officers'
 * alert. The debt stays on the row, and the stuck-state page lists it with the
 * exhausted recoveries.
 */
import { PaymentRecoveryOperationType, type PaymentRecoveryOperation } from "@prisma/client";

import { CARRIED_ASK_PAYMENT_WAIT_MAX_MS, CarriedAskPaymentWaitExpiredError } from "@/lib/additional-ask-recovery-replay";
import { bookingModificationTypeLabel } from "@/lib/booking-money-lines";
import logger from "@/lib/logger";
import {
  AdditionalAskAttributionConflictError,
  IntentLedgerRowOnAnotherPaymentError,
} from "@/lib/payment-intent-ledger-row-write";
import { prisma } from "@/lib/prisma";

/** How the carried-ask wait's cause opens; the alert's wording keys on it (`recoveryFailureAlertMessage`). */
const CARRIED_ASK_WAIT_EXPIRED_CAUSE_OPENING = "Stopped waiting on a card request Stripe is still taking money on.";

/**
 * The officers' alert for a recovery that ended for good (#4015 review L-3, the
 * one wording). Its attempt count reads oddly after a wait, which hands its
 * attempts back, so the carried-ask wait's ending says it stopped instead.
 */
export function recoveryFailureAlertMessage(
  operation: Pick<PaymentRecoveryOperation, "type" | "attempts">,
  message: string,
): string {
  if (message.startsWith(CARRIED_ASK_WAIT_EXPIRED_CAUSE_OPENING)) {
    return `Stripe payment recovery ${operation.type} stopped: ${message}`;
  }
  return `Stripe payment recovery ${operation.type} failed after ${operation.attempts} attempt${operation.attempts === 1 ? "" : "s"}: ${message}`;
}

/**
 * The officer-facing cause when `error` ends `operation` now, else null (retry
 * as usual). It names the booking change by the label the booking's history
 * shows; never throws, since the runner's failure path calls it.
 */
export async function unretryableRecoveryCause(
  operation: Pick<PaymentRecoveryOperation, "type">,
  error: unknown,
): Promise<string | null> {
  if (operation.type !== PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT) {
    return null;
  }
  if (error instanceof CarriedAskPaymentWaitExpiredError) {
    return `${CARRIED_ASK_WAIT_EXPIRED_CAUSE_OPENING} The booking's existing card request ${error.paymentIntentId} is still "${error.status}" at Stripe ${CARRIED_ASK_PAYMENT_WAIT_MAX_MS / 86_400_000} days after that payment began (or after this change's request was queued, if later), so the card request for this change was not raised: the app will not cancel a request Stripe may be taking money on. The money for this change is still owed: check card request ${error.paymentIntentId} in Stripe, record it if it was paid, and collect what is still owed for this change by hand.`;
  }
  if (error instanceof IntentLedgerRowOnAnotherPaymentError) {
    return `The card request ${error.paymentIntentId} for this booking could not be recorded: Stripe's record of it is already filed under a different payment. Retrying would be refused the same way, so the app stopped. The money for this change is still owed: check the card request in Stripe against the booking's payments and ask a developer to reconcile it.`;
  }
  if (!(error instanceof AdditionalAskAttributionConflictError)) {
    return null;
  }
  const change = await prisma.bookingModification
    .findUnique({ where: { id: error.bookingModificationId }, select: { modificationType: true } })
    .catch((err: unknown) => {
      logger.warn({ err, bookingModificationId: error.bookingModificationId }, "Could not read the booking change a stopped recovery names");
      return null;
    });
  const named = change?.modificationType ? `the "${bookingModificationTypeLabel(change.modificationType)}" change` : "a change";
  return `The card request for ${named} to this booking could not be recorded: Stripe returned card request ${error.paymentIntentId}, which is already recorded for another change to the same booking. Retrying would be refused the same way, so the app stopped. The money for this change is still owed: find it in the booking's history, check its card requests against Stripe, and collect what is missing by hand.`;
}
