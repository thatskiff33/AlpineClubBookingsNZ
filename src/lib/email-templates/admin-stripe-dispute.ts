/**
 * #4911 (`INV-PAY-154`): the admin alert for a cardholder's dispute
 * (chargeback) on a Stripe payment - once when Stripe opens it and once when it
 * closes. The app posts nothing to Xero for a dispute, so this mail is what
 * tells the treasurer to respond in Stripe and, when it is lost, to record the
 * loss by hand.
 *
 * Part of the finance/money-event family (`src/lib/email/admin-alerts-stripe-dispute.ts`).
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout, paragraph } from "./layout";
import { STRIPE_DISPUTE_HOLD_NOTE } from "@/lib/stripe-dispute-note";

/** What the alert names, already rendered: amounts in the dispute's own currency, times in the club's. */
export type StripeDisputeAlertFields = {
  /** "opened" or "closed": which of the dispute's two alerts this is. */
  stage: "opened" | "closed";
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

export function adminStripeDisputeTemplate(data: StripeDisputeAlertFields): string {
  const opened = data.stage === "opened";
  return layout(`
    ${heading(opened ? "Card Payment Disputed by the Cardholder" : "Card Payment Dispute Closed")}
    ${alertBox(
      opened
        ? "A cardholder has disputed a card payment with their bank. Stripe holds the disputed amount until the dispute is decided."
        : `A cardholder's dispute of a card payment has closed: ${escapeHtml(data.outcome)}.`,
      opened || data.outcome === "lost" ? "warning" : "info",
    )}
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
