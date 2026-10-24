/**
 * WHICH PAYMENT TRANSACTION SETTLED A BOOKING (#4211, owner decision 17 Oct
 * 2026, "Record the settler"; `INV-PAY-043`).
 *
 * `Payment.settledByTransactionId` names the row whose settlement moved the
 * booking to PAID. Written only inside a settle's PAID claim, under the lock(1)
 * that claim holds, so only the winning settlement writes it; cleared by the
 * manual mark-paid reversal, which re-opens the payment. The duplicate-capture
 * guard (`duplicate-capture-guard.ts`) never refunds it and the Xero
 * second-instrument conflict names it (`INV-PAY-102`).
 *
 * Writers: the card / manual settle (`markBookingPaymentSucceeded`,
 * `markBookingPaymentManuallySettled`) and the Xero inbound bank-receipt settle
 * (`invoice-paid-effects.ts`). Paths that claim PAID with no transaction of
 * this payment leave it NULL: zero-cash confirmations and an organiser's group
 * settlement, whose children carry no capture of their own.
 */
import {
  PaymentSource,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";

type PaymentWriter = Pick<Prisma.TransactionClient, "payment">;

/**
 * The clear, for a writer that re-opens the payment inside a fenced
 * `updateMany` of its own (the manual mark-paid reversal) and must keep that one
 * statement. Every write of the column is here or in `recordSettlingTransaction`
 * below; `payment-settler-writer-census.test.ts` fails any other.
 */
export const CLEAR_SETTLING_TRANSACTION = { settledByTransactionId: null } as const satisfies Prisma.PaymentUpdateManyMutationInput;

/** Record (or, with null, clear) the settling transaction. Inside the PAID claim's transaction only. */
export async function recordSettlingTransaction(
  store: PaymentWriter,
  { paymentId, transactionId }: { paymentId: string; transactionId: string | null },
) {
  await store.payment.update({
    where: { id: paymentId },
    data: { settledByTransactionId: transactionId },
  });
}

/**
 * The cash or bank receipt's PRIMARY row that settles a payment: the one
 * captured Internet Banking PRIMARY row holding money. Null when there is not
 * exactly one, so an ambiguous ledger is recorded as unknown, never guessed.
 */
export async function findSettlingInternetBankingTransactionId(
  store: Pick<Prisma.TransactionClient, "paymentTransaction">,
  paymentId: string,
): Promise<string | null> {
  const rows = await store.paymentTransaction.findMany({
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    where: {
      paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.INTERNET_BANKING,
      status: { in: [...CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST] },
    },
    select: { id: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0]!.id : null;
}
