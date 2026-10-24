/**
 * ONE PAYMENT'S SUPERSEDED-MACHINERY READING (#4300, `INV-SSOT`): the
 * duplicate-capture guard's and the settle's, from the same rows.
 *
 * `superseded-intent-ownership.ts` holds the readings themselves; this module
 * composes them over the payment's held PRIMARY Stripe captures, and is its own
 * module so a suite can stand in for `readSupersededCaptureHolds` (an import
 * across modules) while this composition stays real.
 */
import {
  PaymentSource,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { staleIntentAction } from "@/lib/stale-intent-action";
import {
  findLiveSupersededIntentOperation,
  readSupersededCaptureHolds,
  type OwnershipReader,
} from "@/lib/superseded-intent-ownership";

/**
 * The payment's held PRIMARY Stripe captures - the captures both this reading
 * and the duplicate-capture guard's telling reading (`readOtherSettledCaptureWhere`)
 * run over, so the two never read different populations.
 */
export function heldStripeCapturesWhere(paymentId: string): Prisma.PaymentTransactionWhereInput {
  return {
    paymentId,
    kind: PaymentTransactionKind.PRIMARY,
    source: PaymentSource.STRIPE,
    status: { in: [...CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST] },
  };
}

/** What `readSupersededOwnership` reads besides the rows: the payment's held Stripe captures. */
type PaymentOwnershipReader = OwnershipReader & Pick<Prisma.TransactionClient, "paymentTransaction">;

/** One payment's superseded-machinery reading, read once (#4300, `INV-SSOT`). */
export type SupersededOwnership = {
  /**
   * The Xero conflict's reading over the payment's held PRIMARY Stripe
   * captures (`listSupersededIntentIdsOwningCaptures`): the duplicate-capture
   * guard's test of the ARRIVING capture (#4283).
   */
  holdsForMember: ReadonlySet<string>;
  /**
   * Is this intent's capture the superseded machinery's? `holdsForMember`, or
   * (c′) a superseded-intent row on the intent not SUCCEEDED
   * (`findLiveSupersededIntentOperation`): the guard's test of a settlement
   * (#4227). With `anyOwedBack` (#4300, `INV-PAY-138`: a settle or a card door
   * deciding whether it may settle a booking with the capture), also a capture
   * open rows owe back ANY part of: a booking is never settled with money that
   * is partly going back.
   */
  owns(paymentIntentId: string, options?: { anyOwedBack?: boolean }): Promise<boolean>;
  /**
   * #4300: where the money of a capture it owns stands, for a saved-card charge
   * deciding whether it may charge beside it. `in_flight`: a superseded refund
   * the runner will still run, or running rows owing it back in full - the
   * charge goes ahead. `stopped`: that refund (or those rows) will never run
   * again - a person must act. `not_started`: only a cancel row names it.
   * Fails safe: anything not provably on its way back is not `in_flight`.
   */
  refundState(paymentIntentId: string): "in_flight" | "stopped" | "not_started";
};

/**
 * Read one payment's superseded-machinery ownership (#4300): the guard's
 * readings and the settle's, from the same rows. Read under lock(1) where the
 * caller decides money; `paymentId` null (an intent with no ledger row) reads
 * (c′) alone.
 */
export async function readSupersededOwnership(
  tx: PaymentOwnershipReader,
  paymentId: string | null,
): Promise<SupersededOwnership> {
  const { holdsForMember, owedBackAtAll, refundInFlight, refundStopped } = paymentId
    ? await readSupersededCaptureHolds(
        tx,
        paymentId,
        await tx.paymentTransaction.findMany({
          orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
          where: heldStripeCapturesWhere(paymentId),
          select: { stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
        }),
      )
    : { holdsForMember: new Set<string>(), owedBackAtAll: new Set<string>(), refundInFlight: new Set<string>(), refundStopped: new Set<string>() };
  return {
    holdsForMember,
    refundState: (paymentIntentId) =>
      refundInFlight.has(paymentIntentId) ? "in_flight" : refundStopped.has(paymentIntentId) ? "stopped" : "not_started",
    owns: async (paymentIntentId, options) =>
      holdsForMember.has(paymentIntentId) ||
      (options?.anyOwedBack === true && owedBackAtAll.has(paymentIntentId)) ||
      (await findLiveSupersededIntentOperation(tx, paymentIntentId)) !== null,
  };
}

/**
 * #4300 (`INV-PAY-138`): may a booking be settled with this capture? Not while
 * the superseded machinery owns it, reading anything owed back as owned
 * (`SupersededOwnership.owns` with `anyOwedBack`). The settle asks it under
 * lock(1); the card doors and the webhook ask it before they settle.
 */
export async function supersededMachineryOwnsCapture(
  tx: PaymentOwnershipReader,
  input: { paymentId: string | null; paymentIntentId: string },
): Promise<boolean> {
  return (await readSupersededOwnership(tx, input.paymentId)).owns(input.paymentIntentId, { anyOwedBack: true });
}

/**
 * #4300 (`INV-PAY-138`): may a reuse arm hand this unpaid intent's secret out
 * again? Not while a superseded-intent row not SUCCEEDED names it, even once
 * the price is back at its amount: its cancel row will kill it, or refund what
 * it takes. `null`: reuse as before. `"mint"`: mint a fresh one beside it.
 * `"wait"`: it is being paid now (`processing`), so answer
 * `SUPERSEDED_PAYMENT_PROCESSING_BODY` and mint nothing. The one predicate
 * both reuse arms (the pay step and the `/pay` link) ask.
 */
export async function supersededIntentReuseRefusal(
  tx: Pick<Prisma.TransactionClient, "paymentRecoveryOperation">,
  intent: { id: string; status: string },
): Promise<"mint" | "wait" | null> {
  if (intent.status === "canceled" || intent.status === "succeeded") return null;
  if ((await findLiveSupersededIntentOperation(tx, intent.id)) === null) return null;
  return staleIntentAction(intent) === "in_flight" ? "wait" : "mint";
}
