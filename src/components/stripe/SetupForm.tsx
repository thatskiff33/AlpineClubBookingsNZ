"use client";

import { useState } from "react";
import {
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";

interface SetupFormProps {
  bookingId: string;
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
  bookingId,
  onSuccess,
  onError,
  returnUrl,
}: SetupFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-medium">Card will not be charged now</p>
        <p className="mt-1">
          Your card details will be saved securely. Payment will only be
          processed 7 days before check-in if your booking is confirmed.
          If your booking is bumped by a member, no charge will be made.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 p-4">
        <PaymentElement
          options={{
            layout: "tabs",
          }}
        />
      </div>

      {errorMessage && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={!stripe || isProcessing}
        className="w-full rounded-md bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isProcessing ? "Saving card..." : "Save Card & Confirm Booking"}
      </button>
    </form>
  );
}
