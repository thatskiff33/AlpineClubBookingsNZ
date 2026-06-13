"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useClubIdentity } from "@/components/club-identity-provider";
import { formatNZDate } from "@/lib/nzst-date";

type VerifyOutcome = "verified" | "already_verified" | "expired" | "invalid" | "loading" | "error";

interface VerifyResult {
  outcome: VerifyOutcome;
  checkIn?: string;
  checkOut?: string;
  guestCount?: number;
}

export default function BookingRequestVerifyPage() {
  const club = useClubIdentity();
  const { token } = useParams<{ token: string }>();
  const [result, setResult] = useState<VerifyResult>({ outcome: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/booking-requests/verify/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 404) {
          setResult({ outcome: "invalid" });
        } else if (res.status === 410) {
          setResult({ outcome: "expired" });
        } else if (res.ok) {
          setResult(data);
        } else {
          setResult({ outcome: "error" });
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ outcome: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Booking Request Confirmation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {result.outcome === "loading" ? (
          <p className="text-sm text-muted-foreground">Confirming your email address...</p>
        ) : result.outcome === "verified" || result.outcome === "already_verified" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="h-6 w-6 shrink-0" />
              <p className="font-medium">Your email address is confirmed.</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Thanks for your booking request with {club.lodgeName}. It has been added to our
              review queue and an officer will be in touch with pricing and a payment link.
            </p>
            {result.checkIn && result.checkOut ? (
              <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-700">
                <p>
                  Dates: {formatNZDate(new Date(result.checkIn))} to{" "}
                  {formatNZDate(new Date(result.checkOut))}
                </p>
                {typeof result.guestCount === "number" ? (
                  <p className="mt-1">Guests: {result.guestCount}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : result.outcome === "expired" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-amber-700">
              <Clock className="h-6 w-6 shrink-0" />
              <p className="font-medium">This confirmation link has expired.</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Confirmation links are valid for 48 hours. Please submit a new booking request and
              confirm it from the email we send you.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-6 w-6 shrink-0" />
              <p className="font-medium">This confirmation link is not valid.</p>
            </div>
            <p className="text-sm text-muted-foreground">
              If you submitted a booking request, please check your email for the most recent
              confirmation link, or contact the club for help.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
