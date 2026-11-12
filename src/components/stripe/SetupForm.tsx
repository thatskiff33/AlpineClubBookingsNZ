"use client";

import { useId, useState } from "react";
import {
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { FocusedActionError } from "@/components/focused-action-error";

interface SetupFormProps {
  onSuccess: (setupIntentId: string) => void;
  onError: (error: string) => void;
  returnUrl: string;
}

/**
 * Card setup form using Stripe Elements PaymentElement.
 * Used for pending bookings with non-member guests to save card details
 * without charging immediately.
 */
export default function SetupForm({
  onSuccess,
  onError,
  returnUrl,
}: SetupFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorId = `setup-form-${useId()}-error`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: returnUrl,
      },
      redirect: "if_required",
    });

    if (error) {
      setErrorMessage(error.message ?? "An unexpected error occurred.");
      onError(error.message ?? "Card setup failed");
      setIsProcessing(false);
    } else if (setupIntent && setupIntent.status === "succeeded") {
      onSuccess(setupIntent.id);
      setIsProcessing(false);
    } else {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-lg border border-warning-6 bg-warning-3 p-4 text-sm text-warning-11">
        <p className="font-medium">Card will not be charged now</p>
        <p className="mt-1">
          Your card details will be saved securely. Payment will only be
          processed closer to check-in if your booking is confirmed.
          If your booking is bumped by a member, no charge will be made.
        </p>
      </div>

      <div className="rounded-lg border border-border p-4">
        <PaymentElement
          options={{
            layout: "tabs",
          }}
        />
      </div>

      <FocusedActionError id={errorId} error={errorMessage ?? ""} />

      <button
        type="submit"
        disabled={!stripe || isProcessing}
        className="w-full rounded-md bg-brand-gold px-6 py-2.5 text-sm font-semibold text-brand-charcoal shadow-sm hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isProcessing ? "Saving card..." : "Save Card & Confirm Booking"}
      </button>
    </form>
  );
}
