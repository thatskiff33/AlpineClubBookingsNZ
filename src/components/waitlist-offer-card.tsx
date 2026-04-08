"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface WaitlistOfferCardProps {
  bookingId: string;
  expiresAt: string;
  finalPriceCents: number;
}

export function WaitlistOfferCard({ bookingId, expiresAt, finalPriceCents }: WaitlistOfferCardProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    function updateCountdown() {
      const now = Date.now();
      const expires = new Date(expiresAt).getTime();
      const diff = expires - now;

      if (diff <= 0) {
        setTimeLeft("Expired");
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setTimeLeft(`${hours}h ${minutes}m remaining`);
    }

    updateCountdown();
    const interval = setInterval(updateCountdown, 60000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  async function handleConfirm() {
    setConfirming(true);
    setError("");

    const res = await fetch(`/api/bookings/${bookingId}/waitlist-confirm`, {
      method: "POST",
    });

    const data = await res.json();

    if (res.ok && data.success) {
      // Refresh the page to show the new status (CONFIRMED/PENDING/PAID)
      router.refresh();
    } else {
      setError(data.error || "Failed to confirm booking");
      setConfirming(false);
    }
  }

  const isExpired = timeLeft === "Expired";

  return (
    <Card className="border-teal-200 bg-teal-50">
      <CardHeader>
        <CardTitle className="text-teal-900">A Spot Has Opened Up!</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-teal-800">
          A spot has become available for your waitlisted booking. Confirm now to secure your place.
        </p>

        <div className="flex items-center gap-2 text-sm font-medium text-teal-700">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          {isExpired ? (
            <span className="text-red-600">This offer has expired</span>
          ) : (
            <span>{timeLeft}</span>
          )}
        </div>

        {finalPriceCents > 0 && (
          <p className="text-sm text-teal-700">
            You will be prompted to complete payment after confirming.
          </p>
        )}

        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        <div className="flex gap-3">
          <Button
            onClick={handleConfirm}
            disabled={confirming || isExpired}
            className="bg-teal-600 hover:bg-teal-700"
          >
            {confirming ? "Confirming..." : "Confirm Booking"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
