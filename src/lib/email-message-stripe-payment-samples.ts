/**
 * The registry's preview samples for the tokens of the Stripe payment alerts:
 * a late capture refunded outside the app (#2761), an unrecognised or
 * unmatched Stripe payment (#4532, #4624) and a dispute (#4911). Moved out of
 * `sampleValue` in `email-message-registry.ts` (#5433), which is past its size
 * ceiling; that function asks here first for these tokens. Each sample is the
 * sender's own wording, from the leaf modules the senders read.
 */
import { LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE } from "@/lib/late-capture-outside-app-note";
import { STRIPE_DISPUTE_HOLD_NOTE, STRIPE_DISPUTE_NEXT_STEP, stripeDisputeSubjectLabel } from "@/lib/stripe-dispute-note";
import {
  UNMATCHED_APP_LEDGER_MATCH_LABEL,
  UNMATCHED_APP_STRIPE_PAYMENT_NOTE,
  UNRECOGNISED_STRIPE_PAYMENT_NOTE,
} from "@/lib/unrecognised-stripe-payment-note";

/** The sample for one of these tokens, or undefined for any other token. */
export function stripePaymentAlertSampleValue(token: string): string | undefined {
  if (token === "outsideAppRefundNote") return LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE;
  // #4532: the one passage, and the Stripe ids an unrecognised payment names.
  if (token === "unrecognisedPaymentNote") return UNRECOGNISED_STRIPE_PAYMENT_NOTE;
  // #4624: the unmatched app payment's instruction, and what the app found for it.
  if (token === "unmatchedAppPaymentNote") return UNMATCHED_APP_STRIPE_PAYMENT_NOTE;
  if (token === "ledgerMatch") return UNMATCHED_APP_LEDGER_MATCH_LABEL.APP_INTENT_NO_TRANSACTION;
  if (token === "chargeId") return "ch_example";
  // #4911: previewed as the opened alert, the one every dispute sends first.
  if (token === "disputeSubjectLabel") return stripeDisputeSubjectLabel("opened", "open");
  if (token === "disputeNextStep") return STRIPE_DISPUTE_NEXT_STEP.OPEN;
  if (token === "disputeHoldNote") return STRIPE_DISPUTE_HOLD_NOTE;
  if (token === "outcome") return "open";
  if (token === "disputeId") return "dp_example";
  if (token === "bookingOwner") return "Sam Member";
  if (token === "checkoutSessionId") return "cs_example";
  if (token === "paymentLinkId") return "plink_example";
  if (token === "stripeDashboardUrl") return "https://dashboard.stripe.com/payments/pi_example";
  return undefined;
}
