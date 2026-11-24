/**
 * #4911, #5061 and #5197 (`INV-PAY-154`): the `AlertCooldown` keys a Stripe dispute's alerts and its late win write.
 * A leaf, so the dispute writer (`stripe-dispute.ts`) and the hand-back reopen it calls
 * (`manual-refund-task-reopen.ts`) name each key alike without importing each other.
 */
import type { StripeDisputeAlertStage } from "@/lib/stripe-dispute-note";

/** The once-ever claim of one dispute's alert at one stage. */
export function stripeDisputeAlertKey(disputeId: string, stage: StripeDisputeAlertStage): string {
  return `stripe-dispute-${stage}:${disputeId}`;
}

/** #5061 follow-up: the durable marker that a lost dispute's won-after-loss alert is owed. */
export function stripeDisputeWonAfterLossOwedKey(disputeId: string): string {
  return `stripe-dispute-won-after-loss-owed:${disputeId}`;
}

/** #5197: one hand-back task reopened by one dispute's late win, written with the reopen's claim. */
export function stripeDisputeLateWinReopenKey(disputeId: string, taskId: string): string {
  return `stripe-dispute-late-win-reopen:${disputeId}:${taskId}`;
}
