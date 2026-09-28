/**
 * The refund method a cancellation is forced to, whatever the member chose —
 * the ONE home for that decision (#3643 follow-up, from #1491's review).
 *
 * A captured internet banking payment has no card charge to reverse, so its
 * cancellation refund is always held as account credit. The cancel path
 * applies this before it tiers the refund; the cancel preview returns it so
 * the dialog offers only what will happen. Pure, so both can import it.
 */
import { PaymentSource } from "@prisma/client";

export type ForcedCancelRefundMethod = "credit" | null;

export function forcedCancelRefundMethod(
  paymentSource: string | null | undefined,
): ForcedCancelRefundMethod {
  return paymentSource === PaymentSource.INTERNET_BANKING ? "credit" : null;
}
