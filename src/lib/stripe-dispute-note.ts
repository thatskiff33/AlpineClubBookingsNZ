/**
 * #4911 (`INV-PAY-154`): what the treasurer does about a Stripe dispute, per
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
  "While the dispute is open or lost, the app issues no card refund and no account credit for this payment: a cancellation is recorded and handed to the treasurer instead. " +
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
 * The subject phrase (`{{disputeSubjectLabel}}`): which of the dispute's two
 * alerts this is, and once closed, how it ended. One template carries both, so
 * a subject typed in by hand would title a closed dispute as a new one.
 */
export function stripeDisputeSubjectLabel(stage: "opened" | "closed", outcome: string): string {
  return stage === "opened"
    ? "Card payment disputed by the cardholder - respond in Stripe"
    : `Card payment dispute closed (${outcome})`;
}
