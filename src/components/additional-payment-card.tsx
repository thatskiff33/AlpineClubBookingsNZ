"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import StripeProvider from "@/components/stripe/StripeProvider";
import PaymentForm from "@/components/stripe/PaymentForm";

interface AdditionalPaymentCardProps {
  bookingId: string;
  additionalAmountCents: number;
}

/**
 * Shown on the booking detail page when a modification increased the price
 * and the additional payment has not yet been collected.
 */
export function AdditionalPaymentCard({
  bookingId,
  additionalAmountCents,
}: AdditionalPaymentCardProps) {
  const router = useRouter();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paymentComplete, setPaymentComplete] = useState(false);

  useEffect(() => {
    async function fetchSecret() {
      try {
        const res = await fetch(
          `/api/bookings/${bookingId}/additional-payment-secret`
        );
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to load payment details");
          return;
        }
        setClientSecret(data.clientSecret);
      } catch {
        setError("Failed to load payment details");
      } finally {
        setLoading(false);
      }
    }
    fetchSecret();
  }, [bookingId]);

  async function handlePaymentSuccess(paymentIntentId: string) {
    try {
      await fetch(`/api/bookings/${bookingId}/confirm-modification-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId }),
      });
    } catch {
      // Non-fatal: webhook will also confirm
    }
    setPaymentComplete(true);
    setTimeout(() => router.refresh(), 1500);
  }

  const returnUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/bookings/${bookingId}`
      : `/bookings/${bookingId}`;

  return (
    <Card className="border-amber-300 bg-amber-50">
      <CardHeader>
        <CardTitle className="text-amber-800">
          Additional Payment Required
        </CardTitle>
      </CardHeader>
      <CardContent>
        {paymentComplete ? (
          <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
            <p className="font-medium">Payment successful!</p>
            <p className="mt-1">Your additional payment has been processed.</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-amber-700 mb-4">
              A recent booking modification increased your total by{" "}
              <strong>{formatCents(additionalAmountCents)}</strong>. Please
              complete payment to finalise the modification.
            </p>

            {loading && (
              <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-amber-600 border-t-transparent" />
                Loading payment details...
              </div>
            )}

            {error && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {clientSecret && (
              <StripeProvider clientSecret={clientSecret}>
                <PaymentForm
                  bookingId={bookingId}
                  amountCents={additionalAmountCents}
                  returnUrl={returnUrl}
                  onSuccess={handlePaymentSuccess}
                  onError={(err) => setError(err)}
                />
              </StripeProvider>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
