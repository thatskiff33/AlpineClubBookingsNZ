/**
 * #4081: A RECOVERY FAILURE A RETRY CANNOT FIX STOPS THE RECOVERY AT ONCE.
 *
 * The recovery runner retries a failed attempt on a backoff (5, 15, 60 and 240
 * minutes between five attempts, about 5h20m) and alerts an officer only when
 * the attempts run out. That suits a provider outage, which passes. It does not suit a refusal
 * the next attempt will meet again, which only burns the backoff before anyone
 * hears of it.
 *
 * Two such refusals today. The first: an edit's ask write that finds its intent already
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
 * So the runner's failure path (`failPaymentRecoveryOperation`) ends the
 * recovery on the first such failure, through the one terminal transition
 * (`markPaymentRecoveryOperationFailed`, `INV-PAY-056`): FAILED with no retry,
 * at the attempt ceiling, the cause below on `lastError` and in the officers'
 * alert. The debt stays on the row, and the stuck-state page lists it with the
 * exhausted recoveries.
 */
import { PaymentRecoveryOperationType, type PaymentRecoveryOperation } from "@prisma/client";

import { bookingModificationTypeLabel } from "@/lib/booking-money-lines";
import logger from "@/lib/logger";
import {
  AdditionalAskAttributionConflictError,
  IntentLedgerRowOnAnotherPaymentError,
} from "@/lib/payment-intent-ledger-row-write";
import { prisma } from "@/lib/prisma";

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
