"use client";

import { useState } from "react";

interface CancelBookingButtonProps {
  bookingId: string;
  onCancelled: (result: {
    refundAmountCents: number;
    refundPercentage: number;
    message: string;
  }) => void;
}

/**
 * Button component that handles booking cancellation with confirmation dialog.
 */
export default function CancelBookingButton({
  bookingId,
  onCancelled,
}: CancelBookingButtonProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCancel = async () => {
    setIsProcessing(true);
    setError(null);

    try {
      const response = await fetch(`/api/bookings/${bookingId}/cancel`, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to cancel booking");
        setIsProcessing(false);
        return;
      }

      onCancelled({
        refundAmountCents: data.refundAmountCents,
        refundPercentage: data.refundPercentage,
        message: data.message,
      });
    } catch {
      setError("Failed to connect to server");
    } finally {
      setIsProcessing(false);
      setIsConfirming(false);
    }
  };

  if (!isConfirming) {
    return (
      <button
        onClick={() => setIsConfirming(true)}
        className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500"
      >
        Cancel Booking
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-medium text-red-800">
        Are you sure you want to cancel this booking? Refund amount depends on
        the cancellation policy.
      </p>

      {error && (
        <p className="text-sm text-red-700">{error}</p>
      )}

      <div className="flex gap-3">
        <button
          onClick={handleCancel}
          disabled={isProcessing}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500 disabled:opacity-50"
        >
          {isProcessing ? "Cancelling..." : "Yes, Cancel"}
        </button>
        <button
          onClick={() => {
            setIsConfirming(false);
            setError(null);
          }}
          disabled={isProcessing}
          className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm ring-1 ring-gray-300 hover:bg-gray-50"
        >
          Keep Booking
        </button>
      </div>
    </div>
  );
}
