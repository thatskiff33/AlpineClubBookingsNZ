import type { StripeDisputeStatus } from "@prisma/client";

import { STRIPE_DISPUTE_STATUS_LABEL, disputeHoldsCapture } from "@/lib/stripe-dispute-note";

/**
 * #4911 (`INV-PAY-151`): the booking page's officer-only line that the booking's
 * card payment is disputed by the cardholder, and how each dispute stands, read
 * from the `StripeDispute` record. While one is open or lost the app issues no
 * card refund or account credit for the payment; the line says so, so the
 * booking officer does not read a paid booking as paid.
 */
export function BookingStripeDisputeNotice({
  disputes,
}: {
  disputes: ReadonlyArray<{ stripeDisputeId: string; status: StripeDisputeStatus }>;
}) {
  const holding = disputes.some((dispute) => disputeHoldsCapture(dispute.status));
  return (
    <div
      role="status"
      data-testid="booking-stripe-dispute-notice"
      className={`mb-4 rounded-md border p-4 text-sm ${holding ? "border-warning-6 bg-warning-3" : "border-border bg-muted"}`}
    >
      <ul className="space-y-1">
        {disputes.map((dispute) => (
          <li key={dispute.stripeDisputeId} className="font-medium">
            {`Disputed by cardholder - ${STRIPE_DISPUTE_STATUS_LABEL[dispute.status]} (Stripe dispute ${dispute.stripeDisputeId})`}
          </li>
        ))}
      </ul>
      {holding && (
        <p className="mt-1 text-muted-foreground">
          No card refund or account credit is issued for this payment while a dispute is open or lost; a cancellation is handed to the treasurer.
        </p>
      )}
    </div>
  );
}
