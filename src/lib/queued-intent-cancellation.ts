/**
 * #4052 (`INV-SSOT`): "a Stripe cancellation was queued for this intent" - a
 * `CANCEL_PAYMENT_INTENT` recovery naming it, WHATEVER ITS STATUS NOW. Every
 * writer that retires an intent queues one (a supersede, a booking's end, a
 * reduction, the cancel claim), so its presence alone says the intent was
 * meant to die. Read by the late-capture verdict (`late-capture-landed-after.ts`)
 * and the just-minted ask's liveness re-read (`isMintedAskStillLive`).
 *
 * Not this rule, deliberately, and so not using it: readers that ask whether a
 * cancellation is still IN FLIGHT or still OWNS the money - status not
 * SUCCEEDED (`liveSupersededOperation`, `completeCanceledSupersededPaymentIntentRecovery`,
 * `queueSupersededPaymentIntentRefundRecovery`), in flight only
 * (`superseded-intent-ownership.ts`), already SUCCEEDED
 * (`SUPERSEDABLE_ADDITIONAL_ASK_STATUS_WHERE`) or exhausted
 * (`rearmDeadIntentCancellations`). Each needs its status test.
 */
import { PaymentRecoveryOperationType, type Prisma } from "@prisma/client";

export function intentCancellationQueuedWhere(paymentIntentIds: readonly string[]): Prisma.PaymentRecoveryOperationWhereInput {
  return {
    type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
    paymentIntentId: paymentIntentIds.length === 1 ? paymentIntentIds[0] : { in: [...paymentIntentIds] },
  };
}
