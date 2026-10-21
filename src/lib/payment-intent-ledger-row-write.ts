/**
 * THE ONE WRITE OF A STRIPE INTENT'S LEDGER ROW (`upsertPaymentIntentTransaction`).
 *
 * #4036 review: AN EDIT'S ASK ROW IS NEVER WRITTEN OVER ANOTHER EDIT'S. A write
 * that names its `bookingModificationId` - the door's ordinary and re-issue
 * writes, the recovery runner's, and the currency re-issue's - lands only on a
 * row naming that edit or none, so one Stripe intent is never recorded as two
 * edits' asks, whatever handed the writer that intent: a runner's adoption by
 * what the ask asks for, or Stripe answering a replayed key. The rule is
 * `INV-MOD-060`.
 *
 * #4217: AN INTENT'S ROW NEVER MOVES PAYMENT. Every write is pinned to the
 * payment whose row the writer locked (`lockPaymentForRefundedTotal`); a row
 * the intent already has on another payment is refused, never re-pointed under
 * one payment's lock while the other's rebuild reads it.
 *
 * #4081: NO WRITE LOWERS A CAPTURED ROW'S STATUS. A webhook may have marked the
 * row captured (`CAPTURED_TRANSACTION_STATUS_LIST`) before a door's, a runner's
 * or a card attach's PENDING or PROCESSING write lands, and a refund may have
 * moved it on from SUCCEEDED before a late SUCCEEDED write; each such write
 * keeps the row's status and writes the rest. The refund writers own a captured
 * row's moves.
 */
import type { Prisma } from "@prisma/client";

import type { PaymentStore } from "@/lib/payment-transactions";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";

/**
 * Thrown by an ask write that finds the intent's row already naming a
 * different edit. The door keeps the debt on its recovery row; the recovery
 * runner stops at once and alerts an officer, since its retry would meet the
 * same row (#4081, `unretryableRecoveryCause`).
 */
export class AdditionalAskAttributionConflictError extends Error {
  constructor(readonly paymentIntentId: string, readonly bookingModificationId: string) {
    super(
      `PaymentIntent ${paymentIntentId} is already recorded for another edit's ask; not writing it as ${bookingModificationId}'s (#4036)`,
    );
    this.name = "AdditionalAskAttributionConflictError";
  }
}

/**
 * #4217: the intent's ledger row belongs to a different payment from the one a
 * writer locked. Refused before anything is written: writing it would move or
 * touch one payment's row under another payment's lock. Never expected; loud,
 * and retried like any other failure.
 */
export class IntentLedgerRowOnAnotherPaymentError extends Error {
  constructor(readonly paymentIntentId: string, readonly lockedPaymentId: string, readonly rowPaymentId: string) {
    super(
      `PaymentIntent ${paymentIntentId}'s ledger row belongs to payment ${rowPaymentId}, not the locked payment ${lockedPaymentId}; not writing it (#4217)`,
    );
    this.name = "IntentLedgerRowOnAnotherPaymentError";
  }
}

/**
 * Update the intent's row where the write may land (any row, or for an edit's
 * write one naming that edit or none); else insert it; else update once more;
 * else refuse. Each step is one statement, so under READ COMMITTED a concurrent
 * writer cannot slip between a check and the write: a guarded `updateMany`
 * re-evaluates its WHERE on the row it locks, and `createMany` with
 * `skipDuplicates` (`ON CONFLICT DO NOTHING`) waits for a concurrent insert of
 * the same intent rather than aborting the caller's transaction (a caught
 * `P2002` would), after which the update is tried once more against the row
 * that won. The update is two such statements, split on the row's status: one
 * writes `update` to a row not captured, the other writes all of it but
 * `status` to a captured one. A capture committing while the first waits on the
 * row's lock fails the first's re-checked WHERE and lands in the second. A row
 * naming no edit (a webhook's, say) is still claimed by an edit's write.
 */
export async function writePaymentIntentTransaction(
  store: PaymentStore,
  {
    paymentId,
    paymentIntentId,
    bookingModificationId,
    create,
    update,
  }: {
    /** #4217: the payment whose row the writer locked; the write lands on that payment's row or none. */
    paymentId: string;
    paymentIntentId: string;
    /** Given, the write is that edit's ask (`INV-MOD-060`); omitted, any row is the intent's. */
    bookingModificationId: string | undefined;
    create: Prisma.PaymentTransactionUncheckedCreateInput;
    update: Prisma.PaymentTransactionUncheckedUpdateManyInput;
  },
): Promise<void> {
  const ours: Prisma.PaymentTransactionWhereInput = {
    stripePaymentIntentId: paymentIntentId,
    paymentId,
    ...(bookingModificationId !== undefined ? { OR: [{ bookingModificationId: null }, { bookingModificationId }] } : {}),
  };
  // `undefined` is Prisma's "leave as is": a captured row keeps its status.
  const keepingStatus = { ...update, status: undefined };
  const captured = [...CAPTURED_TRANSACTION_STATUS_LIST];
  const updateOurs = async () =>
    (await store.paymentTransaction.updateMany({ where: { ...ours, status: { notIn: captured } }, data: update })).count === 1 ||
    (await store.paymentTransaction.updateMany({ where: { ...ours, status: { in: captured } }, data: keepingStatus })).count === 1;
  if (await updateOurs()) return;
  if ((await store.paymentTransaction.createMany({ data: [create], skipDuplicates: true })).count === 1) return;
  if (await updateOurs()) return;
  // Refused only when the row is there and names another edit: a refusal ends
  // the recovery at once (#4081), so a row merely gone is the retryable error.
  const row = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { paymentId: true, bookingModificationId: true },
  });
  if (row && row.paymentId !== paymentId) {
    throw new IntentLedgerRowOnAnotherPaymentError(paymentIntentId, paymentId, row.paymentId);
  }
  if (bookingModificationId !== undefined && row?.bookingModificationId != null && row.bookingModificationId !== bookingModificationId) {
    throw new AdditionalAskAttributionConflictError(paymentIntentId, bookingModificationId);
  }
  throw new IntentLedgerRowVanishedError(paymentIntentId);
}

/**
 * The intent's row was deleted between the insert's conflict and the update
 * that followed it. Nothing was refused, so the caller retries as for any
 * other failure.
 */
export class IntentLedgerRowVanishedError extends Error {
  constructor(readonly paymentIntentId: string) {
    super(`PaymentIntent ${paymentIntentId}'s ledger row could not be written: it vanished mid-write (#4081)`);
    this.name = "IntentLedgerRowVanishedError";
  }
}
