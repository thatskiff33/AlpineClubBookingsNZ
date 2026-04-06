"use client";

import { useState } from "react";
import {
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";

interface PaymentFormProps {
  bookingId: string;
  amountCents: number;
  onSuccess: (paymentIntentId: string) => void;
  onError: (error: string) => void;
  returnUrl: string;
}

/**
 * Payment form using Stripe Elements PaymentElement.
 * Used for immediate payment on confirmed bookings.
 */
export default function PaymentForm({
  bookingId,
  amountCents,
  onSuccess,
  onError,
  returnUrl,
}: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaid, setIsPaid] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
      <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
        <p className="font-medium">Payment successful!</p>
        <p className="mt-1">Your payment of ${(amountCents / 100).toFixed(2)} NZD has been processed.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
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

      <div className="flex items-center justify-between">
        <p className="text-lg font-semibold">
          Total: ${(amountCents / 100).toFixed(2)} NZD
        </p>
        <button
          type="submit"
          disabled={!stripe || isProcessing}
          className="rounded-md bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isProcessing ? "Processing..." : "Pay Now"}
        </button>
      </div>
    </form>
  );
}
