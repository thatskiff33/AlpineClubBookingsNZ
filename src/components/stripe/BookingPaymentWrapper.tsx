"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { type BookingPaymentMode } from "@/lib/booking-payment-flow";
import StripeProvider from "./StripeProvider";
import PaymentForm from "./PaymentForm";
import SetupForm from "./SetupForm";

interface BookingPaymentWrapperProps {
  bookingId: string;
  amountCents: number;
  paymentMode: BookingPaymentMode;
  returnUrl: string;
  onPaymentComplete: () => void;
}

/**
 * Renders the Stripe flow for a persisted booking state.
 * Booking status is the source of truth for whether this page should charge now
 * or only save a payment method for later.
 */
export default function BookingPaymentWrapper({
  bookingId,
  amountCents,
  paymentMode,
  returnUrl,
  onPaymentComplete,
}: BookingPaymentWrapperProps) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const handleAlreadyComplete = useEffectEvent(() => onPaymentComplete());

  useEffect(() => {
    if (amountCents === 0) return; // No Stripe initialization needed for zero-dollar bookings

    const initializePayment = async () => {
      try {
        setLoading(true);
        setInitializationError(null);

        const endpoint = paymentMode === "setup"
          ? "/api/payments/create-setup-intent"
          : "/api/payments/create-payment-intent";

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId }),
        });

        const data = await response.json();

        if (!response.ok) {
          setInitializationError(data.error || "Failed to initialize payment");
          return;
        }

        if (data.alreadyPaid || data.alreadySaved) {
          handleAlreadyComplete();
          return;
        }

        setClientSecret(data.clientSecret);
      } catch {
        setInitializationError("Failed to connect to payment service");
      } finally {
        setLoading(false);
      }
    };

    initializePayment();
  }, [bookingId, paymentMode, amountCents]);

  // Zero-dollar booking: no payment is required
  if (amountCents === 0) {
    return (
      <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
        <p className="font-medium">Booking Complete</p>
        <p className="mt-1">No payment is required for this booking.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
        <span className="ml-3 text-gray-600">Preparing payment...</span>
      </div>
    );
  }

  if (initializationError) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        <p className="font-medium">Payment Error</p>
        <p className="mt-1">{initializationError}</p>
      </div>
    );
  }

  if (!clientSecret) {
    return (
      <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-700">
        Unable to initialize payment. Please try again.
      </div>
    );
  }

  async function handlePaymentSuccess(paymentIntentId: string) {
    try {
      await fetch(`/api/bookings/${bookingId}/confirm-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId }),
      });
    } catch {
      // Non-fatal: the Stripe webhook will still reconcile the booking state.
    }

    onPaymentComplete();
  }

  return (
    <StripeProvider clientSecret={clientSecret}>
      {paymentMode === "payment" ? (
        <PaymentForm
          amountCents={amountCents}
          returnUrl={returnUrl}
          onSuccess={handlePaymentSuccess}
          onError={() => undefined}
        />
      ) : (
        <SetupForm
          returnUrl={returnUrl}
          onSuccess={() => onPaymentComplete()}
          onError={() => undefined}
        />
      )}
    </StripeProvider>
  );
}
