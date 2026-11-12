/**
 * #4442 (`INV-PAY-098`, `INV-ADDPAY-023`): A NEW ASK NEVER ASKS FOR MONEY
 * ALREADY PAID.
 *
 * A later request B that supersedes an unpaid ask A carries A's balance, and
 * B's supersede queues A's cancellation. B is sized from a read made before
 * its minter's transaction (`AdditionalAsk.carriedFromIntentId` names the ask
 * that read carried). A stale tab paying A after that read but before the
 * transaction commits A's cancel row was settled as an ordinary payment - the
 * webhook found no cancel row - while B, written next, still asked for A's
 * balance: the member paid it twice, and nothing refunded it or told anyone.
 *
 * So the minter re-reads A inside the transaction that writes B's row and A's
 * cancel row, under the `Payment` row lock. That lock is the one an ask's
 * capture takes to write its SUCCEEDED (`markPaymentIntentTransactionSucceeded`,
 * #4217), so the re-read decides the race: a capture committed first is seen
 * here and B is refused; a capture committing after waits for B's commit, and
 * then A has a cancel row, so its capture takes the superseded-capture path and
 * is refunded.
 *
 * REFUSED, NOT RE-SIZED. B's intent already exists at Stripe for the stale
 * figure, and changing it is a provider call this transaction may not make.
 * The refusal throws, so nothing of B is written and its secret is never
 * offered; each minter's existing failure path re-plans from the ledger as it
 * stands (the recovery replay re-sizes through `sizeRecoveryReplayAsk`, where
 * A now reads as collected).
 */
import type { Prisma } from "@prisma/client";

import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";

/** The ask a new request carried was captured before its supersede committed (#4442). */
export class CarriedAskCapturedError extends Error {
  readonly paymentIntentId: string;

  constructor(paymentIntentId: string) {
    super(
      `The unpaid request this new request carries (${paymentIntentId}) was paid while the new one was being raised; ` +
        "nothing was written, and the request is raised again from what is still owed (#4442)",
    );
    this.name = "CarriedAskCapturedError";
    this.paymentIntentId = paymentIntentId;
  }
}

/**
 * Throw `CarriedAskCapturedError` when the live ask a new request carried has
 * been captured. Run in the minter's transaction, before it commits; takes the
 * `Payment` row (a no-op where the transaction already holds it).
 */
export async function refuseIfCarriedAskCaptured(
  tx: Prisma.TransactionClient,
  { paymentId, carriedFromIntentId }: { paymentId: string; carriedFromIntentId: string | null },
): Promise<void> {
  if (!carriedFromIntentId) return;
  await lockPaymentForRefundedTotal(tx, paymentId);
  const carried = await tx.paymentTransaction.findFirst({
    where: { paymentId, stripePaymentIntentId: carriedFromIntentId },
    select: { status: true },
  });
  if (carried && isCapturedTransactionStatus(carried.status)) {
    throw new CarriedAskCapturedError(carriedFromIntentId);
  }
}
