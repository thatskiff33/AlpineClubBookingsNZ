/**
 * IS THIS CARD INTENT DEAD, OR HARMLESS TO LEAVE? — one home (#3638, `INV-SSOT`).
 *
 * Three questions every door that retires or replaces a booking's card intent
 * asks, and that used to be spelled inline at each of them:
 *
 * - `isPaymentIntentCancelConfirmed` — Stripe confirmed the intent can never
 *   charge: this call cancelled it, or it was already `canceled`. What the
 *   Internet Banking switch, booking cancellation, soft delete and the
 *   superseded-intent recovery act on before they write a row FAILED.
 * - `isRefundedPaymentIntentHistory` — #1765's discriminator: a `succeeded`
 *   intent that is refund history, not a live capture. What both card mint
 *   doors use to decide between reconciling and minting a repay intent.
 * - `isCardIntentRetired` — the two together: the switch may leave this intent
 *   beside an Internet Banking invoice, because it can never take money again.
 * - `retireCardIntentBeforeElection` — the act built on it: before a stored
 *   credit election is spent, the card intent minted at the pre-election price
 *   is made dead, or the election is left alone (#3638's switch, #3864's pay
 *   step).
 *
 * `processing` and `requires_capture` are not special-cased here: the cancel
 * helper (`cancelPaymentIntentIfCancellableWithResult`) cancels both, so they
 * arrive as a confirmed cancel or a thrown one, never as `canceled: false`.
 */
import { PaymentStatus } from "@prisma/client";
import type Stripe from "stripe";
import logger from "@/lib/logger";
import { findPaymentTransactionByIntentId } from "@/lib/payment-transactions";
import { cancelPaymentIntentIfCancellableWithResult } from "@/lib/stripe";

type CancelResult = {
  paymentIntent: Pick<Stripe.PaymentIntent, "id" | "status">;
  canceled: boolean;
};

/**
 * Stripe confirmed the intent is dead: this call cancelled it, or it was
 * already `canceled`. A failed cancel is not an answer — callers treat a throw
 * as unconfirmed.
 */
export function isPaymentIntentCancelConfirmed(result: CancelResult): boolean {
  return result.canceled || result.paymentIntent.status === "canceled";
}

/** A transaction carrying refund history (#1765). */
const REFUND_HISTORY_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.REFUNDED,
  PaymentStatus.PARTIALLY_REFUNDED,
]);

/**
 * #1765 — a refunded PaymentIntent keeps status `succeeded` forever (refunds
 * hang off the charge and never move the intent), so at the intent level a
 * deliberately refunded payment is indistinguishable from crashed-webhook
 * recovery. Discriminate on the local ledger: refund history lives on the
 * intent's PaymentTransaction row (REFUNDED/PARTIALLY_REFUNDED), which genuine
 * recovery — success never recorded locally — can never carry. The lookup
 * backfills pre-ledger payments; `paymentStatus`, the booking's aggregate
 * Payment status, is the fallback for a payment with no derivable row.
 *
 * Ask it only of an intent Stripe reports `succeeded`.
 */
export async function isRefundedPaymentIntentHistory({
  paymentIntentId,
  paymentStatus,
}: {
  paymentIntentId: string;
  paymentStatus: PaymentStatus;
}): Promise<boolean> {
  const pointedTransaction = await findPaymentTransactionByIntentId({
    paymentIntentId,
  });
  return REFUND_HISTORY_STATUSES.has(
    pointedTransaction ? pointedTransaction.status : paymentStatus,
  );
}

/**
 * The card intent can never take money again, so an Internet Banking invoice
 * may exist beside it: Stripe confirmed it cancelled, or it `succeeded` and
 * the local ledger shows it refunded (#1765's repay-after-refund booking). A
 * succeeded intent with no refund history is a live capture and is NOT
 * retired, whatever the local Payment row says.
 */
export async function isCardIntentRetired({
  result,
  paymentStatus,
}: {
  result: CancelResult;
  paymentStatus: PaymentStatus;
}): Promise<boolean> {
  if (isPaymentIntentCancelConfirmed(result)) return true;
  if (result.paymentIntent.status !== "succeeded") return false;
  return isRefundedPaymentIntentHistory({
    paymentIntentId: result.paymentIntent.id,
    paymentStatus,
  });
}

/**
 * A STORED CREDIT ELECTION IS SPENT ONLY ONCE THE CARD INTENT MINTED BEFORE IT
 * IS DEAD (#3638, #3864; `INV-PAY-024`, `INV-PAY-102`). Both doors that spend
 * an election — the switch to Internet Banking and the card pay step — call
 * this first,
 * outside any transaction, because that intent was minted at the pre-election
 * price: if it captures after the credit is spent, the member pays the whole
 * price by card AND loses the credit (#1641's double pay).
 *
 * `retired` when `isCardIntentRetired` says so (Stripe confirmed the cancel,
 * the intent was already cancelled, or it succeeded and the local ledger shows
 * it refunded): spend the election. `notCancellable` for a succeeded intent
 * with no refund history — a live capture, typically with the local record
 * lagging: do NOT spend it; the capture settles the booking, and the settle
 * door clears the election it cannot honour. `unconfirmed` when a call throws,
 * because a failed cancel proves nothing about whether the card can still be
 * charged: refuse and let the member retry.
 */
export async function retireCardIntentBeforeElection({
  paymentIntentId,
  paymentStatus,
  bookingId,
  door,
}: {
  paymentIntentId: string;
  paymentStatus: PaymentStatus;
  bookingId: string;
  /** Which spender is asking, for the log line. */
  door: "internet-banking-switch" | "card-pay-step";
}): Promise<"retired" | "notCancellable" | "unconfirmed"> {
  try {
    const result =
      await cancelPaymentIntentIfCancellableWithResult(paymentIntentId);
    if (await isCardIntentRetired({ result, paymentStatus })) {
      return "retired";
    }
    logger.warn(
      { bookingId, paymentIntentId, door, status: result.paymentIntent.status },
      "The card payment could not be cancelled, so the stored credit election was not spent (#3638, #3864)"
    );
    return "notCancellable";
  } catch (err) {
    logger.error(
      { err, bookingId, paymentIntentId, door },
      "Cancelling the card payment failed, so the stored credit election was not spent (#3638, #3864)"
    );
    return "unconfirmed";
  }
}
