"use client";

import { useState, useEffect } from "react";
import StripeProvider from "./StripeProvider";
import PaymentForm from "./PaymentForm";
import SetupForm from "./SetupForm";

interface BookingPaymentWrapperProps {
  bookingId: string;
  amountCents: number;
  hasNonMembers: boolean;
  checkInDaysAway: number;
  returnUrl: string;
  onPaymentComplete: () => void;
}

/**
 * Determines whether to show PaymentForm (immediate charge) or SetupForm (save card)
 * based on booking type:
 * - All members OR check-in <= 7 days: PaymentIntent (charge immediately)
 * - Has non-members AND check-in > 7 days: SetupIntent (save card for later)
 */
export default function BookingPaymentWrapper({
  bookingId,
  amountCents,
  hasNonMembers,
  checkInDaysAway,
  returnUrl,
  onPaymentComplete,
}: BookingPaymentWrapperProps) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paymentType, setPaymentType] = useState<"payment" | "setup">(
    "payment"
  );

  // Determine payment type: immediate charge vs save card for later
  const needsSetupIntent = hasNonMembers && checkInDaysAway > 7;

  useEffect(() => {
    if (amountCents === 0) return; // No Stripe initialization needed for zero-dollar bookings

    const initializePayment = async () => {
      try {
        setLoading(true);
        setError(null);

        const endpoint = needsSetupIntent
          ? "/api/payments/create-setup-intent"
          : "/api/payments/create-payment-intent";

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId }),
        });

        const data = await response.json();

        if (!response.ok) {
          setError(data.error || "Failed to initialize payment");
          return;
        }

        setClientSecret(data.clientSecret);
        setPaymentType(needsSetupIntent ? "setup" : "payment");
      } catch {
        setError("Failed to connect to payment service");
      } finally {
        setLoading(false);
      }
    };

    initializePayment();
  }, [bookingId, needsSetupIntent, amountCents]);

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

  if (error) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        <p className="font-medium">Payment Error</p>
        <p className="mt-1">{error}</p>
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

  return (
    <StripeProvider clientSecret={clientSecret}>
      {paymentType === "payment" ? (
        <PaymentForm
          bookingId={bookingId}
          amountCents={amountCents}
          returnUrl={returnUrl}
          onSuccess={() => onPaymentComplete()}
          onError={(err) => setError(err)}
        />
      ) : (
        <SetupForm
          bookingId={bookingId}
          returnUrl={returnUrl}
          onSuccess={() => onPaymentComplete()}
          onError={(err) => setError(err)}
        />
      )}
    </StripeProvider>
  );
}
