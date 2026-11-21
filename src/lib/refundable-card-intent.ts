/**
 * #5212 (`INV-PAY-160`): THE read of whether Stripe holds a record a card
 * refund can be owed against. Its own module so an edit's settlement can ask
 * before it promises a refund to the card without importing the recovery
 * queue, and so the queue's writer (`enqueueLedgerRefundRecovery`) answers
 * from the same read rather than a copy of it (`INV-SSOT`).
 */
import { PaymentSource, type Prisma } from "@prisma/client";
import { LEDGER_ROWS_NEWEST_FIRST } from "@/lib/payment-ledger-order";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";

type RefundableCardIntentReader = Pick<Prisma.TransactionClient, "payment">;

/**
 * The Stripe intent a card refund on this payment is owed against: its newest
 * captured Stripe charge's, else the payment's own. Null when Stripe holds no
 * record of the payment, so no card refund can be owed on it.
 */
export async function readRefundableCardIntentId(
  store: RefundableCardIntentReader,
  paymentId: string,
): Promise<string | null> {
  const payment = await store.payment.findUnique({
    where: { id: paymentId },
    include: {
      transactions: {
        orderBy: [...LEDGER_ROWS_NEWEST_FIRST],
      },
    },
  });

  const capturedTransaction = payment?.transactions.find(
    (transaction) =>
      transaction.source === PaymentSource.STRIPE &&
      Boolean(transaction.stripePaymentIntentId) &&
      isCapturedTransactionStatus(transaction.status),
  );
  return capturedTransaction?.stripePaymentIntentId ?? payment?.stripePaymentIntentId ?? null;
}

/**
 * Can a card refund debt be written on this payment at all? The question an
 * edit asks under its locks before it promises a refund to the card; the
 * debt's writer refuses on the same read (`NoRefundPaymentIntentError`), so
 * the two cannot disagree about a payment neither has changed. A payment row
 * in hand that names its own intent is already the answer, as it is the
 * read's last resort, so only a payment without one costs a query.
 */
export async function paymentHasRefundableCardIntent(
  store: RefundableCardIntentReader,
  payment: { id: string; stripePaymentIntentId: string | null },
): Promise<boolean> {
  if (payment.stripePaymentIntentId) return true;
  return (await readRefundableCardIntentId(store, payment.id)) !== null;
}
