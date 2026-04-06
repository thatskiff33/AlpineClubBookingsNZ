"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function CancelBookingButton({ bookingId }: { bookingId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleCancel() {
    setLoading(true);
    const res = await fetch(`/api/bookings/${bookingId}/cancel`, {
      method: "POST",
    });
    if (res.ok) {
      router.refresh();
    } else {
      alert("Failed to cancel booking");
    }
    setLoading(false);
    setConfirming(false);
  }

  if (!confirming) {
    return (
      <Button variant="destructive" onClick={() => setConfirming(true)}>
        Cancel Booking
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-md bg-red-50 p-4">
      <p className="text-sm text-red-700">Are you sure you want to cancel this booking?</p>
      <Button variant="destructive" size="sm" onClick={handleCancel} disabled={loading}>
        {loading ? "Cancelling..." : "Yes, Cancel"}
      </Button>
      <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
        No, Keep
      </Button>
    </div>
  );
}
