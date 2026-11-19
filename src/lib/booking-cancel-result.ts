// What a booking cancellation answers, moved verbatim from `booking-cancel.ts`
// so that file shrinks below its length on main (#4926: past the hard ceiling a
// file may only stay or shrink). Type only.
import type { OrganiserRefundMethod, OwnCardRefundMethod } from "@/lib/booking-modified-email-copy";

export interface CancelBookingResult {
  success: boolean;
  refundAmountCents: number;
  refundPercentage: number;
  // B5 (#2262): "manual" — the booking was settled in cash / by an off-Xero
  // bank transfer, so no card refund was planned and no account credit was
  // minted; a durable hand-back task was raised instead and its id is returned.
  refundMethod: "card" | "credit" | "manual";
  creditAmountCents?: number;
  creditRestoredCents?: number;
  stripeRefundId?: string;
  manualRefundTaskId?: string;
  /** #4911 (`INV-PAY-154`): a "manual" refund handed to the treasurer because the card payment is disputed. */
  refundDisputed?: true;
  /** #3973: a refund that is the group organiser's (`refundMethod` stays "card"), as its email words it, for the confirmation screen. */
  organiserRefund?: { method: OrganiserRefundMethod; amountCents: number };
  /** #4084: a refund to the member's own card, made or not yet (`refundMethod` stays "card"), for the confirmation screen.
   * #4097: `amountCents` is what the card refund carries; of the rest, `byHandCents` the club refunds by bank transfer and `toCheckCents` it checks first. */
  ownCardRefund?: { method: OwnCardRefundMethod; amountCents: number; byHandCents?: number; toCheckCents?: number };
  message: string;
}
