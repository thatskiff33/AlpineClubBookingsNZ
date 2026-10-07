"use client";

import { useState } from "react";
import {
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { formatCents } from "@/lib/utils";
import { useClubFormat } from "@/components/club-format-provider";

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
  onError: (error: string) => void;
  returnUrl: string;
}

/**
 * Payment form using Stripe Elements PaymentElement.
 * Used for immediate payment on confirmed bookings.
 */
export default function PaymentForm({
  amountCents,
  chargedAmountCents,
  isSplit,
  deferredGuestAmountCents,
  onSuccess,
  onError,
  returnUrl,
}: PaymentFormProps) {
  const format = useClubFormat();
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaid, setIsPaid] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // #1976 — a split booking charges only the member portion today; show that
  // server figure. A non-split booking has no deferred portion, so it keeps the
  // exact original "Total: {amountCents}" display, byte-for-byte.
  //
  // The server's `isSplit` verdict wins when the route provides it; direct
  // PaymentForm consumers that don't pass it fall back to deriving the split
  // from the deferred amount. Either way the split DISPLAY additionally requires
  // both the server charge figure (the "Charged today" headline) and the
  // deferred guest portion (the secondary line) — a degenerate response
  // (isSplit=true but a missing amount) falls back to the exact non-split
  // "Total" display rather than render an undefined amount.
  const derivedSplit =
    deferredGuestAmountCents != null && deferredGuestAmountCents > 0;
  const splitRequested = typeof isSplit === "boolean" ? isSplit : derivedSplit;
  const isSplitDisplay =
    splitRequested &&
    chargedAmountCents != null &&
    deferredGuestAmountCents != null;
  const chargedToday =
    isSplitDisplay && chargedAmountCents != null
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
      onError(error.message ?? "Payment failed");
      setIsProcessing(false);
    } else if (paymentIntent && paymentIntent.status === "succeeded") {
      setIsPaid(true);
      setIsProcessing(false);
      onSuccess(paymentIntent.id);
    } else {
      // Payment requires additional action (3D Secure, etc.)
      // The redirect will handle this
      setIsProcessing(false);
    }
  };

  if (isPaid) {
    return (
      <div className="rounded-md bg-success-3 p-4 text-sm text-success-11">
        <p className="font-medium">Payment successful!</p>
        <p className="mt-1">Your payment of {formattedAmount} has been processed.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-lg border border-border p-4">
        <PaymentElement
          options={{
            layout: "tabs",
          }}
        />
      </div>

      {errorMessage && (
        <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
          {errorMessage}
        </div>
      )}

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
  );
}
