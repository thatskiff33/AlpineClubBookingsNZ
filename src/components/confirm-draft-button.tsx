"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ConfirmDraftButtonProps {
  bookingId: string;
}

export function ConfirmDraftButton({ bookingId }: ConfirmDraftButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setConfirming(true);
    setError("");

    const res = await fetch(`/api/bookings/${bookingId}/confirm-draft`, {
      method: "POST",
    });

    if (res.ok) {
      router.refresh();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to confirm booking");
      setConfirming(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm Booking</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600">
          This is a saved draft with no charge. Click below to confirm your booking.
        </p>
        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}
        <Button onClick={handleConfirm} disabled={confirming}>
          {confirming ? "Confirming..." : "Confirm Booking"}
        </Button>
      </CardContent>
    </Card>
  );
}
