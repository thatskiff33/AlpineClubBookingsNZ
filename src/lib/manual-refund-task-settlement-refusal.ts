import "server-only";

import { SchoolHasNoCreditAccountError } from "@/lib/member-credit";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { RefundAllocationRacedError } from "@/lib/payment-transactions";
import {
  needsOperatorXeroRetry,
  XeroAppliedCreditOperationBusyError,
} from "@/lib/xero-applied-credit-operation-serialization";

/**
 * A settlement write's refusal, as the operator should read it - or the error
 * itself where it is not one. Shared by the writes before the re-price and the
 * account-credit write after it, so the two cannot answer the same refusal
 * differently.
 */
export function settlementWriteRefusal(error: unknown): unknown {
  // #3030: the settlement cap is now OPERATOR-REACHABLE. Before this the amount
  // always came from cancellation or capture policy and could not exceed what
  // was captured; now an admin types it. The cap itself is not weakened by a
  // byte here - the allocation still refuses and the transaction still rolls
  // back - but a correct refusal must not be reported as a server fault: an
  // untyped Error falls past the route's `instanceof ManualBookingPaymentError`
  // check, so the operator was told "Could not close the refund task" and
  // monitoring recorded a 500 for working code. This says what is wrong and
  // what to do about it.
  // The message `RefundAllocationExceedsCapturedError` carries (#3924 round 4),
  // matched by its words so a caller's mocked module needs no new export.
  if (error instanceof Error && error.message === "Refund amount exceeds captured payments") {
    return new ManualBookingPaymentError("That is more than was ever captured on this payment — check the amount against the booking's payment history.", 400);
  }
  // #3032: a lock-free writer on the same payment (the charge.refunded sync; a
  // legacy kind's completion takes no key at all) can still move the ledger
  // under this completion - an edit review's `lock(1)` (#3582) excludes only
  // edits and settles. The compare-and-set inside `applyLocalRefundAllocation`
  // retries against the fresh total (#3640) and refuses loudly only when that
  // writer used the headroom this completion needed; the transaction rolls
  // back, so the task is still OPEN and its money is still owed when the
  // operator retries.
  if (error instanceof RefundAllocationRacedError) {
    return new ManualBookingPaymentError("This booking's payment changed while you were closing the task — refresh and try again.", 409);
  }
  // #3369: the same masking again. A school's reduction settled as account
  // credit is a CORRECT refusal that reported a 500, on the screen that had just
  // offered the choice; its message has to arrive.
  if (error instanceof SchoolHasNoCreditAccountError) {
    return new ManualBookingPaymentError(error.message, error.status);
  }
  // #3791: a give-back of applied credit waits for a Xero deallocation on the
  // payment, as the clamp does; the task stays OPEN. One that FAILED waits for a
  // person, so the officer is told who has to act rather than to wait.
  if (error instanceof XeroAppliedCreditOperationBusyError) {
    return new ManualBookingPaymentError(
      needsOperatorXeroRetry(error)
        ? "This booking's account credit is held by a Xero update that failed. An operator has to retry that Xero operation (Xero sync failures) before this review can be completed."
        : "This booking's account credit is still being updated in Xero — try again in a few minutes.",
      409,
    );
  }
  return error;
}
