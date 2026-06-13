"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import StripeProvider from "@/components/stripe/StripeProvider";
import PaymentForm from "@/components/stripe/PaymentForm";
import { useClubIdentity } from "@/components/club-identity-provider";
import { formatNZDate } from "@/lib/nzst-date";
import { formatCents } from "@/lib/utils";

interface PaymentLinkContext {
  state: "payable" | "paid";
  booking: {
    checkIn: string;
    checkOut: string;
    guestCount: number;
    status: string;
  };
  firstName: string;
  amountCents: number;
  internetBankingReference: string;
  expiresAt: string;
}

export default function PayByLinkPage() {
  const club = useClubIdentity();
  const { token } = useParams<{ token: string }>();
  const [context, setContext] = useState<PaymentLinkContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [intentLoading, setIntentLoading] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/pay/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data.error || "This payment link is not valid.");
        } else {
          setContext(data);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError("Unable to load this payment link right now.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function startCardPayment() {
    setIntentLoading(true);
    setIntentError(null);
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token)}/payment-intent`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to start payment");
      }
      if (data.alreadyPaid) {
        setPaymentComplete(true);
        return;
      }
      setClientSecret(data.clientSecret);
    } catch (err) {
      setIntentError(err instanceof Error ? err.message : "Unable to start payment");
    } finally {
      setIntentLoading(false);
    }
  }

  if (loading) {
    return (
      <Card className="w-full max-w-lg">
        <CardContent className="py-8 text-center text-muted-foreground">Loading...</CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Payment Link</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-amber-700">
            <AlertTriangle className="h-6 w-6 shrink-0" />
            <p className="font-medium">{loadError}</p>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            If you believe this is a mistake, please contact the club for help.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!context) return null;

  if (context.state === "paid" || paymentComplete) {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Payment Received</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-6 w-6 shrink-0" />
            <p className="font-medium">Thanks, {context.firstName} — your payment is complete.</p>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Your booking with {club.lodgeName} is confirmed. We look forward to seeing you.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Complete Your Payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-700">
          <p>
            Dates: {formatNZDate(new Date(context.booking.checkIn))} to{" "}
            {formatNZDate(new Date(context.booking.checkOut))}
          </p>
          <p className="mt-1">Guests: {context.booking.guestCount}</p>
          <p className="mt-1 font-semibold text-slate-900">
            Amount due: {formatCents(context.amountCents)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            This payment link expires on {formatNZDate(new Date(context.expiresAt))}.
          </p>
        </div>

        {clientSecret ? (
          <StripeProvider clientSecret={clientSecret}>
            <PaymentForm
              amountCents={context.amountCents}
              returnUrl={typeof window !== "undefined" ? window.location.href : ""}
              onSuccess={() => setPaymentComplete(true)}
              onError={() => undefined}
            />
          </StripeProvider>
        ) : (
          <div className="space-y-3">
            <Button onClick={startCardPayment} disabled={intentLoading}>
              {intentLoading ? "Preparing..." : "Pay by card"}
            </Button>
            {intentError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {intentError}
              </div>
            ) : null}

            <div className="rounded-md border border-slate-200 p-3 text-sm">
              <p className="font-medium text-slate-900">Or pay by internet banking</p>
              <p className="mt-1 text-muted-foreground">
                Use the reference below when making a direct transfer.
              </p>
              <p className="mt-2 font-mono text-slate-900">{context.internetBankingReference}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
