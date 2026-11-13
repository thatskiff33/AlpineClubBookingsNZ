/**
 * #4911 (`INV-PAY-151`): what the treasurer does about a Stripe dispute, per
 * stage and outcome - one copy shared by the hand-built HTML
 * (`email-templates/admin-stripe-dispute.ts`), the `{{disputeNextStep}}` token
 * an admin's saved body renders, and the registry's preview sample. A leaf
 * module: the registry imports it without loading the email layout.
 */
import type { StripeDisputeStatus } from "@prisma/client";

/** How a dispute's status reads in the alert and on the admin payments list. */
export const STRIPE_DISPUTE_STATUS_LABEL: Record<StripeDisputeStatus, string> = {
  OPEN: "open",
  WON: "won",
  LOST: "lost",
  CLOSED_OTHER: "closed with no funds taken",
};

/**
 * The statuses that hold a capture's refunds and credits: open, or lost to the
 * cardholder. The one rule the hold's query (`stripe-dispute-hold.ts`) and every
 * dispute marker read; kept here, a leaf, so client components can import it.
 */
export const HOLDING_DISPUTE_STATUSES: readonly StripeDisputeStatus[] = ["OPEN", "LOST"];

/** Whether a dispute in this status holds its capture's refunds and credits. */
export function disputeHoldsCapture(status: StripeDisputeStatus): boolean {
  return HOLDING_DISPUTE_STATUSES.includes(status);
}

/** What the app does while a dispute holds the capture: the one sentence both alerts carry. */
export const STRIPE_DISPUTE_HOLD_NOTE =
  "While the dispute is open or lost, the app issues no card refund and no account credit for this payment: a cancellation, or an edit that lowers the price, is recorded and handed to the treasurer instead. " +
  "The app posts nothing to Xero for the dispute.";

/** The next step, by what the alert reports. */
export const STRIPE_DISPUTE_NEXT_STEP: Record<StripeDisputeStatus, string> = {
  OPEN:
    "The cardholder's bank has disputed this payment. Respond in Stripe with evidence before Stripe's deadline (the Disputes page shows it); if nobody responds, the dispute is lost. " +
    "Stripe has usually taken the amount and a dispute fee from the club's balance already.",
  WON:
    "The dispute was decided for the club and Stripe returned the disputed amount. Refunds and credits for this payment follow the normal rules again. " +
    "If you recorded the withdrawal in Xero by hand, record its reversal the same way.",
  LOST:
    "The dispute was decided for the cardholder: the money is not coming back and the cardholder already has it. Do not refund or credit this payment. " +
    "Record the loss and Stripe's dispute fee in Xero by hand against the Stripe clearing account, as the deployment guide's lost-dispute procedure describes.",
  CLOSED_OTHER:
    "Stripe closed this dispute without taking funds (an inquiry or a prevented dispute). Refunds and credits for this payment follow the normal rules again.",
};

/**
 * Which of a dispute's alerts this is: when it opens, when it closes, and the
 * one more a dispute already closed as lost owes when a newer event reports it
 * won (#5061 follow-up).
 */
export type StripeDisputeAlertStage = "opened" | "closed" | "won-after-loss";

/**
 * The next step of the won-after-loss alert: the lost alert told the treasurer
 * to record the loss in Xero, so this one says to reverse it, and that a
 * hand-back raised while the dispute held is still theirs to settle.
 */
export const STRIPE_DISPUTE_WON_AFTER_LOSS_NEXT_STEP =
  "This dispute was reported lost, and Stripe now reports it won: the disputed amount has come back to the club's balance. " +
  "If you recorded the loss and dispute fee in Xero, reverse that entry the same way, as the deployment guide's lost-dispute procedure describes. " +
  "Any hand-back task the app raised for this payment while the dispute held stays open: settle or dismiss it as usual.";

/**
 * The subject phrase (`{{disputeSubjectLabel}}`): which of the dispute's
 * alerts this is, and once closed, how it ended. One template carries them all,
 * so a subject typed in by hand would title a closed dispute as a new one.
 */
export function stripeDisputeSubjectLabel(stage: StripeDisputeAlertStage, outcome: string): string {
  if (stage === "opened") return "Card payment disputed by the cardholder - respond in Stripe";
  if (stage === "won-after-loss") return "Lost card payment dispute now won - reverse the Xero loss entry";
  return `Card payment dispute closed (${outcome})`;
}
