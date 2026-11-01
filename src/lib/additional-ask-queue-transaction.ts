import type { Prisma } from "@prisma/client";

import { outstandingAdditionalAskCents, type AdditionalAsk } from "@/lib/additional-payment-ask";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";

/**
 * #4442: A NEW ADDITIONAL ASK NEVER CARRIES MONEY ALREADY PAID.
 *
 * A replacement ask carries the unpaid balance of the live ask it supersedes
 * (`INV-PAY-098`), sized from a read made before the Stripe mint. Its durable
 * cancel of that live ask is written only afterwards, in the queue transaction
 * below. A stale tab paying the live ask inside that window used to settle
 * normally - no cancel row named it yet - while the replacement still asked for
 * the same balance: the member paid it twice and nobody was told.
 *
 * So every minter of a carrying ask writes its row and its supersede's cancel
 * rows only after this module's two locks, and only once the balance it sized
 * is still the balance the `Payment` mirrors. The capture takes the same
 * `Payment` row (`markPaymentIntentTransactionSucceeded`), so a capture that
 * committed first is seen here and refused, and one that lands later is owned
 * by the cancel row this queue commits: the webhook or the cancel's runner
 * hands it to the superseded-capture refund (`INV-PAY-140`).
 */

/**
 * The budget every carrying-ask queue transaction runs on (#4442 review C-F1).
 * It waits on the global key, whose longest ordinary holder runs on this same
 * budget (`assignBedRange`); queued behind it, Prisma's 5s default would fail a
 * mint whose intent Stripe already holds. The copy `additional-payment-withdraw.ts`
 * made for the same reason.
 */
export const ADDITIONAL_ASK_QUEUE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * The carrying-ask queue's locks, in `INV-LOCK-002`'s order: the global key
 * (capture and settlement money, `INV-LOCK-001`), then the `Payment` row
 * (#4217) - always before any recovery-row claim the caller then makes. The
 * one place the order is spelled, for the inline mint, the re-issue's
 * completion and the recovery runner's claim hold.
 */
export async function lockAdditionalAskQueue(store: Prisma.TransactionClient, paymentId: string): Promise<void> {
  await store.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  await lockPaymentForRefundedTotal(store, paymentId);
}

/**
 * #4442: the queue's refusal, typed so a door can answer it (the pay page's
 * 409, reload) rather than fail. Nothing was written when it is thrown.
 */
export class CarriedAskChangedError extends Error {
  readonly code = "CARRIED_ASK_CHANGED" as const;

  constructor(paymentId: string) {
    super(`The carried additional ask on payment ${paymentId} changed while its replacement was being minted; retry and re-plan`);
    this.name = "CarriedAskChangedError";
  }
}

/**
 * Refuse the queue when the carried balance moved since sizing. Called under
 * `lockAdditionalAskQueue`, before the new ask's row is written. The balance is
 * re-read through `outstandingAdditionalAskCents`, the one rule the sizing used
 * (`INV-SSOT-001`). Any change refuses - a capture would be asked for twice, and
 * a new ask minted meanwhile would be superseded without being carried - and
 * rolls the whole queue back: the minted intent was never offered, and the
 * durable recovery re-plans from the `Payment` as it then stands. Folded
 * waiting re-issues are not part of this live balance and stay owed. An ask
 * that carries no live ask (`paymentBalanceCents` null) has nothing to check.
 * The recovery runner's frozen replay, which is no `AdditionalAsk`, passes the
 * balance its own pre-mint read saw.
 */
export async function assertAdditionalAskSizingCurrent(
  store: Prisma.TransactionClient,
  paymentId: string,
  ask: Pick<AdditionalAsk, "paymentBalanceCents">,
): Promise<void> {
  if (ask.paymentBalanceCents === null) return;
  const payment = await store.payment.findUnique({
    where: { id: paymentId },
    select: { additionalAmountCents: true, additionalPaymentStatus: true },
  });
  if (!payment) throw new Error(`Payment ${paymentId} not found while checking the carried ask`);
  if (outstandingAdditionalAskCents(payment) !== ask.paymentBalanceCents) {
    throw new CarriedAskChangedError(paymentId);
  }
}

/** The inline minters' queue boundary; no provider call belongs in `write`. */
export async function withAdditionalAskQueueTransaction<T>(
  paymentId: string,
  ask: AdditionalAsk,
  write: (store: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (store) => {
    await lockAdditionalAskQueue(store, paymentId);
    await assertAdditionalAskSizingCurrent(store, paymentId, ask);
    return write(store);
  }, ADDITIONAL_ASK_QUEUE_TRANSACTION_OPTIONS);
}
