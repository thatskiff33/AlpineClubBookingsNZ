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

export type ForcedCancelRefundMethod = "credit" | "organiser_card" | null;

/**
 * #3653: `paidByOrganiserCard` is the joiner's booking the group organiser paid
 * for by card (`group-organiser-paid.ts`). Its refund goes back to the
 * ORGANISER's card, so there is no account-credit choice to offer the joiner.
 */
export function forcedCancelRefundMethod(
  paymentSource: string | null | undefined,
  paidByOrganiserCard = false,
): ForcedCancelRefundMethod {
  if (paidByOrganiserCard) return "organiser_card";
  return paymentSource === PaymentSource.INTERNET_BANKING ? "credit" : null;
}
