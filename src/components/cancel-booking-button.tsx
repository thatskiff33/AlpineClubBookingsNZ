"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface CancelPreview {
  refundAmountCents: number;
  keptAmountCents: number;
  changeFeeCents: number;
  refundPercentage: number;
  totalPaidCents: number;
  hasPayment: boolean;
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function CancelBookingButton({ bookingId }: { bookingId: string }) {
  const [step, setStep] = useState<"idle" | "loading" | "preview" | "cancelling" | "success" | "error">("idle");
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [result, setResult] = useState<{ refundAmountCents: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const router = useRouter();

  async function handleShowPreview() {
    setStep("loading");
    try {
      const res = await fetch(`/api/bookings/${bookingId}/cancel-preview`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || "Failed to load cancellation details");
        setStep("error");
        return;
      }
      const data: CancelPreview = await res.json();
      setPreview(data);
      setStep("preview");
    } catch {
      setErrorMsg("Failed to load cancellation details");
      setStep("error");
    }
  }

  async function handleConfirmCancel() {
    setStep("cancelling");
    try {
      const res = await fetch(`/api/bookings/${bookingId}/cancel`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setResult({ refundAmountCents: data.refundAmountCents || 0 });
        setStep("success");
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || "Failed to cancel booking");
        setStep("error");
      }
    } catch {
      setErrorMsg("Failed to cancel booking");
      setStep("error");
    }
  }

  if (step === "idle") {
    return (
      <Button variant="destructive" onClick={handleShowPreview}>
        Cancel Booking
      </Button>
    );
  }

  if (step === "loading") {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm text-slate-500">Loading cancellation details...</p>
      </div>
    );
  }

  if (step === "success") {
    const refund = result?.refundAmountCents || 0;
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-4 space-y-1">
        <p className="text-sm font-medium text-green-800">Booking cancelled successfully</p>
        {refund > 0 ? (
          <p className="text-sm text-green-700">
            Your refund of {formatDollars(refund)} has been processed to your original payment method. You will receive a confirmation email shortly.
          </p>
        ) : (
          <p className="text-sm text-green-700">
            You will receive a confirmation email shortly.
          </p>
        )}
      </div>
    );
  }

  if (step === "error") {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-2">
        <p className="text-sm text-red-700">{errorMsg}</p>
        <Button variant="outline" size="sm" onClick={() => setStep("idle")}>
          Try Again
        </Button>
      </div>
    );
  }

  // Preview step
  if (step === "preview" && preview) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 space-y-3">
        <p className="text-sm font-medium text-red-800">Cancellation Summary</p>

        {!preview.hasPayment ? (
          <p className="text-sm text-slate-700">
            No payment has been taken for this booking. No refund applies.
          </p>
        ) : preview.refundAmountCents === 0 ? (
          <p className="text-sm text-slate-700">
            No refund applies per cancellation policy.
          </p>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-600">Refund to original payment method:</span>
              <span className="font-medium text-green-700">{formatDollars(preview.refundAmountCents)}</span>
            </div>
            {preview.keptAmountCents > 0 && (
              <div className="flex justify-between">
                <span className="text-slate-600">
                  Amount kept (cancellation policy {preview.refundPercentage}% refund):
                </span>
                <span className="font-medium text-slate-700">{formatDollars(preview.keptAmountCents)}</span>
              </div>
            )}
            {preview.changeFeeCents > 0 && (
              <div className="flex justify-between">
                <span className="text-slate-600">Change fees (non-refundable):</span>
                <span className="font-medium text-slate-700">{formatDollars(preview.changeFeeCents)}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleConfirmCancel}
          >
            Confirm Cancellation
          </Button>
          <Button variant="outline" size="sm" onClick={() => setStep("idle")}>
            Keep Booking
          </Button>
        </div>
      </div>
    );
  }

  // Cancelling state
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm text-slate-500">Cancelling booking...</p>
    </div>
  );
}
