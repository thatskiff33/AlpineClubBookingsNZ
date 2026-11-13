/**
 * #4911 (`INV-PAY-153`): the admin alert for a cardholder's dispute
 * (chargeback) on a Stripe payment - once when Stripe opens it and once when it
 * closes, plus once more when a dispute closed as lost is later reported won
 * (#5061 follow-up). The app posts nothing to Xero for a dispute, so this mail is what
 * tells the treasurer to respond in Stripe and, when it is lost, to record the
 * loss by hand.
 *
 * Part of the finance/money-event family (`src/lib/email/admin-alerts-stripe-dispute.ts`).
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout, paragraph } from "./layout";
import { STRIPE_DISPUTE_HOLD_NOTE, type StripeDisputeAlertStage } from "@/lib/stripe-dispute-note";

/** What the alert names, already rendered: amounts in the dispute's own currency, times in the club's. */
export type StripeDisputeAlertFields = {
  /** Which of the dispute's alerts this is. */
  stage: StripeDisputeAlertStage;
  /** The dispute's status as the alert reports it ("open", "won", "lost"...). */
  outcome: string;
  amount: string;
  reason: string;
  openedAt: string;
  bookingId: string;
  bookingOwner: string;
  disputeId: string;
  paymentIntentId: string;
  chargeId: string;
  /** `STRIPE_DISPUTE_NEXT_STEP` for the outcome. */
  disputeNextStep: string;
  stripeDashboardUrl: string;
};

const STAGE_COPY: Record<
  StripeDisputeAlertStage,
  (outcome: string) => { heading: string; summary: string; tone: "warning" | "info" }
> = {
  opened: () => ({
    heading: "Card Payment Disputed by the Cardholder",
    summary: "A cardholder has disputed a card payment with their bank. Stripe holds the disputed amount until the dispute is decided.",
    tone: "warning",
  }),
  closed: (outcome) => ({
    heading: "Card Payment Dispute Closed",
    summary: `A cardholder's dispute of a card payment has closed: ${escapeHtml(outcome)}.`,
    tone: outcome === "lost" ? "warning" : "info",
  }),
  // #5061 follow-up: a dispute already alerted as lost, reported won by a newer event.
  "won-after-loss": () => ({
    heading: "Lost Card Payment Dispute Now Won",
    summary: "A card payment dispute already reported lost is now reported won: Stripe has returned the disputed amount.",
    tone: "warning",
  }),
};

export function adminStripeDisputeTemplate(data: StripeDisputeAlertFields): string {
  const { heading: title, summary, tone } = STAGE_COPY[data.stage](data.outcome);
  return layout(`
    ${heading(title)}
    ${alertBox(summary, tone)}
    ${paragraph(escapeHtml(data.disputeNextStep))}
    ${paragraph(STRIPE_DISPUTE_HOLD_NOTE)}
    ${infoTable([
      { label: "Status", value: escapeHtml(data.outcome) },
      { label: "Amount", value: escapeHtml(data.amount) },
      { label: "Reason", value: escapeHtml(data.reason) },
      { label: "Opened", value: escapeHtml(data.openedAt) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Booked by", value: escapeHtml(data.bookingOwner) },
      { label: "Dispute", value: escapeHtml(data.disputeId) },
      { label: "Stripe payment", value: escapeHtml(data.paymentIntentId) },
      { label: "Charge", value: escapeHtml(data.chargeId) },
    ])}
    ${button("Open in Stripe", data.stripeDashboardUrl)}
  `);
}
