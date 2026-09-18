"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import StripeProvider from "@/components/stripe/StripeProvider";
import PaymentForm from "@/components/stripe/PaymentForm";

interface AdditionalPaymentCardProps {
  bookingId: string;
  /**
   * The server's view of the outstanding ask, in cents.
   *
   * #3340 - THIS IS A REFRESH SIGNAL, NOT THE FIGURE THE MEMBER IS SHOWN. The
   * amount rendered and charged both come from the secret response below, so the
   * two cannot disagree. What this prop does is tell the effect that the server
   * now believes the ask has changed, which is what makes a second booking edit
   * re-fetch at all: the effect used to be keyed on `[bookingId]` alone, so after
   * a second edit the page re-rendered with a new displayed total while the
   * browser kept the FIRST edit's client secret - and confirmed it.
   */
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
  const [askAmountCents, setAskAmountCents] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paymentComplete, setPaymentComplete] = useState(false);

  useEffect(() => {
    let active = true;
    async function fetchSecret() {
      try {
        const res = await fetch(
          `/api/bookings/${bookingId}/additional-payment-secret`
        );
        const data = await res.json();
        if (!active) return;
        if (!res.ok) {
          // Clear the stale binding before reporting the failure: a card that
          // cannot refresh its secret must not go on offering the old one.
          setClientSecret(null);
          setAskAmountCents(null);
          setError(data.error || "Failed to load payment details");
          return;
        }
        setError(null);
        // Both from the SAME response, always set together (#3340).
        setClientSecret(data.clientSecret);
        setAskAmountCents(
          typeof data.amountCents === "number" ? data.amountCents : null
        );
      } catch {
        if (!active) return;
        setClientSecret(null);
        setAskAmountCents(null);
        setError("Failed to load payment details");
      } finally {
        if (active) setLoading(false);
      }
    }
    /*
      #3340 fix round: THE OLD BINDING DIES BEFORE THE NEW ONE IS ASKED FOR.

      `setLoading(true)` alone left `clientSecret` and `askAmountCents` holding
      the PREVIOUS edit's values, and the render gates below do not consult
      `loading` - so between a second edit's re-render and its response, the
      member saw the old amount above a mounted, interactive PaymentElement bound
      to the intent that edit had just cancelled. Bounded (the confirm fails, no
      money moves) but it is the exact state this change exists to remove, and
      the error path already cleared them.
    */
    setLoading(true);
    setClientSecret(null);
    setAskAmountCents(null);
    fetchSecret();
    return () => {
      active = false;
    };
  }, [bookingId, additionalAmountCents]);

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
    <Card className="border-warning-6 bg-warning-3">
      <CardHeader>
        <CardTitle className="text-warning-11">
          Additional Payment Required
        </CardTitle>
      </CardHeader>
      <CardContent>
        {paymentComplete ? (
          <div className="rounded-md bg-success-3 p-4 text-sm text-success-11">
            <p className="font-medium">Payment successful!</p>
            <p className="mt-1">Your additional payment has been processed.</p>
          </div>
        ) : (
          <>
            {askAmountCents !== null ? (
              // #3340: the response's figure, never the server prop, so the
              // sentence a member reads names the amount of the very intent the
              // button below will confirm. Nothing is stated at all until the
              // response arrives - a placeholder from a second source is exactly
              // the disagreement this change exists to remove.
              <p className="text-sm text-warning-11 mb-4">
                A recent booking modification means{" "}
                <strong>{formatCents(askAmountCents)}</strong> is still owing on
                this booking. Please complete payment to finalise the
                modification.
              </p>
            ) : (
              error && (
                /*
                  #3340 fix round: THE EXPLANATION SURVIVES A FAILED FETCH.

                  The paragraph above is gated on the response's figure, so a 404
                  - "No pending additional payment", which is exactly the state a
                  failed mint leaves behind - showed a bare red error where the
                  sentence used to be, and a member had no idea what the card was
                  for. This one names the SERVER'S figure and says so, which is
                  safe precisely because there is no intent here to disagree with:
                  the form below renders only when a secret arrived.
                */
                <p className="text-sm text-warning-11 mb-4">
                  A recent booking modification means{" "}
                  <strong>{formatCents(additionalAmountCents)}</strong> is still
                  owing on this booking according to our records. We could not
                  load the payment form just now — please try again shortly, or
                  contact the club if it keeps happening.
                </p>
              )
            )}

            {loading && (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-warning-7 border-t-transparent" />
                Loading payment details...
              </div>
            )}

            {error && (
              <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
                {error}
              </div>
            )}

            {clientSecret && askAmountCents !== null && (
              <StripeProvider clientSecret={clientSecret}>
                <PaymentForm
                  amountCents={askAmountCents}
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
