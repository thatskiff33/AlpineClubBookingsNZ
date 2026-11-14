"use client";

import { useId, useState } from "react";
import {
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { formatCents } from "@/lib/utils";
import { useClubFormat } from "@/components/club-format-provider";
import { FocusedActionError } from "@/components/focused-action-error";
import { StatusRegion } from "@/components/status-region";

interface PaymentFormProps {
  bookingId?: string;
  amountCents: number;
  // #1976 — the amount the card is actually charged today, as returned by the
  // server payment-intent route (never client arithmetic). Falls back to
  // amountCents when the server figure is unavailable. For a split booking this
  // is the member portion only.
  chargedAmountCents?: number | null;
  // #1976 — the server's authoritative split verdict for this booking's payment
  // intent (`isSplit` from the payment-intent route). When provided it drives the
  // display; direct PaymentForm consumers that don't pass it (pay/[token],
  // additional-payment-card, organiser-group-booking-card) fall back to deriving
  // the split from the deferred amount below.
  isSplit?: boolean | null;
  // #1976 — for a split parent (#738), the deferred non-member guest portion in
  // cents (the child's server-priced total), charged closer to the stay rather
  // than today. Null/absent for a non-split booking, which keeps the exact
  // original single-total display.
  deferredGuestAmountCents?: number | null;
  onSuccess: (paymentIntentId: string) => void;
  // #4955 — called when the confirmation resolves `processing` (the payment is
  // submitted but not yet settled). Optional: a caller that omits it keeps the
  // form's old behaviour of returning to idle.
  onProcessing?: (paymentIntentId: string) => void;
  returnUrl: string;
}

/**
 * Payment form using Stripe Elements PaymentElement.
 * Used for immediate payment on confirmed bookings. A declined or failed card
 * is shown and announced here, in the form's own recovery alert (#4949), so it
 * is deliberately not handed to the caller to render a second time.
 */
export default function PaymentForm({
  bookingId,
  amountCents,
  chargedAmountCents,
  isSplit,
  deferredGuestAmountCents,
  onSuccess,
  onProcessing,
  returnUrl,
}: PaymentFormProps) {
  const format = useClubFormat();
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaid, setIsPaid] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // #4949: several payment forms can share a page, so the decline alert's id
  // carries the booking, or a per-instance id where there is none.
  const instanceId = useId();
  const errorId = `payment-form-${bookingId ?? instanceId}-error`;
  // #4943: the intent amount is authoritative for every booking, including
  // saved credit and server repricing. Split metadata controls only the label
  // and deferred-guest line; other consumers retain the amountCents fallback.
  const derivedSplit =
    deferredGuestAmountCents != null && deferredGuestAmountCents > 0;
  const splitRequested = typeof isSplit === "boolean" ? isSplit : derivedSplit;
  const isSplitDisplay =
    splitRequested &&
    chargedAmountCents != null &&
    deferredGuestAmountCents != null;
  const chargedToday =
    typeof chargedAmountCents === "number"
      ? chargedAmountCents
      : amountCents;
  const formattedAmount = formatCents(chargedToday, format);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: returnUrl,
      },
      redirect: "if_required",
    });

    if (error) {
      setErrorMessage(error.message ?? "An unexpected error occurred.");
      setIsProcessing(false);
    } else if (paymentIntent && paymentIntent.status === "succeeded") {
      setIsPaid(true);
      setIsProcessing(false);
      onSuccess(paymentIntent.id);
    } else if (paymentIntent && paymentIntent.status === "processing" && onProcessing) {
      setIsProcessing(false);
      onProcessing(paymentIntent.id);
    } else {
      // Payment requires additional action (3D Secure, etc.)
      // The redirect will handle this
      setIsProcessing(false);
    }
  };

  // #4949: the status region is mounted with the form, so the success that
  // replaces the form is announced rather than inserted already filled, and it
  // takes the focus the form's Pay Now button held.
  return (
    <>
      <StatusRegion
        visible={isPaid}
        visibleClassName="rounded-md bg-success-3 p-4 text-sm text-success-11"
        outcomeKey={isPaid}
      >
        {isPaid ? (
          <>
            <p className="font-medium">Payment successful!</p>
            <p className="mt-1">Your payment of {formattedAmount} has been processed.</p>
          </>
        ) : null}
      </StatusRegion>
      {isPaid ? null : (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-lg border border-border p-4">
            <PaymentElement
              options={{
                layout: "tabs",
              }}
            />
          </div>

          <FocusedActionError id={errorId} error={errorMessage ?? ""} />

          <div className="flex items-center justify-between">
            <p className="text-lg font-semibold">
              {isSplitDisplay ? "Charged today: " : "Total: "}
              {formattedAmount}
            </p>
            <button
              type="submit"
              disabled={!stripe || isProcessing}
              className="rounded-md bg-brand-gold px-6 py-2.5 text-sm font-semibold text-brand-charcoal shadow-sm hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isProcessing ? "Processing..." : "Pay Now"}
            </button>
          </div>
          {isSplitDisplay && (
            <p className="text-sm text-muted-foreground">
              This covers the member places on your booking. Your non-member
              guests&apos; places (about {formatCents(deferredGuestAmountCents!, format)})
              are charged closer to your stay, not today.
            </p>
          )}
        </form>
      )}
    </>
  );
}
