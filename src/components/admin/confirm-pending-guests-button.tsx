"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ConfirmPendingGuestsButtonProps {
  bookingId: string;
  hasSavedPaymentMethod: boolean;
}

export function ConfirmPendingGuestsButton({
  bookingId,
  hasSavedPaymentMethod,
}: ConfirmPendingGuestsButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setConfirming(true);
    setError("");

    const res = await fetch(
      `/api/admin/bookings/${bookingId}/confirm-pending-guests`,
      { method: "POST" }
    );

    if (res.ok) {
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed to confirm pending guests");
      setConfirming(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm pending guests now</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600">
          This booking still has non-member guests on hold. Confirming now locks
          the guests in and clears the hold so the booking won&apos;t be bumped.
          {hasSavedPaymentMethod
            ? " The member's saved card will be charged the current total."
            : " There is no saved card, so the booking will move to payment-owed for payment to be arranged separately."}
        </p>
        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <Button onClick={handleConfirm} disabled={confirming}>
          {confirming ? "Confirming..." : "Confirm pending guests"}
        </Button>
      </CardContent>
    </Card>
  );
}
